import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assetRefs, cjkRatio, lint, hasHard, type Snapshot } from '../src/lint.js';
import { stripCode } from '../src/strip.js';
import { collect } from '../src/snapshot.js';

/** 造一个带 origin 的小仓，用于采料层那几条疤（它们只能在真 git 上复现）。 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'zhupi-scar-'));
  const origin = join(dir, 'o.git');
  const wt = join(dir, 'wt');
  const run = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(dir, 'init', '--bare', '-q', origin);
  run(dir, 'clone', '-q', origin, wt);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) run(wt, 'config', k, v);
  mkdirSync(join(wt, 'docs'), { recursive: true });
  writeFileSync(join(wt, 'docs', 'seed.md'), 'seed\n');
  run(wt, 'add', '.');
  run(wt, 'commit', '-qm', 'main');
  run(wt, 'branch', '-M', 'main');
  run(wt, 'push', '-q', '-u', 'origin', 'main');
  run(wt, 'checkout', '-qb', 'folder');
  return { dir, wt, g: (...a: string[]) => run(wt, ...a) };
}

const w = (wt: string, rel: string, content: string) => {
  mkdirSync(dirname(join(wt, rel)), { recursive: true });
  writeFileSync(join(wt, rel), content);
};

// ══ 疤痕清单 —— Phase 2 的上线闸门（design §3，D7 已定）══
//
// 每一条都是**硬换来的行为**：某个具体事故留下的疤。测试名里是事故，注释里是病历。
// 范本：~/.claude/skills/review-loop/guard-var.test.sh
//
// 为什么不用 differential 当闸门（v1 的方案，评审推翻）：
//   ① 它会自我删除 —— D1 的退休条件是「连续 10 次零分歧就删老脚本」，老脚本一删它就死；
//      而需求 R2 明写「留在仓里可重跑」。R2 与 D1 直接矛盾。
//   ② 真实语料 16 折里 14 折两边都说「合格」，几乎不携带信息。
//   ③ 新增的规则 5 和 9 的差异会被预先标成「刻意改进」白名单化 → 覆盖率归零。
//
// 疤痕清单强在：老脚本删了它照样活、写明 WHY 所以改动不能静默回退、不需要归一化、
// **能覆盖新增的两条规则**。
//
// 改这个文件之前先读病历。每一条都是有人（通常是 Charlie）真的被坑过一次换来的。

const EN = (slug: string, rest = '\n\nAll prose here is English.') => `**English** · [中文](${slug}.zh-CN.md)${rest}`;
const ZH = (slug: string, rest = '\n\n这里全是中文正文。') => `[English](${slug}.md) · **中文**${rest}`;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  const files = over.files ?? new Map([['docs/a.md', EN('a')], ['docs/a.zh-CN.md', ZH('a')]]);
  return {
    files,
    changed: over.changed ?? [...files.keys()],
    assets: over.assets ?? new Set(),
    payload: over.payload ?? [],
    onMain: over.onMain ?? new Set(),
    base: over.base ?? { behind: 0, fetchFailed: false },
    ...(over.body !== undefined ? { body: over.body } : {}),
  };
}

describe('疤 · 2026-07-27「他读到断图」', () => {
  // 病历：一折引用的图没一起搬进奏折仓，他在朱批台上读到的是断图。
  // 这条是规则 4 存在的全部理由，硬伤不是警告。
  it('引用了仓里没有的图 → 硬伤，呈折必须被拦', () => {
    const files = new Map([['docs/a.md', `${EN('a')}\n\n![立面图](assets/sd-02.png)`], ['docs/a.zh-CN.md', ZH('a')]]);
    const f = lint(snap({ files }));
    expect(hasHard(f)).toBe(true);
    expect(f.find((x) => x.rule === 4)?.severity).toBe('hard');
  });
});

describe('疤 · 2026-07-29「一篇讲 lint 规则的文档过不了 lint」', () => {
  // 病历（SPEC §5.1）：SPEC 自己第一次呈折被 lint 拦下，报了两张断图 ——
  // 实际是正文里用来说明规则的字面量例子，写在 inline code 里。
  // 当时的绕法是改写措辞躲开，那是权宜。规则 4 扫图之前**必须**先剥代码跨度。
  it('写在 inline code 里的图片路径不算引用', () => {
    const files = new Map([
      ['docs/a.md', `${EN('a')}\n\n断图检查匹配的是 \`![图](assets/example.png)\` 这种写法。`],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    expect(lint(snap({ files })).some((x) => x.rule === 4)).toBe(false);
  });

  it('写在 fenced code block 里的也不算', () => {
    const files = new Map([
      ['docs/a.md', `${EN('a')}\n\n\`\`\`md\n![图](assets/example.png)\n\`\`\``],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    expect(lint(snap({ files })).some((x) => x.rule === 4)).toBe(false);
  });

  it('但同一篇里的**真**引用照样报 —— 不能因为剥了代码就整条失效', () => {
    const files = new Map([
      ['docs/a.md', `${EN('a')}\n\n例子：\`![图](assets/example.png)\`\n\n真图：![x](assets/real.png)`],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    const f = lint(snap({ files })).filter((x) => x.rule === 4);
    expect(f.map((x) => x.subject)).toEqual(['assets/real.png']);
  });
});

describe('疤 · pre-push 那次「拦太死把人逼向绕过闸门」', () => {
  // 病历：早先的 pre-push 钩子阻断得太狠，结果是人绕过闸门而不是修问题。
  // 所以「落后 main」刻意只警告 —— squash merge 只应用三点 diff，落后本身无害。
  // 真正的病是「从别的未合分支切」，那个症状是规则 7。
  it('落后 main 只警告，绝不阻断', () => {
    const f = lint(snap({ base: { behind: 12, fetchFailed: false } }));
    expect(f.some((x) => x.rule === 6)).toBe(true);
    expect(hasHard(f)).toBe(false);
  });

  it('语言方向也只警告（D5）—— 阈值 30% 从没在真实语料上量过', () => {
    const files = new Map([
      ['docs/a.md', `**English** · [中文](a.zh-CN.md)\n\n这份英文版里全是中文。`],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    const f = lint(snap({ files }));
    expect(f.some((x) => x.rule === 5)).toBe(true);
    expect(hasHard(f)).toBe(false);
  });
});

describe('疤 · `.payload` 例外「只存在于代码里，SKILL.md 从没写过」', () => {
  // 病历（SPEC §5.1 规则 3）：docs/.payload 登记的「待发正文」免英文版互链头 ——
  // 加了会把那行一起贴进对外 issue。代价是它在 zhupi 里切不了语言，
  // 由中文版的「不要从本页复制」横幅兜底。
  // 这条在任何文档里都查不到，只有 folder-lint.sh 第 65-67 行知道。删掉它不会有测试变红——除了这一条。
  const bare = '待发正文，第一行就是正文本身。';

  it('登记了 → 英文版免互链头', () => {
    const files = new Map([['docs/a.md', bare], ['docs/a.zh-CN.md', `${ZH('a')}\n\n不要从本页复制`]]);
    expect(lint(snap({ files, payload: ['docs/a.md'] }))).toEqual([]);
  });

  it('免了互链头就**必须**有勿复制横幅，否则硬伤', () => {
    const files = new Map([['docs/a.md', bare], ['docs/a.zh-CN.md', ZH('a')]]);
    expect(lint(snap({ files, payload: ['docs/a.md'] })).some((x) => x.rule === 3 && x.severity === 'hard')).toBe(true);
  });

  it('例外只免英文版 —— 中文版互链头照查', () => {
    const files = new Map([['docs/a.md', bare], ['docs/a.zh-CN.md', '没有互链头\n\n不要从本页复制']]);
    expect(lint(snap({ files, payload: ['docs/a.md'] })).some((x) => x.rule === 2)).toBe(true);
  });
});

describe('疤 · 互链头「zhupi 的语言切页按它认对子」', () => {
  // 病历：互链头不是装饰，是 zhupi 用来配对中英版本的键。差一个字符就切不了语言。
  // 所以是逐字符匹配，不是「含有 English 字样」。
  it('多一个字都不行', () => {
    const files = new Map([['docs/a.md', '**English** · [中文](a.zh-CN.md) '], ['docs/a.zh-CN.md', ZH('a')]]);
    // 尾部空格被 trim，所以这条应该过；下一条才是真的差异
    expect(lint(snap({ files })).some((x) => x.rule === 2 && x.message.includes('英文版'))).toBe(false);
  });

  it('链接目标写错 → 硬伤', () => {
    const files = new Map([['docs/a.md', '**English** · [中文](a.zh.md)'], ['docs/a.zh-CN.md', ZH('a')]]);
    expect(lint(snap({ files })).some((x) => x.rule === 2 && x.severity === 'hard')).toBe(true);
  });

  it('顺序反了（中文在前）→ 硬伤', () => {
    const files = new Map([['docs/a.md', '[中文](a.zh-CN.md) · **English**'], ['docs/a.zh-CN.md', ZH('a')]]);
    expect(lint(snap({ files })).some((x) => x.rule === 2)).toBe(true);
  });
});

describe('疤 · 2026-07-30「巡检说合体例、呈折过不去」（需求 R7）', () => {
  // 病历：audit-folders.sh 只查 `.md → .zh-CN.md` 单向、且直接跳过 .zh-CN.md 文件，
  // 而 folder-lint.sh 按 slug 双向查。于是「只有中文版」的折能过巡检、过不了呈折闸门。
  // 统一之后这条必须双向。
  it('只有中文版也要报', () => {
    expect(lint(snap({ files: new Map([['docs/a.zh-CN.md', ZH('a')]]) }))[0]!.message).toContain('缺英文版');
  });

  it('只有英文版也要报', () => {
    expect(lint(snap({ files: new Map([['docs/a.md', EN('a')]]) }))[0]!.message).toContain('缺中文版');
  });
});

describe('疤 · 五段检查「段名出现在任何位置就算过」', () => {
  // 病历（SPEC §5.1 规则 6 + 需求 R6）：老脚本用 `grep -q "$sec"`，
  // 所以正文里随口提一句「怎么用」就算这一段存在。改成按**标题**匹配。
  // 同时：缺项**只警告** —— SKILL.md 体例表和 open-folder.sh 第 27 行注释都写「也拦」，
  // 那是文档错了（需求 R6 已定），归 Phase 4 修文档。
  const five = ['目的地', '直达链', 'TLDR', '待你拍板', '怎么用'].map((s) => `## ${s}\n\n内容`).join('\n\n');

  it('正文里提一句不算过', () => {
    const body = five.replace('## 怎么用\n\n内容', '这里说明了怎么用它');
    expect(lint(snap({ body })).some((x) => x.rule === 8 && x.subject === '怎么用')).toBe(true);
  });

  it('缺项只警告，不阻断呈折', () => {
    const f = lint(snap({ body: '## 目的地\n\n内容' }));
    expect(f.filter((x) => x.rule === 8).length).toBe(4);
    expect(hasHard(f)).toBe(false);
  });
});

describe('疤 · `git fetch -q || true`「结论建在陈旧 main 上」', () => {
  // 病历（SPEC §5.1）：老脚本 fetch 失败时静默继续，此时 origin/main 是陈旧的，
  // 「落后几个提交」「哪些已在 main 上」全部基于旧数据 —— 而它照样打勾。
  it('fetch 失败必须说出来', () => {
    expect(lint(snap({ base: { behind: 0, fetchFailed: true } })).some((x) => x.rule === 9)).toBe(true);
  });

  it('而且排在最前面 —— 它决定后面所有结论可不可信', () => {
    expect(lint(snap({ base: { behind: 3, fetchFailed: true }, onMain: new Set(['docs/a.md']) }))[0]!.rule).toBe(9);
  });
});

describe('疤 · 2026-07-28「整篇翻反了不拦」（刻意改进 #1）', () => {
  // 病历：老脚本只查「两个文件都存在」，完全不看内容语言。
  // SKILL.md 却写着「先判原文语言再定方向——对外草稿本来就是英文，反了就白翻」。
  // 这是文档要求了但代码从没实现的一条。Charlie 2026-07-28 拍板「按比例查，剥掉代码块再算」。
  it('英中互换 → 两个方向都报', () => {
    const files = new Map([
      ['docs/a.md', '**English** · [中文](a.zh-CN.md)\n\n这份是中文内容，放错了位置。'],
      ['docs/a.zh-CN.md', '[English](a.md) · **中文**\n\nThis one is English content in the Chinese slot.'],
    ]);
    expect(lint(snap({ files })).filter((x) => x.rule === 5)).toHaveLength(2);
  });

  it('**中英混排的正常英文版不误报** —— 术语表和专名撑不到阈值', () => {
    const files = new Map([
      ['docs/a.md', EN('a', '\n\nA folder is 奏折, an annotation is 朱批, and sealing it is 钦此. The rest of this document is ordinary English prose that runs on long enough to dominate the ratio.')],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    expect(lint(snap({ files })).some((x) => x.rule === 5)).toBe(false);
  });
});

describe('疤 · HTML `<img src>` 不被查（刻意改进 #4）', () => {
  // 病历（SPEC §5.2）：老脚本只匹配 markdown 链接语法 `](assets/...)`，
  // 而需要控制宽度时会写成 <img src="..." width="600">，那种断图完全不拦。
  it('<img src> 里的断图也报', () => {
    const files = new Map([
      ['docs/a.md', `${EN('a')}\n\n<img src="assets/gone.png" width="600">`],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    expect(lint(snap({ files })).some((x) => x.rule === 4)).toBe(true);
  });

  it('不带引号、大写标签也认', () => {
    const files = new Map([
      ['docs/a.md', `${EN('a')}\n\n<IMG SRC=assets/gone.png>`],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    expect(lint(snap({ files })).some((x) => x.rule === 4)).toBe(true);
  });
});

describe('疤 · stripCode「围栏没关就剥到末尾」', () => {
  // 这是个刻意的方向选择，不是 bug：反引号数不匹配时，
  // 宁可把剩下的正文当代码（断图漏报，良性）也不要把代码当正文
  // （语言方向误报 = 拦住一篇好文档，而这个项目对「拦太死」的反应是绕过）。
  it('未闭合围栏之后的内容被当代码', () => {
    expect(stripCode('正文\n```\n没关\n还有中文').replace(/\s+/g, '')).toBe('正文');
  });

  it('``` 不能被 ~~~ 关掉', () => {
    expect(stripCode('前\n```\n~~~\n仍在代码里\n```\n后').includes('仍在代码里')).toBe(false);
  });
});

describe('疤 · 2026-07-30「规则 5 与 `.payload` 例外相撞」（实现时被疤痕清单抓到）', () => {
  // 病历：写疤痕清单时「登记了 → 英文版免互链头」这条挂了 ——
  // 因为待发正文写的是中文，规则 5 报「英文版里 CJK 占 100%」。
  //
  // 这不是 fixture 写错，是真的规则交互：**待发正文的语言由收件人决定**，
  // 不由 `.md` / `.zh-CN.md` 这个命名约定决定。一封要发出去的中文邮件
  // 登记在 `<slug>.md` 里完全正常。所以 `.payload` 的英文版跳过规则 5。
  //
  // 中文版那一侧照查 —— 它是给他读的译本，方向约定仍然成立。
  const zhPayload = '各位好：\n\n这是要发出去的中文正文，收件人读中文。';

  it('待发正文是中文 → 不报语言方向', () => {
    const files = new Map([['docs/a.md', zhPayload], ['docs/a.zh-CN.md', `${ZH('a')}\n\n不要从本页复制`]]);
    expect(lint(snap({ files, payload: ['docs/a.md'] }))).toEqual([]);
  });

  it('**没登记的文件不享受这个豁免** —— 免的是待发正文，不是所有中文英文版', () => {
    const files = new Map([['docs/a.md', `${EN('a', '')}\n\n这份英文版里全是中文，而且没登记。`], ['docs/a.zh-CN.md', ZH('a')]]);
    expect(lint(snap({ files })).some((x) => x.rule === 5)).toBe(true);
  });

  it('待发正文的中文版照查语言方向', () => {
    const files = new Map([['docs/a.md', zhPayload], ['docs/a.zh-CN.md', `[English](a.md) · **中文**\n\nAll English here.\n\n不要从本页复制`]]);
    expect(lint(snap({ files, payload: ['docs/a.md'] })).some((x) => x.rule === 5)).toBe(true);
  });
});

// ══ 以下四条是 2026-07-30 第一轮实现评审抓到的**我自己引入的回归** ══
// 疤痕清单原本只 import lint 和 stripCode，结构上碰不到采料层 ——
// 而评审实测 snapshot.ts 的 7 个变异体 100% 存活，三条高危全在那一层。
// 所以下面这组要真造 git 仓。

describe('疤 · 2026-07-30「中文名文件全挂」（我引入的回归）', () => {
  // 病历：`git ls-tree` / `git diff` 默认把非 ASCII 路径转义成八进制加引号
  // （core.quotePath 默认 on）。不关掉的话 assets 集合里是转义串、正文引用是真名，
  // 永远对不上 → 中文名的图一律误报断图（硬伤，好折被拦死且改不掉）；
  // changed 里的路径也带引号 → git show 必失败 → 双语齐的也报缺译本。
  // 实测：奏折仓 #31 那折 22 个中文名文档全部踩在上面。
  it('中文名的图真在仓里 → 不许报断图；中文名双语对 → 不许报缺译本', () => {
    const { dir, wt, g } = repo();
    try {
      w(wt, 'docs/立面.md', '**English** · [中文](立面.zh-CN.md)\n\nEnglish prose.\n\n![图](assets/立面图.png)\n');
      w(wt, 'docs/立面.zh-CN.md', '[English](立面.md) · **中文**\n\n中文正文。\n');
      w(wt, 'docs/assets/立面图.png', 'png');
      g('add', '-A'); g('commit', '-qm', 'cn');
      expect(lint(collect({ worktree: wt, skipFetch: true }))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('疤 · 2026-07-30「大文档被当不存在」（我引入的回归）', () => {
  // 病历：execFileSync 默认 maxBuffer 1 MiB，超了抛 ENOBUFS 被 catch 吞成 null，
  // 等价于「文件不存在」。后果是双向都错：谎报缺译本，同时因为 files.get 为空
  // 让规则 4 整条不跑 → 真断图漏报。静默降级，不会有人发现。
  it('1 MiB 以上的文档照样读得到，规则 4 照样跑', () => {
    const { dir, wt, g } = repo();
    try {
      const big = `${'x'.repeat(1_200_000)}\n\n![p](assets/gone.png)\n`;
      w(wt, 'docs/big.md', `**English** · [中文](big.zh-CN.md)\n\n${big}`);
      w(wt, 'docs/big.zh-CN.md', '[English](big.md) · **中文**\n\n中文正文。\n');
      g('add', '-A'); g('commit', '-qm', 'big');
      const f = lint(collect({ worktree: wt, skipFetch: true }));
      expect(f.some((x) => x.rule === 1)).toBe(false);            // 不谎报缺译本
      expect(f.some((x) => x.rule === 4 && x.subject === 'assets/gone.png')).toBe(true); // 真断图照报
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('疤 · 2026-07-30「行首反引号开出假围栏」（我引入的回归）', () => {
  // 病历：strip 的围栏识别只看行首 `^\s{0,3}(`{3,})`，不判断那是不是行内 code。
  // 正文写 "```md``` is the info string form." 会开出一个假围栏，
  // 把**整篇剩下的内容**当代码剥掉 → 真断图漏报，而那正是「他读到断图」那条疤本身。
  it('行内 code 形状的 ``` 不开围栏，后面的真断图照报', () => {
    const md = '**English** · [中文](a.zh-CN.md)\n\n```md``` is the info string form.\n\n![real](assets/gone.png)\n';
    expect(stripCode(md)).toContain('assets/gone.png');
  });

  it('真围栏照旧剥（不能因为收紧判据就整条失效）', () => {
    expect(stripCode('前\n```md\n![x](assets/e.png)\n```\n后')).not.toContain('assets/e.png');
  });

  it('带 info string 的真围栏也要剥', () => {
    expect(stripCode('前\n```ts\nconst 中文 = 1;\n```\n后').includes('中文')).toBe(false);
  });
});

describe('疤 · 2026-07-30「带空格文件名的断图漏报」（我引入的回归）', () => {
  // 病历：assetRefs 用 `[^)\s]+`，带空格的路径整条匹配不上（老脚本用 `[^)]+`，能报）。
  const base = (body: string) => `**English** · [中文](a.zh-CN.md)\n\n${body}`;

  it('文件名带空格的断图要报', () => {
    expect(assetRefs(base('![p](assets/plan b.png)'))).toContain('assets/plan b.png');
  });

  it('title 要剥掉，不能连进路径', () => {
    expect(assetRefs(base('![p](assets/a.png "站位图")'))).toEqual(['assets/a.png']);
  });

  it('URL 转义要解开 —— GitHub 渲染正常的路径不许被判成断图', () => {
    expect(assetRefs(base('![p](assets/site%20plan.png)'))).toEqual(['assets/site plan.png']);
  });

  it('引用式链接定义也算引用', () => {
    expect(assetRefs(base('![p][k]\n\n[k]: assets/ref.png'))).toContain('assets/ref.png');
  });

  it('**锚点不剥** —— 剥了会让真叫 `plan#2.png` 的图变成假断图', () => {
    // 上一版无条件剥 `#.*`，第二轮评审指出：老脚本放行、新版判硬伤，
    // 而这个行为改变没登记进刻意改进表。给图片路径加锚点本来就没意义，
    // 不值得为它误伤真文件名。
    expect(assetRefs(base('![p](assets/plan#2.png)'))).toEqual(['assets/plan#2.png']);
  });

  it('引用式定义里带空格的文件名也要认 —— 修 F4 时在新分支里又种了一遍同一个 bug', () => {
    expect(assetRefs(base('![p][k]\n\n[k]: assets/plan b.png'))).toContain('assets/plan b.png');
  });
});

describe('疤 · 严重度不许悄悄改（评审实测这类变异全存活）', () => {
  // 病历：第一轮评审做了 34 个变异，疤痕清单只杀 12 个。存活的包括
  // 「规则 1 硬伤降成警告」和「规则 7 警告升成硬伤」—— 后者直接违反
  // 「拦太死把人逼向绕过」那条疤。严重度是判据的一半，必须逐条钉住。
  const S = (over: Partial<Snapshot> = {}): Snapshot => ({
    files: new Map(), changed: [], assets: new Set(), payload: [], onMain: new Set(),
    base: { behind: 0, fetchFailed: false }, ...over,
  });
  // **取所有同规则 finding 的严重度**，不是 find 第一条 ——
  // 上一版用 find，于是规则 2「中文版互链头」那条从未被断言，
  // 变异（hard→warn）在全量套件下存活（第二轮评审）。
  const sevs = (f: ReturnType<typeof lint>, rule: number) => [...new Set(f.filter((x) => x.rule === rule).map((x) => x.severity))];
  const sev = (f: ReturnType<typeof lint>, rule: number) => sevs(f, rule)[0];

  it('硬伤那四条必须是 hard', () => {
    expect(sev(lint(S({ files: new Map([['docs/a.md', 'x']]), changed: ['docs/a.md'] })), 1)).toBe('hard');
    // 中英两侧的互链头**都**写错，断言两条都是 hard —— 只测英文那侧会漏掉一半
    const withHead = new Map([['docs/a.md', '错的头'], ['docs/a.zh-CN.md', '也是错的头\n\n中文正文。']]);
    const f2 = lint(S({ files: withHead, changed: [...withHead.keys()] }));
    expect(f2.filter((x) => x.rule === 2)).toHaveLength(2);
    expect(sevs(f2, 2)).toEqual(['hard']);
    const pay = new Map([['docs/a.md', '正文'], ['docs/a.zh-CN.md', '[English](a.md) · **中文**\n\n中文正文。']]);
    expect(sev(lint(S({ files: pay, changed: [...pay.keys()], payload: ['docs/a.md'] })), 3)).toBe('hard');
    const img = new Map([
      ['docs/a.md', '**English** · [中文](a.zh-CN.md)\n\nEnglish.\n\n![x](assets/g.png)'],
      ['docs/a.zh-CN.md', '[English](a.md) · **中文**\n\n中文正文。'],
    ]);
    expect(sev(lint(S({ files: img, changed: [...img.keys()] })), 4)).toBe('hard');
  });

  it('警告那五条必须是 warn —— 升成硬伤就是重犯 pre-push 那次的错', () => {
    expect(sev(lint(S({ base: { behind: 1, fetchFailed: true } })), 9)).toBe('warn');
    expect(sev(lint(S({ base: { behind: 1, fetchFailed: false } })), 6)).toBe('warn');
    const on = new Map([['docs/a.md', '**English** · [中文](a.zh-CN.md)\n\nEnglish.'], ['docs/a.zh-CN.md', '[English](a.md) · **中文**\n\n中文。']]);
    expect(sev(lint(S({ files: on, changed: [...on.keys()], onMain: new Set(['docs/a.md']) })), 7)).toBe('warn');
    // 两个方向都翻反，断言两条都是 warn
    const rev = new Map([
      ['docs/a.md', '**English** · [中文](a.zh-CN.md)\n\n这份英文版全是中文。'],
      ['docs/a.zh-CN.md', '[English](a.md) · **中文**\n\nThis is all English.'],
    ]);
    const f5 = lint(S({ files: rev, changed: [...rev.keys()] }));
    expect(f5.filter((x) => x.rule === 5)).toHaveLength(2);
    expect(sevs(f5, 5)).toEqual(['warn']);
    expect(sev(lint(S({ files: on, changed: [...on.keys()], body: '## 目的地' })), 8)).toBe('warn');
  });
});

describe('疤 · 2026-07-30「.payload 豁免面被悄悄放宽」（我引入的回归）', () => {
  // 病历：老脚本是 `grep -qxF "$EN"` —— 整行、逐字节、必须带 docs/ 前缀。
  // 我上一版额外接受「剥掉 docs/ 前缀」，那是放宽豁免面 → 规则 2 这条硬伤被更多文件跳过。
  // 方向是「老的拦、新的放」，对闸门来说是危险的那一侧，而且没登记进刻意改进表。
  const S = (payload: string[]): Snapshot => ({
    files: new Map([['docs/a.md', '待发正文。'], ['docs/a.zh-CN.md', '[English](a.md) · **中文**\n\n中文。\n\n不要从本页复制']]),
    changed: ['docs/a.md', 'docs/a.zh-CN.md'],
    assets: new Set(), payload, onMain: new Set(), base: { behind: 0, fetchFailed: false },
  });

  it('带 docs/ 前缀的整行 → 豁免生效', () => {
    expect(lint(S(['docs/a.md']))).toEqual([]);
  });

  it('**不带 docs/ 前缀 → 不豁免**（与老脚本一致）', () => {
    expect(lint(S(['a.md'])).some((f) => f.rule === 2)).toBe(true);
  });

  it('别的文件名不误命中', () => {
    expect(lint(S(['docs/other.md'])).some((f) => f.rule === 2)).toBe(true);
  });
});

describe('疤 · cjkRatio 必须先剥代码（strip.ts 头注释点名的危害，此前零测试）', () => {
  // 病历：第二轮评审实测，同一篇英文文档（代码块里是中文注释）
  // 剥代码 0.077 vs 不剥 0.732，阈值 0.3 —— 不剥就是必然的规则 5 误报。
  // 变异「cjkRatio 不剥代码」在全量套件下存活，因为没人直接测这个组合。
  const doc = [
    'All of the prose in this document is written in English.',
    '',
    '```ts',
    '// 这里全是中文注释，而且很长很长，占比足以把英文版判成翻反了',
    'const 变量名 = "中文字符串";',
    '// 再来一行中文注释，让代码块里的中日韩字符压过正文',
    '```',
  ].join('\n');

  it('代码块里的中文不算进占比', () => {
    expect(cjkRatio(doc)).toBeLessThan(0.3);
  });

  it('不剥的话会翻过阈值 —— 这就是为什么必须剥（把差距钉住）', () => {
    const withCode = (doc.match(/[一-鿿]/g)?.length ?? 0) / doc.replace(/[\s\d\p{P}\p{S}]/gu, '').length;
    expect(withCode).toBeGreaterThan(0.3);   // 不剥 → 误报
    expect(cjkRatio(doc)).toBeLessThan(0.3); // 剥了 → 不误报
  });

  it('接到规则 5 上：这样一篇英文文档不许被判成翻反', () => {
    const files = new Map([
      ['docs/a.md', `**English** · [中文](a.zh-CN.md)\n\n${doc}`],
      ['docs/a.zh-CN.md', '[English](a.md) · **中文**\n\n这里全是中文正文。'],
    ]);
    const s: Snapshot = {
      files, changed: [...files.keys()], assets: new Set(), payload: [],
      onMain: new Set(), base: { behind: 0, fetchFailed: false },
    };
    expect(lint(s).some((f) => f.rule === 5)).toBe(false);
  });
});
