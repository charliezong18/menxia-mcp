// 奏折体例检查的纯核。吃一份 Snapshot 吐 findings，**无 IO**。
//
// 规则以 `~/.claude/skills/review-loop/folder-lint.sh` 的**实现**为准，不以 SKILL.md 为准
// （需求 R1；SPEC §5.1 查出过三处「文档说 A、代码做 B」）。
//
// 为什么吃「快照」而不是路径：规则一旦能读盘，「每条规则一个必失败用例」就要造 9 个
// git 仓。快照把 git 挡在一层之外，代价是多一个类型。
// 顺带：`snapshot.ts` 走 git 子进程采料，**不 import fs** —— guard.ts 焊死了。

import { stripCode } from './strip.js';

export type Severity = 'hard' | 'warn';

export interface Finding {
  /** 规则编号，与 design §2 的表一一对应 */
  rule: number;
  severity: Severity;
  /** 出问题的对象：slug / 文件路径 / 图片路径。归一化对账要比到这一层 */
  subject: string;
  message: string;
}

export interface Snapshot {
  /** 路径 → 内容。只装本折动过的文档 */
  files: Map<string, string>;
  /** 相对 origin/main 动过的 docs/*.md */
  changed: string[];
  /** 仓里真实存在的 assets/** 路径（相对 docs/） */
  assets: Set<string>;
  /** docs/.payload 或 .payload 的行 */
  payload: string[];
  /** changed 里已经在 main 上的 */
  onMain: Set<string>;
  base: { behind: number; fetchFailed: boolean };
  /** PR body。呈折时才有；巡检时可不传 */
  body?: string;
}

const EN_HEAD = (slug: string) => `**English** · [中文](${slug}.zh-CN.md)`;
const ZH_HEAD = (slug: string) => `[English](${slug}.md) · **中文**`;

/** 待发正文的中文版必须有的横幅。 */
const PAYLOAD_BANNER = '不要从本页复制';

/** PR body 五段。缺项**只警告**（需求 R6：SKILL.md 说「也拦」是文档错了）。 */
const BODY_SECTIONS = ['目的地', '直达链', 'TLDR', '待你拍板', '怎么用'];

/** 语言方向的 CJK 占比阈值。2026-07-28 Charlie 拍板 30%。 */
const CJK_RATIO = 0.3;

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;

/**
 * 剥掉代码跨度之后算 CJK 占比。分母是「有意义的字符」——
 * 空白、标点、数字、markdown 记号都不算，否则一篇短中文文档会因为标点多而掉到阈值下。
 */
export function cjkRatio(md: string): number {
  const prose = stripCode(md);
  const meaningful = prose.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (meaningful.length === 0) return 0;
  return (prose.match(CJK)?.length ?? 0) / meaningful.length;
}

/** 正文里引用的 assets 路径。**必须先剥代码跨度**（规则 4 的病历见 strip.ts）。 */
export function assetRefs(md: string): string[] {
  const prose = stripCode(md);
  const out = new Set<string>();
  // markdown 链接/图片语法
  for (const m of prose.matchAll(/\]\((assets\/[^)\s]+)\)/g)) out.add(m[1]!);
  // HTML <img src>（**刻意改进**：老脚本只认 markdown 语法，SPEC §5.2 记为改进 #4）
  for (const m of prose.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']?(assets\/[^"'\s>]+)/gi)) out.add(m[1]!);
  return [...out];
}

/** changed 列表 → slug 列表（剥掉 .md / .zh-CN.md 后去重）。 */
export function slugsOf(changed: string[]): string[] {
  return [...new Set(changed.map((f) => f.replace(/\.zh-CN\.md$/, '').replace(/\.md$/, '')))].sort();
}

