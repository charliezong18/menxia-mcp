#!/usr/bin/env node
// Differential 对照：老脚本 `folder-lint.sh` 与新 TS 逐条对齐。
//
// **这不是常设上线闸门**（design D7 已改）。上线闸门是 `test/scars.test.ts` 的疤痕清单，
// 理由：differential 会随老脚本一起死（D1 的退休条件是删掉它）、真实语料 14/16 空转、
// 且结构性覆盖不到新增的规则 5 和 9（它们的差异会被白名单化）。
//
// 它保留下来做**一次性迁移对照**：跑一遍，把每处差异分类成「bug」或「刻意改进」，留档。
//
// **老脚本 2026-07-30（Phase 4）退休了**，`~/.claude/skills/review-loop/` 下已经没有它。
// 默认路径改指仓内存档 `retired/folder-lint.sh` —— 这样这个脚本仍然跑得起来，
// 那些「刻意改进」的分类仍然可复核。**但它已经是史料**：新的上线判据是
// `scripts/retire-gate.mjs`（每条规则一个必失败样本），不是这个。
//
// 提醒：存档的老脚本带着 `folder-lint.sh:58` 那个假通过 bug（「缺中文版」它一次没拦住过），
// 所以对照结果里那一类的「差异」是**新实现对、老的错**，别读反。
//
// 复用 acceptance.mjs 的判据风格（正向断言 + ✓/✗ + 失败计数）——
// 那个文件的头注释就写着 differential 最需要的教训：「返回空必然变红」。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// 路径可覆盖 + **存在性先查**。上一版硬编码且不查，老脚本不在时它会报
// 10 条「未归类的差异 / 新多出 1:hard:a」—— 把人送去追一个不存在的规则差异（第二轮评审）。
const OLD = process.env.ZHUPI_OLD_LINT ?? join(root, 'retired', 'folder-lint.sh');
const NEW = process.env.ZHUPI_NEW_LINT ?? join(root, 'dist', 'lint-cli.js');
const REVIEW = process.env.ZHUPI_REVIEW_REPO_PATH ?? `${process.env.HOME}/Developer/review`;

for (const [label, p] of [['老脚本', OLD], ['新 CLI', NEW]]) {
  if (!existsSync(p)) {
    console.error(`跑不了 differential：${label}不存在 —— ${p}\n` +
      (p === NEW ? '先 npm run build。' : '设 ZHUPI_OLD_LINT 指到它，或者它已经退休了（那就该删掉这个脚本）。'));
    process.exit(2);
  }
}

let pass = 0;
let fail = 0;
const diffs = [];

const ok = (m) => { pass += 1; console.log(`  ✓ ${m}`); };
const bad = (m, detail) => { fail += 1; console.log(`  ✗ ${m}`); if (detail) console.log(`      ${detail}`); };
const check = (m, cond, detail) => (cond ? ok(m) : bad(m, detail));

const sh = (cmd, args, cwd) => {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};

/**
 * 把老脚本的人读文本归一化成 `rule:severity:subject`。
 *
 * **这里是最容易自欺的地方。** 只比 ✗ 的条数就会变成又一个恒绿测试 ——
 * 这个项目已经在「测试恒绿」上栽了三次。所以必须比到 subject 粒度。
 * 老脚本的失败行只有几种固定前缀，各带一个 subject 槽。
 */
/**
 * 解开 git 的八进制转义路径。
 *
 * 老脚本也没设 `core.quotePath=false`，所以中文名文件在它的输出里是
 * `"docs/guanzhi-00-\\345\\221\\210....md"`，而且尾随一个引号让 `.md` 后缀剥不掉。
 * 两边**判定其实一致**（都报同样 22 个 slug 缺对面），只是 subject 拼法不同 ——
 * 这是归一化的活，不是行为差异。第一轮评审那条中文名回归修完之后剩下的就是它。
 *
 * 顺带记一笔：老脚本会把转义名直接打给人看（`✗ guanzhi-00-\\345...md" 缺英文版`），
 * 那是它自己的显示 bug，已记 BACKLOG。
 */
