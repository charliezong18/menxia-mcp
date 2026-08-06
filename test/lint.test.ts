import { describe, it, expect } from 'vitest';
import { lint, hasHard, cjkRatio, assetRefs, slugsOf, headings, type Snapshot } from '../src/lint.js';

// 每条规则一个通过 + 一个必失败用例（需求 R2 原文要求）。
// 全部用内联假 snapshot —— 规则不碰 IO，所以不用造 9 个 git 仓。

const EN = (slug: string, rest = '\n\nAll prose here is English.') => `**English** · [中文](${slug}.zh-CN.md)${rest}`;
const ZH = (slug: string, rest = '\n\n这里全是中文正文，占比足够高。') => `[English](${slug}.md) · **中文**${rest}`;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  const files = over.files ?? new Map([['docs/a.md', EN('a')], ['docs/a.zh-CN.md', ZH('a')]]);
  return {
    files,
    changed: over.changed ?? [...files.keys()],
    assets: over.assets ?? new Set(),
    payload: over.payload ?? [],
    monolingual: over.monolingual ?? [],
    onMain: over.onMain ?? new Set(),
    base: over.base ?? { behind: 0, fetchFailed: false },
    ...(over.body !== undefined ? { body: over.body } : {}),
  };
}

const rules = (s: Snapshot) => lint(s).map((f) => f.rule).sort();

describe('干净的折', () => {
  it('零 finding', () => {
    expect(lint(snap())).toEqual([]);
    expect(hasHard(lint(snap()))).toBe(false);
  });
});

describe('规则 1 · 双语对齐全（按 slug 双向）', () => {
  it('齐 → 过', () => expect(rules(snap())).not.toContain(1));

  it('缺中文版 → 硬伤', () => {
    const f = lint(snap({ files: new Map([['docs/a.md', EN('a')]]) }));
    expect(f).toEqual([{ rule: 1, severity: 'hard', subject: 'a', message: expect.stringContaining('缺中文版') }]);
  });

  it('**只有中文版 → 也必须报**（巡检那边单向查，这里双向）', () => {
    const f = lint(snap({ files: new Map([['docs/a.zh-CN.md', ZH('a')]]) }));
    expect(f[0]!.message).toContain('缺英文版');
  });

  it('一个 docs 改动都没有 → 硬伤', () => {
    expect(lint(snap({ files: new Map(), changed: [] }))).toEqual([
      { rule: 1, severity: 'hard', subject: '(none)', message: expect.stringContaining('没有任何 docs') },
    ]);
  });
});

