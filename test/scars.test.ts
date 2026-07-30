import { describe, it, expect } from 'vitest';
import { lint, hasHard, type Snapshot } from '../src/lint.js';
import { stripCode } from '../src/strip.js';

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