function unquoteGitPath(raw) {
  let s = raw.trim();
  if (!s.includes('\\')) return s.replace(/^"|"$/g, '');
  s = s.replace(/^"|"$/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; ) {
    const m = /^\\([0-7]{3})/.exec(s.slice(i));
    if (m) {
      bytes.push(parseInt(m[1], 8));
      i += 4;
    } else {
      bytes.push(...Buffer.from(s[i], 'utf8'));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** 老脚本报的 subject 归一：解转义 + 剥 .md / .zh-CN.md（引号让它原来剥不掉）。 */
const oldSubject = (raw) => unquoteGitPath(raw).replace(/\.zh-CN\.md$/, '').replace(/\.md$/, '');

function normalizeOld(text) {
  const out = new Set();
  for (const line of text.split('\n')) {
    const s = line.trim();
    let m;
    if ((m = /^✗ 断图：(.+)$/.exec(s))) out.add(`4:hard:${unquoteGitPath(m[1])}`);
    else if ((m = /^✗ (\S+) 缺中文版/.exec(s))) out.add(`1:hard:${oldSubject(m[1])}`);
    else if ((m = /^✗ (\S+) 缺英文版/.exec(s))) out.add(`1:hard:${oldSubject(m[1])}`);
    else if ((m = /^✗ (\S+) 英文版首行互链头不对/.exec(s))) out.add(`2:hard:${oldSubject(m[1])}`);
    else if ((m = /^✗ (\S+) 中文版首行互链头不对/.exec(s))) out.add(`2:hard:${oldSubject(m[1])}`);
    else if ((m = /^✗ (\S+) 中文版缺「勿从本页复制」横幅/.exec(s))) out.add(`3:hard:${oldSubject(m[1])}`);
    else if (/^✗ 相对 main 没有任何 docs/.test(s)) out.add('1:hard:(none)');
    else if (/^⚠ 落后 main/.test(s)) out.add('6:warn:HEAD');
    else if ((m = /^⚠ (\S+) 已在 main 上/.exec(s))) out.add(`7:warn:docs/${unquoteGitPath(m[1])}`);
  }
  return [...out].sort();
}

const normalizeNew = (text) => text.trim().split('\n').map((s) => s.trim()).filter(Boolean).sort();

/**
 * 刻意改进登记表（SPEC §5.2：「是刻意改进就写进文档说清为什么」）。
 *
 * **逐条登记，不整条规则白名单化。** 规则 4 有两处刻意改进，但规则 4 本身仍必须逐条对齐 ——
 * 把整条规则 4 标成「改进」会让真正的断图回归悄悄溜过去，而断图正是他真被坑过的那条。
 *
 * 键是 `新多出 | 老多出` + 归一化 key 的前缀。
 */
const IMPROVEMENTS = [
  { dir: 'new', match: (k) => k.startsWith('5:'), why: '规则5 语言方向按比例（新增；老脚本完全不查内容语言）' },
  { dir: 'new', match: (k) => k.startsWith('9:'), why: '规则9 fetch 失败要报（新增；老脚本 `|| true` 静默继续）' },
  {
    dir: 'new', label: '规则4 HTML img 断图', match: (k) => k.startsWith('4:'),
    why: '规则4 兼查 HTML `<img src>`（SPEC §5.2 改进 #4；老脚本只认 markdown 链接语法）',
  },
  {
    // 规则 2 从「逐字符」改成「点得到对面」（第三轮：读 zhupi 源码发现
    // lang.js 只按文件名配对、从不读首行，逐字符匹配的立身理由是假的）。
    // **只登记「老的报、新的不报硬伤」这个方向** —— 新的多报仍算 bug，
    // 因为整条规则白名单化会让真正的「互链断了」溜过去。
    dir: 'old', match: (k) => k.startsWith('2:hard:'),
    why: '规则2 改成「链接目标解析后指对文件」，分隔符/`./` 前缀降为警告（第三轮：zhupi 只按文件名配对，从不读首行；实测这条误报正拦着 #12）',
  },
  {
    dir: 'new', match: (k) => k.startsWith('2:warn:'),
    why: '规则2 写法差异现在报警告（老脚本没有警告这一档）',
  },
  {
    dir: 'old', label: '规则4 inline code 里的假断图', match: (k) => k.startsWith('4:'),
    why: '规则4 扫图前先剥代码跨度（SPEC §5.1；老脚本把正文里的字面量例子报成断图——SPEC 自己第一次呈折就被它拦下）',
  },
];

const classify = (dir, key, label) =>
  IMPROVEMENTS.find((i) => i.dir === dir && i.match(key) && (i.label === undefined || i.label === label));

function compare(label, oldText, newText, quiet = false) {
  const o = new Set(normalizeOld(oldText));
  const n = new Set(normalizeNew(newText));
  const improvements = [];
  const unclassified = [];
  for (const k of [...n].filter((k) => !o.has(k))) {
    const hit = classify('new', k, label);
    if (hit) improvements.push({ key: k, why: hit.why });
    else unclassified.push(`新多出 ${k}`);
  }
  for (const k of [...o].filter((k) => !n.has(k))) {
    const hit = classify('old', k, label);
    if (hit) improvements.push({ key: k, why: hit.why });
    else unclassified.push(`老多出 ${k}`);
  }
  if (!quiet) {
    if (unclassified.length === 0) {
      ok(`${label} 对齐${improvements.length > 0 ? `（${improvements.length} 处刻意改进）` : ''}`);
    } else {
      bad(`${label} 有未归类的差异`, unclassified.join(' / '));
    }
  }
  diffs.push({ label, improvements, unclassified });
  return { unclassified, improvements, hardOld: [...o].filter((k) => k.includes(':hard:')), hardNew: [...n].filter((k) => k.includes(':hard:')) };
}

// ── 造样本：每条规则至少一个必失败用例 ──
const EN = (s, rest = '\n\nAll English prose here.\n') => `**English** · [中文](${s}.zh-CN.md)${rest}`;
const ZH = (s, rest = '\n\n这里全是中文正文。\n') => `[English](${s}.md) · **中文**${rest}`;

const SAMPLES = [
  { name: '规则1 缺中文版', files: { 'docs/a.md': EN('a') } },
  { name: '规则1 只有中文版', files: { 'docs/a.zh-CN.md': ZH('a') } },
  { name: '规则2 英文版互链头错', files: { 'docs/a.md': '**English** · [中文](a.zh.md)\n\nx\n', 'docs/a.zh-CN.md': ZH('a') } },
  { name: '规则2 中文版互链头错', files: { 'docs/a.md': EN('a'), 'docs/a.zh-CN.md': '[English](a.md) · 中文\n\n中文正文。\n' } },
  { name: '规则3 payload 缺横幅', files: { 'docs/.payload': 'docs/a.md\n', 'docs/a.md': '待发正文。\n', 'docs/a.zh-CN.md': ZH('a') } },
  { name: '规则4 断图', files: { 'docs/a.md': EN('a', '\n\n![p](assets/gone.png)\n'), 'docs/a.zh-CN.md': ZH('a') } },
  { name: '规则4 inline code 里的假断图', files: { 'docs/a.md': EN('a', '\n\n例子 `![p](assets/x.png)`\n'), 'docs/a.zh-CN.md': ZH('a') } },
  { name: '规则4 HTML img 断图', files: { 'docs/a.md': EN('a', '\n\n<img src="assets/gone.png">\n'), 'docs/a.zh-CN.md': ZH('a') } },
  { name: '规则5 双语放反', files: { 'docs/a.md': '**English** · [中文](a.zh-CN.md)\n\n这份英文版全是中文。\n', 'docs/a.zh-CN.md': '[English](a.md) · **中文**\n\nThis one is all English.\n' } },
  { name: '合格的折（对照）', files: { 'docs/a.md': EN('a'), 'docs/a.zh-CN.md': ZH('a') } },
];

function makeSampleRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'zhupi-diff-'));
  const origin = join(dir, 'o.git');
  const wt = join(dir, 'wt');
  sh('git', ['init', '--bare', '-q', origin], dir);
  sh('git', ['clone', '-q', origin, wt], dir);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) sh('git', ['config', k, v], wt);
  mkdirSync(join(wt, 'docs'), { recursive: true });
  writeFileSync(join(wt, 'docs', 'seed.md'), 'seed\n');
  sh('git', ['add', '.'], wt);
  sh('git', ['commit', '-qm', 'main'], wt);
  sh('git', ['branch', '-M', 'main'], wt);
  sh('git', ['push', '-q', '-u', 'origin', 'main'], wt);
  sh('git', ['checkout', '-qb', 'folder'], wt);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, p)), { recursive: true });
    writeFileSync(join(wt, p), content);
  }
  sh('git', ['add', '-A'], wt);
  sh('git', ['commit', '-qm', 'folder'], wt);
  return { dir, wt };
}