describe('规则 2 · 互链头「点得到对面」（第三轮评审后按 menxia 真实行为改）', () => {
  it('对 → 过', () => expect(rules(snap())).not.toContain(2));

  it('**点不到对面 → 硬伤**（GitHub 原生页面上互链断了）', () => {
    const files = new Map([['docs/a.md', '**English** 没有链接'], ['docs/a.zh-CN.md', ZH('a')]]);
    const f = lint(snap({ files })).filter((x) => x.rule === 2);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('hard');
  });

  it('链接指错文件 → 硬伤', () => {
    const files = new Map([['docs/a.md', '**English** · [中文](b.zh-CN.md)'], ['docs/a.zh-CN.md', ZH('a')]]);
    expect(lint(snap({ files })).some((x) => x.rule === 2 && x.severity === 'hard')).toBe(true);
  });

  it('**点得到但写法不同 → 只警告**（#12 就是被这种误报拦住的）', () => {
    const files = new Map([
      ['docs/a.md', '**English** | [中文](./a.zh-CN.md)\n\nEnglish prose.'],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    const f = lint(snap({ files })).filter((x) => x.rule === 2);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(hasHard(lint(snap({ files })))).toBe(false);
  });

  it('报错要给**实际值** —— `·`(U+00B7) 和 `|` 在等宽字体里几乎看不出差别', () => {
    const files = new Map([['docs/a.md', '**English** | [中文](a.zh-CN.md)'], ['docs/a.zh-CN.md', ZH('a')]]);
    expect(lint(snap({ files })).find((x) => x.rule === 2)!.message).toMatch(/实为：.*\|/);
  });

  it('slug 带目录时用 basename 拼互链头', () => {
    const files = new Map([['docs/sub/a.md', EN('a')], ['docs/sub/a.zh-CN.md', ZH('a')]]);
    expect(rules(snap({ files }))).not.toContain(2);
  });
});

describe('规则 3 · .payload 例外 + 勿复制横幅', () => {
  // 这条**只存在于代码里**，SKILL.md 从没写过。
  const bare = '待发正文，第一行就是正文本身。';
  it('登记为待发正文 → 英文版免互链头', () => {
    const files = new Map([['docs/a.md', bare], ['docs/a.zh-CN.md', `${ZH('a')}\n\n不要从本页复制`]]);
    expect(rules(snap({ files, payload: ['docs/a.md'] }))).not.toContain(2);
  });

  it('免了互链头但**缺横幅 → 硬伤**', () => {
    const files = new Map([['docs/a.md', bare], ['docs/a.zh-CN.md', ZH('a')]]);
    const f = lint(snap({ files, payload: ['docs/a.md'] }));
    expect(f.some((x) => x.rule === 3 && x.severity === 'hard')).toBe(true);
  });

  it('没登记的文件不享受例外', () => {
    const files = new Map([['docs/a.md', bare], ['docs/a.zh-CN.md', ZH('a')]]);
    expect(rules(snap({ files }))).toContain(2);
  });

  it('**登记项必须带 docs/ 前缀**（老脚本是 grep -qxF，整行逐字节）', () => {
    // 我上一版把「老脚本查两个**文件位置**」（docs/.payload 和 .payload）
    // 误读成「两种**路径写法**」，于是额外接受剥掉前缀的写法 —— 那是放宽豁免面。
    // 两个文件位置由 snapshot.ts 负责合并，与路径写法无关。
    const files = new Map([['docs/a.md', bare], ['docs/a.zh-CN.md', `${ZH('a')}\n\n不要从本页复制`]]);
    expect(rules(snap({ files, payload: ['a.md'] }))).toContain(2);
    expect(rules(snap({ files, payload: ['docs/a.md'] }))).not.toContain(2);
  });

  it('中文版的互链头**照样要查** —— 例外只免英文版', () => {
    const files = new Map([['docs/a.md', bare], ['docs/a.zh-CN.md', '没有互链头\n\n不要从本页复制']]);
    expect(lint(snap({ files, payload: ['docs/a.md'] })).some((f) => f.rule === 2)).toBe(true);
  });
});

describe('规则 4 · 断图', () => {
  it('图在仓里 → 过', () => {
    const files = new Map([['docs/a.md', `${EN('a')}\n\n![x](assets/a.png)`], ['docs/a.zh-CN.md', ZH('a')]]);
    expect(rules(snap({ files, assets: new Set(['assets/a.png']) }))).not.toContain(4);
  });

  it('图不在仓里 → 硬伤，subject 是图片路径', () => {
    const files = new Map([['docs/a.md', `${EN('a')}\n\n![x](assets/gone.png)`], ['docs/a.zh-CN.md', ZH('a')]]);
    expect(lint(snap({ files }))).toContainEqual({ rule: 4, severity: 'hard', subject: 'assets/gone.png', message: '断图：assets/gone.png' });
  });

  it('**HTML <img src> 也查**（刻意改进；老脚本只认 markdown 语法）', () => {
    const files = new Map([['docs/a.md', `${EN('a')}\n\n<img src="assets/gone.png" width="600">`], ['docs/a.zh-CN.md', ZH('a')]]);
    expect(lint(snap({ files })).some((f) => f.rule === 4)).toBe(true);
  });

  it('**写在 inline code 里的路径不算引用** —— SPEC 那次的假断图', () => {
    const files = new Map([
      ['docs/a.md', `${EN('a')}\n\n规则检查 \`![图](assets/example.png)\` 这种写法。`],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    expect(rules(snap({ files }))).not.toContain(4);
  });

  it('两处引用同一张缺失的图 → 只报一条', () => {
    const files = new Map([
      ['docs/a.md', `${EN('a')}\n\n![x](assets/g.png)\n![y](assets/g.png)`],
      ['docs/a.zh-CN.md', `${ZH('a')}\n\n![x](assets/g.png)`],
    ]);
    expect(lint(snap({ files })).filter((f) => f.rule === 4)).toHaveLength(1);
  });
});

describe('规则 5 · 语言方向按比例（新增，警告）', () => {
  it('方向对 → 过', () => expect(rules(snap())).not.toContain(5));

  it('**整篇翻反 → 报**，且严重度是警告不是硬伤（D5）', () => {
    const files = new Map([
      ['docs/a.md', `**English** · [中文](a.zh-CN.md)\n\n这份英文版里全是中文正文，方向反了。`],
      ['docs/a.zh-CN.md', `[English](a.md) · **中文**\n\nThis Chinese version is entirely English prose.`],
    ]);
    const f = lint(snap({ files })).filter((x) => x.rule === 5);
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.severity === 'warn')).toBe(true);
    expect(hasHard(lint(snap({ files })))).toBe(false);
  });

  it('术语表/专名那种中英混排的英文版**不误报**', () => {
    const files = new Map([
      ['docs/a.md', `${EN('a', '\n\nThe folder repo is 敕草仓 and an annotation is 涂归. Everything else is English prose that goes on for a while.')}`],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    expect(rules(snap({ files }))).not.toContain(5);
  });

  it('代码块里的中文不算进英文版占比', () => {
    const files = new Map([
      ['docs/a.md', `${EN('a')}\n\n\`\`\`ts\n// 这里全是中文注释\nconst 变量 = 1;\n\`\`\``],
      ['docs/a.zh-CN.md', ZH('a')],
    ]);
    expect(rules(snap({ files }))).not.toContain(5);
  });
});

describe('规则 6 · 分支基点（警告，刻意不阻断）', () => {
  it('从最新 main 切 → 过', () => expect(rules(snap())).not.toContain(6));

  it('落后 main → 警告，**不是硬伤**（pre-push 教训：拦太死把人逼向绕过）', () => {
    const f = lint(snap({ base: { behind: 3, fetchFailed: false } }));
    expect(f).toContainEqual({ rule: 6, severity: 'warn', subject: 'HEAD', message: expect.stringContaining('落后 main 3') });
    expect(hasHard(f)).toBe(false);
  });
});

describe('规则 7 · 改动了 main 上已有的文档（警告）', () => {
  it('全是新文档 → 过', () => expect(rules(snap())).not.toContain(7));

  it('有已在 main 上的 → 警告', () => {
    const f = lint(snap({ onMain: new Set(['docs/a.md']) }));
    expect(f.some((x) => x.rule === 7 && x.severity === 'warn' && x.subject === 'docs/a.md')).toBe(true);
  });
});

describe('规则 8 · PR body 五段（按标题匹配，警告）', () => {
  const good = ['目的地', '直达链', 'TLDR', '待你拍板', '怎么用'].map((s) => `## ${s}\n\n内容`).join('\n\n');

  it('五段齐 → 过', () => expect(rules(snap({ body: good }))).not.toContain(8));

  it('缺一段 → 警告，不阻断（R6：SKILL.md 说「也拦」是文档错了）', () => {
    const f = lint(snap({ body: good.replace('## 待你拍板\n\n内容', '') }));
    expect(f).toContainEqual({ rule: 8, severity: 'warn', subject: '待你拍板', message: expect.stringContaining('待你拍板') });
    expect(hasHard(f)).toBe(false);
  });

  it('**段名只在正文里提一句不算过**（老脚本 grep 整个 body 就算过）', () => {
    const body = good.replace('## 怎么用\n\n内容', '正文里提到怎么用，但没有这个标题');
    expect(lint(snap({ body })).some((f) => f.rule === 8 && f.subject === '怎么用')).toBe(true);
  });

  it('不传 body（巡检场景）→ 不查这条', () => expect(rules(snap())).not.toContain(8));
});

describe('规则 9 · fetch 失败（警告）', () => {
  it('fetch 成功 → 过', () => expect(rules(snap())).not.toContain(9));

  it('**fetch 失败要报** —— 老脚本 `|| true` 静默继续，结论建在陈旧 main 上', () => {
    const f = lint(snap({ base: { behind: 0, fetchFailed: true } }));
    expect(f[0]).toEqual({ rule: 9, severity: 'warn', subject: 'origin', message: expect.stringContaining('fetch 失败') });
  });

  it('它排在最前面 —— 它决定下面所有相对 main 的结论可不可信', () => {
    const f = lint(snap({ base: { behind: 2, fetchFailed: true }, onMain: new Set(['docs/a.md']) }));
    expect(f[0]!.rule).toBe(9);
  });
});

describe('helper', () => {
  it('slugsOf 去重且排序', () => {
    expect(slugsOf(['docs/b.md', 'docs/a.zh-CN.md', 'docs/a.md'])).toEqual(['docs/a', 'docs/b']);
  });

  it('cjkRatio 分母排除空白/标点/数字', () => {
    expect(cjkRatio('中文')).toBe(1);
    expect(cjkRatio('abcd')).toBe(0);
    // 「，。！」不该把占比拉低
    expect(cjkRatio('中文，正文。')).toBe(1);
  });

  it('cjkRatio 空内容不除以零', () => expect(cjkRatio('   \n\n')).toBe(0));

  it('assetRefs 同时认 markdown 与 <img>，并去重', () => {
    expect(assetRefs('![a](assets/x.png) <img src=assets/x.png> <IMG SRC="assets/y.png">').sort())
      .toEqual(['assets/x.png', 'assets/y.png']);
  });

  it('headings 不把代码块里的 ## 当标题', () => {
    expect(headings('# 真标题\n\n```\n## 假标题\n```')).toEqual(['真标题']);
  });
});