const isPayload = (snap: Snapshot, en: string): boolean =>
  snap.payload.some((line) => line.trim() === en || line.trim() === en.replace(/^docs\//, ''));

export function lint(snap: Snapshot): Finding[] {
  const out: Finding[] = [];
  const push = (rule: number, severity: Severity, subject: string, message: string) =>
    out.push({ rule, severity, subject, message });

  // ── 规则 9：fetch 失败 ──
  // 放最前面：它决定下面所有「相对 origin/main」的结论可信不可信。
  // 老脚本是 `git fetch -q || true`，网络断了照样往下跑（需求 R5）。
  if (snap.base.fetchFailed) {
    push(9, 'warn', 'origin', 'git fetch 失败 —— 下面所有关于 main 的结论（基点、已在 main 上、双语对）可能建在陈旧数据上');
  }

  // ── 规则 6：分支基点 ──
  // 刻意不阻断：squash merge 只应用三点 diff，落后 main 本身无害；
  // 而阻断会把人逼向绕过闸门（pre-push 那次的教训）。
  if (snap.base.behind > 0) {
    push(6, 'warn', 'HEAD', `落后 main ${snap.base.behind} 个提交（不阻断）；但下面文档清单里若有不属于本折的，就是从别的分支切的`);
  }

  if (snap.changed.length === 0) {
    push(1, 'hard', '(none)', '相对 main 没有任何 docs/*.md 改动');
    return out;
  }

  // ── 规则 7：改动了 main 上已有的文档 ──
  for (const f of [...snap.onMain].sort()) {
    push(7, 'warn', f, `${f} 已在 main 上 —— 若不是本折要修订的，说明分支切错了地方`);
  }

  for (const slug of slugsOf(snap.changed)) {
    const en = `${slug}.md`;
    const zh = `${slug}.zh-CN.md`;
    const base = slug.split('/').pop()!;
    const hasEn = snap.files.has(en);
    const hasZh = snap.files.has(zh);

    // ── 规则 1：双语对齐全（按 slug **双向**查）──
    // 巡检那边只查 .md → .zh-CN.md 单向，于是「只有中文版」的折能过巡检、过不了闸门（需求 R7）。
    if (!hasEn || !hasZh) {
      push(1, 'hard', base, hasEn ? `${base} 缺中文版 ${zh}（.md 放英文，.zh-CN.md 放中文）` : `${base} 缺英文版 ${en}`);
      continue;
    }

    const enBody = snap.files.get(en)!;
    const zhBody = snap.files.get(zh)!;

    const payload = isPayload(snap, en);

    // ── 规则 3 / 2：互链头，含 .payload 例外 ──
    // .payload 登记的「待发正文」免英文版互链头（加了会把那行一起贴进对外 issue），
    // 代价是它在 zhupi 里切不了语言，由中文版的横幅兜底。**这条只存在于代码里，SKILL.md 从没写过。**
    if (payload) {
      if (!zhBody.includes(PAYLOAD_BANNER)) {
        push(3, 'hard', base, `${base} 中文版缺「勿从本页复制」横幅（待发正文的双语必须有）`);
      }
    } else if (firstLine(enBody) !== EN_HEAD(base)) {
      push(2, 'hard', base, `${base} 英文版首行互链头不对，应为：${EN_HEAD(base)}`);
    }
    if (firstLine(zhBody) !== ZH_HEAD(base)) {
      push(2, 'hard', base, `${base} 中文版首行互链头不对，应为：${ZH_HEAD(base)}`);
    }

    // ── 规则 5：语言方向按比例（**新增**，严重度=警告，D5 已定）──
    // 老脚本完全不查内容语言，整篇翻反了不拦。
    // 阈值 30% 没在真实语料上量过，误报方向是「拦住一篇没问题的文档」，
    // 而这个项目对「拦太死」的记载反应是绕过 —— 所以先当警告跑一两周。
    //
    // **`.payload` 的英文版跳过这条。** 疤痕清单在实现时抓到规则 5 与 `.payload` 例外相撞：
    // 「待发正文」的语言由**收件人**决定，不由文件名的语言约定决定 ——
    // 一封要发出去的中文邮件登记在 `<slug>.md` 里是完全正常的，
    // 而规则 5 会说「英文版里 CJK 占 100%」。中文版那一侧照查（它是给他读的译本）。
    const enRatio = cjkRatio(enBody);
    const zhRatio = cjkRatio(zhBody);
    if (!payload && enRatio > CJK_RATIO) {
      push(5, 'warn', en, `${en} 是英文版但中日韩字符占 ${pct(enRatio)}（阈值 ${pct(CJK_RATIO)}）—— 可能双语放反了或漏译`);
    }
    if (zhRatio < CJK_RATIO) {
      push(5, 'warn', zh, `${zh} 是中文版但中日韩字符只占 ${pct(zhRatio)}（阈值 ${pct(CJK_RATIO)}）—— 可能双语放反了或漏译`);
    }
  }

  // ── 规则 4：引用的图必须真在仓里（他读到断图栽过一次）──
  const missing = new Set<string>();
  for (const f of snap.changed) {
    const md = snap.files.get(f);
    if (md === undefined) continue;
    for (const ref of assetRefs(md)) if (!snap.assets.has(ref)) missing.add(ref);
  }
  for (const ref of [...missing].sort()) push(4, 'hard', ref, `断图：${ref}`);

  // ── 规则 8：PR body 五段（按**标题**匹配；缺项只警告）──
  // 老脚本用 `grep -q "$sec"`，段名出现在 body 任何位置即算过（需求 R6）。
  if (snap.body !== undefined) {
    const heads = headings(snap.body);
    for (const sec of BODY_SECTIONS) {
      if (!heads.some((h) => h.includes(sec))) push(8, 'warn', sec, `body 里没有「${sec}」这一段（要是标题，不是正文里提一句）`);
    }
  }

  return out;
}

const firstLine = (s: string): string => (s.split('\n')[0] ?? '').trim();
const pct = (r: number): string => `${Math.round(r * 100)}%`;

/** markdown 标题行的文字。剥代码跨度是为了不把代码块里的 `## x` 当标题。 */
export function headings(md: string): string[] {
  return stripCode(md)
    .split('\n')
    .filter((l) => /^\s{0,3}#{1,6}\s/.test(l))
    .map((l) => l.replace(/^\s{0,3}#{1,6}\s+/, '').trim());
}

/** 有硬伤就不合格。警告不影响。 */
export const hasHard = (fs: Finding[]): boolean => fs.some((f) => f.severity === 'hard');