console.log('── 造样本对照（每条规则至少一个必失败用例）──');
for (const s of SAMPLES) {
  const { dir, wt } = makeSampleRepo(s.files);
  try {
    compare(s.name, sh('sh', [OLD, wt], wt).out, sh(process.execPath, [NEW, wt, '--parity'], wt).out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n── 自验：故意造差异，确认它真报 ──');
{
  const { dir, wt } = makeSampleRepo({ 'docs/a.md': EN('a'), 'docs/a.zh-CN.md': ZH('a') });
  try {
    // 假装老脚本报了一条新的没报的硬伤。它不在登记表里，所以必须被判成「未归类」。
    const r = compare('自验', '  ✗ a 缺中文版 a.zh-CN.md\n', sh(process.execPath, [NEW, wt, '--parity'], wt).out, true);
    check('造出来的差异被判成未归类 —— 否则 differential 自己是恒绿的', r.unclassified.length === 1, JSON.stringify(r.unclassified));
    // 反向自验：完全一致时不许报差异
    const same = sh(process.execPath, [NEW, wt, '--parity'], wt).out;
    check('两边一致时零未归类（不会凭空报差异）', compare('自验-一致', '', same, true).unclassified.length === 0);
    diffs.length = Math.max(0, diffs.length - 2); // 自验的两条不进小结
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n── 真实语料：奏折仓全部 open 折 ──');
const branches = sh('gh', ['pr', 'list', '-R', 'charliezong18/review', '--state', 'open', '--json', 'number,headRefName',
  '--jq', '.[] | "\\(.number) \\(.headRefName)"'], root).out.trim().split('\n').filter(Boolean);
check('拿到 open 折清单', branches.length > 0, `${branches.length} 个`);

const tmpWt = join(tmpdir(), `zhupi-diff-wt-${process.pid}`);
rmSync(tmpWt, { recursive: true, force: true });
sh('git', ['fetch', '-q', 'origin'], REVIEW);
sh('git', ['worktree', 'add', '-q', '--detach', tmpWt, 'origin/main'], REVIEW);
let aligned = 0;
let noop = 0;
try {
  for (const line of branches) {
    const [num, br] = line.split(' ');
    if (sh('git', ['rev-parse', '--verify', '--quiet', `origin/${br}`], REVIEW).code !== 0) {
      bad(`#${num} ${br} 分支不在本地`, '需要 git fetch');
      continue;
    }
    sh('git', ['checkout', '-q', '--detach', `origin/${br}`], tmpWt);
    const oldOut = sh('sh', [OLD, tmpWt], tmpWt).out;
    const newOut = sh(process.execPath, [NEW, tmpWt, '--parity'], tmpWt).out;
    const r = compare(`#${num} ${br}`, oldOut, newOut);
    if (r.unclassified.length === 0) aligned += 1;
    // 「空转」= 两边都零**硬伤**。对上线闸门来说这种折不携带信息：
    // 无论实现对不对它都说「合格」。警告不算 —— 落后 main 之类几乎每折都有。
    if (r.hardOld.length === 0 && r.hardNew.length === 0) noop += 1;
  }
} finally {
  sh('git', ['worktree', 'remove', '--force', tmpWt], REVIEW);
}

console.log('\n── 分类小结 ──');
const byWhy = new Map();
for (const im of diffs.flatMap((d) => d.improvements)) byWhy.set(im.why, (byWhy.get(im.why) ?? 0) + 1);
console.log('  刻意改进（逐条登记，不整条规则白名单化）：');
for (const [why, n] of [...byWhy].sort()) console.log(`    · ${n} 处 —— ${why}`);
console.log(`  真实语料 ${branches.length} 折，对齐 ${aligned}`);
console.log(`  其中两边都零**硬伤**（对闸门不携带信息）${noop} 折 = ${branches.length > 0 ? Math.round((noop / branches.length) * 100) : 0}%`);
console.log('  → 这就是 D7 把 differential 从上线闸门降级的第二条理由：真信号全压在手造样本上，');
console.log('    而手造样本的质量正是 differential 自己校验不了的东西。上线闸门是 test/scars.test.ts。');

console.log(`\n${fail === 0 ? 'differential 对齐（差异全部归类为刻意改进）。' : `differential 有 ${fail} 处未归类的差异 —— 是 bug 就修，是改进就写进文档。`}`);
process.exit(fail === 0 ? 0 : 1);
