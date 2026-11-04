import { describe, it, expect } from 'vitest';
import { lint, cjkRatio, hasProse, assetRefs, type Snapshot, type Finding } from '../src/lint.js';

// HARDENING-2026-11 · 体例规则的边界（L1–L5）。纯快照，无 IO。
// 规则 1（双语对）/ 2（互链头）/ 4（assets 布局）/ 5（CJK 占比）。

const EN = (slug: string, rest = '\n\nAll prose here is English.') => `**English** · [中文](${slug}.zh-CN.md)${rest}`;
const ZH = (slug: string, rest = '\n\n这里全是中文正文，占比足够高。') => `[English](${slug}.md) · **中文**${rest}`;

function snap(files: Array<[string, string]>, over: Partial<Snapshot> = {}): Snapshot {
  const m = new Map(files);
  return {
    files: m,
    changed: over.changed ?? [...m.keys()],
    assets: over.assets ?? new Set(),
    payload: over.payload ?? [],
    monolingual: over.monolingual ?? [],
    onMain: over.onMain ?? new Set(),
    base: over.base ?? { behind: 0, fetchFailed: false },
  };
}
const by = (fs: Finding[], rule: number): Finding[] => fs.filter((f) => f.rule === rule);

describe('规则 1/2 · 双语互链头的边界', () => {
  it('BOM + CRLF：照过（Windows 编辑器存出来的常见形态）', () => {
    const f = lint(snap([
      ['docs/a.md', `﻿${EN('a')}`.replace(/\n/g, '\r\n')],
      ['docs/a.zh-CN.md', ZH('a').replace(/\n/g, '\r\n')],
    ]));
    expect(by(f, 2)).toEqual([]);
    expect(by(f, 1)).toEqual([]);
  });

  it('互链头不在第一行（前面空了一行）→ 硬伤，实为报「(空行)」', () => {
    const f = by(lint(snap([['docs/a.md', `\n${EN('a')}`], ['docs/a.zh-CN.md', ZH('a')]])), 2);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('hard');
    expect(f[0]!.message).toContain('(空行)');
  });

  it('链接带 title / 带 ./ → 点得到，只警告不拦', () => {
    const f = by(lint(snap([
      ['docs/a.md', '**English** · [中文](./a.zh-CN.md "中文版")\n\nEnglish prose.'],
      ['docs/a.zh-CN.md', ZH('a')],
    ])), 2);
    expect(f.map((x) => x.severity)).toEqual(['warn']);
  });

  it('链到**别的**文档的中文版 → 硬伤（点得到，但不是对面）', () => {
    const f = by(lint(snap([['docs/a.md', EN('b')], ['docs/a.zh-CN.md', ZH('a')]])), 2);
    expect(f.map((x) => x.severity)).toEqual(['hard']);
  });

  it('子目录文档：互链头按**自己所在目录**写（`a.zh-CN.md`），写成 `sub/a.zh-CN.md` 反而是断链', () => {
    const ok = lint(snap([['docs/sub/a.md', EN('a')], ['docs/sub/a.zh-CN.md', ZH('a')]]));
    expect(by(ok, 2)).toEqual([]);
    const bad = lint(snap([['docs/sub/a.md', EN('sub/a')], ['docs/sub/a.zh-CN.md', ZH('a')]]));
    expect(by(bad, 2).map((x) => x.severity)).toEqual(['hard']);
  });

  it('L1 · 译本后缀写成 .zh-cn.md → 直说是后缀大小写，**不**报「缺 a.zh-cn.zh-CN.md」', () => {
    const f = lint(snap([['docs/a.md', EN('a')], ['docs/a.zh-cn.md', ZH('a')]]));
    const msgs = by(f, 1).map((x) => x.message).join('\n');
    expect(msgs).toContain('.zh-CN.md（大小写一致）');
    expect(msgs).not.toContain('a.zh-cn.zh-CN.md');
    expect(f.some((x) => x.severity === 'hard')).toBe(true); // a.md 仍然缺真正的中文对子
  });

  it('.monolingual 登记任意一半即免双语对（登记英文名、只交中文版也算）', () => {
    expect(by(lint(snap([['docs/a.zh-CN.md', ZH('a')]], { monolingual: ['docs/a.md'] })), 1)).toEqual([]);
  });

  it('两个同名 slug 在不同目录（docs/a 与 docs/assets/a）各算各的', () => {
    const f = by(lint(snap([['docs/a.md', EN('a')], ['docs/a.zh-CN.md', ZH('a')], ['docs/assets/a.md', EN('a')]])), 1);
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain('缺中文版');
  });
});

describe('L5 · assets 布局里的 .md 也要中文对子', () => {
  it('docs/assets/notes.md 没有 notes.zh-CN.md → 规则 1 硬伤', () => {
    const f = by(lint(snap([['docs/a.md', EN('a')], ['docs/a.zh-CN.md', ZH('a')], ['docs/assets/notes.md', EN('notes')]])), 1);
    expect(f).toEqual([{ rule: 1, severity: 'hard', subject: 'notes', message: expect.stringContaining('notes 缺中文版 docs/assets/notes.zh-CN.md') }]);
  });

  it('只有 docs/assets/notes.zh-CN.md → 也报（双向）', () => {
    const f = by(lint(snap([['docs/assets/notes.zh-CN.md', ZH('notes')]])), 1);
    expect(f[0]!.message).toContain('缺英文版');
  });

  it('对子齐、互链头按 assets 目录内相对写 → 干净', () => {
    expect(lint(snap([['docs/assets/notes.md', EN('notes')], ['docs/assets/notes.zh-CN.md', ZH('notes')]]))).toEqual([]);
  });

  it('assets 里 md 引用的图按 docs/assets/ 解析：写 `assets/p.png` 会落到 docs/assets/assets/p.png', () => {
    const f = by(lint(snap(
      [['docs/assets/notes.md', EN('notes', '\n\n![p](assets/p.png)\n\nEnglish.')], ['docs/assets/notes.zh-CN.md', ZH('notes')]],
      { assets: new Set(['docs/assets/p.png']) },
    )), 4);
    expect(f.map((x) => x.subject)).toEqual(['assets/assets/p.png']);
  });

  it('.mmd / .png 这类非 md 素材不进双语规则', () => {
    const f = lint(snap([['docs/a.md', EN('a')], ['docs/a.zh-CN.md', ZH('a')]], { changed: ['docs/a.md', 'docs/a.zh-CN.md'] }));
    expect(f).toEqual([]);
  });
});

describe('规则 4 · assets 两种布局不塌成一个键', () => {
  const pair = (enRest: string): Array<[string, string]> => [['docs/a.md', EN('a', enRest)], ['docs/a.zh-CN.md', ZH('a')]];

  it('仓根布局 `../assets/<proj>/p.png` → 认得出，在就过', () => {
    expect(by(lint(snap(pair('\n\n![x](../assets/glacier/p.png)\n\nEnglish.'), { assets: new Set(['assets/glacier/p.png']) })), 4)).toEqual([]);
  });

  it('图在 docs/assets/p.png、正文写 ../assets/p.png（指向仓根）→ 断图，报仓根路径', () => {
    const f = by(lint(snap(pair('\n\n![x](../assets/p.png)\n\nEnglish.'), { assets: new Set(['docs/assets/p.png']) })), 4);
    expect(f.map((x) => x.subject)).toEqual(['assets/p.png']);
  });

  it('图在仓根 assets/p.png、正文写 assets/p.png（指向 docs/assets）→ 断图', () => {
    const f = by(lint(snap(pair('\n\n![x](assets/p.png)\n\nEnglish.'), { assets: new Set(['assets/p.png']) })), 4);
    expect(f).toHaveLength(1);
  });

  it('L4 · 尖括号目标 `![x](<assets/a b.png>)` 也要提取 —— 上一版整条漏掉，断图不报', () => {
    expect(assetRefs('![x](<assets/a b.png>)')).toEqual(['assets/a b.png']);
    const f = by(lint(snap(pair('\n\n![x](<assets/a b.png>)\n\nEnglish.'))), 4);
    expect(f.map((x) => x.subject)).toEqual(['assets/a b.png']);
  });

  it('L4 · `?raw=true` 查询串不是文件名 —— 图在就别报断图', () => {
    expect(assetRefs('![x](assets/p.png?raw=true)')).toEqual(['assets/p.png']);
    expect(by(lint(snap(pair('\n\n![x](assets/p.png?raw=true)\n\nEnglish.'), { assets: new Set(['docs/assets/p.png']) })), 4)).toEqual([]);
  });

  it('代码块里的引用不算（疤：一篇讲 lint 的文档过不了 lint）', () => {
    expect(by(lint(snap(pair('\n\n```\n![x](assets/nope.png)\n```\n\nEnglish.'))), 4)).toEqual([]);
  });

  it('`../../assets/` 越出仓根 → 折叠后仍按仓根比，不崩', () => {
    expect(() => lint(snap(pair('\n\n![x](../../assets/p.png)\n\nEnglish.')))).not.toThrow();
  });
});

describe('规则 5 · CJK 占比警告的边界', () => {
  /** 造一份 zh 文档，使「有意义字符」里 CJK 恰好 cjk 个、拉丁 latin 个（互链头也算进去）。 */
  const zhWith = (cjk: number, latin: number): string => {
    // 头 `[English](a.md) · **中文**` 贡献 English(7)+amd(3)=10 拉丁、2 CJK
    const body = '中'.repeat(cjk - 2) + ' ' + 'x'.repeat(latin - 10);
    return `[English](a.md) · **中文**\n\n${body}`;
  };

  it('恰好 30% → 不报（阈值是 < 30%）', () => {
    const zh = zhWith(30, 70);
    expect(cjkRatio(zh)).toBeCloseTo(0.3, 5);
    expect(by(lint(snap([['docs/a.md', EN('a')], ['docs/a.zh-CN.md', zh]])), 5)).toEqual([]);
  });

  it('29% → 报中文版', () => {
    const zh = zhWith(29, 71);
    expect(by(lint(snap([['docs/a.md', EN('a')], ['docs/a.zh-CN.md', zh]])), 5).map((x) => x.subject)).toEqual(['docs/a.zh-CN.md']);
  });

  it('英文版恰好 30% 不报、31% 报（阈值是 > 30%）', () => {
    // 头 `**English** · [中文](a.zh-CN.md)` 贡献 English(7)+azhCNmd(7)=14 拉丁、2 CJK
    const en = (cjk: number, latin: number) => `**English** · [中文](a.zh-CN.md)\n\n${'中'.repeat(cjk - 2)} ${'x'.repeat(latin - 14)}`;
    expect(by(lint(snap([['docs/a.md', en(30, 70)], ['docs/a.zh-CN.md', ZH('a')]])), 5)).toEqual([]);
    expect(by(lint(snap([['docs/a.md', en(31, 69)], ['docs/a.zh-CN.md', ZH('a')]])), 5).map((x) => x.subject)).toEqual(['docs/a.md']);
  });

  it('L3 · 中文版里的长 URL 链接不稀释占比（读者看到的是链接文字）', () => {
    const links = Array.from({ length: 6 }, (_, i) => `- [第${i}折](https://github.com/charliezong18/review/pull/${100 + i})`).join('\n');
    const zh = `[English](a.md) · **中文**\n\n索引：\n\n${links}\n\n<https://menxia-reader.github.io/menxia/?pr=61>`;
    expect(cjkRatio(zh)).toBeGreaterThan(0.3);
    expect(by(lint(snap([['docs/a.md', EN('a')], ['docs/a.zh-CN.md', zh]])), 5)).toEqual([]);
  });

  it('L3 · 引用式链接定义 `[x]: https://…` 也不计入', () => {
    const zh = `[English](a.md) · **中文**\n\n见[上一折][p]。\n\n[p]: https://github.com/charliezong18/review/pull/61/files#diff-aaaaaaaaaaaaaaaaaaaaaaaa`;
    expect(cjkRatio(zh)).toBeGreaterThan(0.3);
  });

  it('L2 · 只有图 / 只有代码的文档判不了语言 → 不报 0%', () => {
    // 体例强制的互链头本身就有字（English / 中文）—— 判「有没有正文」时不算它。
    const imgOnly = ZH('a', '\n\n![图](assets/p.png)\n\n```\ncode only\n```');
    expect(hasProse(imgOnly)).toBe(false);
    expect(cjkRatio(imgOnly)).toBeLessThan(0.3); // 上一版就是拿这个数报了一条假警告
    const f = lint(snap([['docs/a.md', EN('a')], ['docs/a.zh-CN.md', imgOnly]], { assets: new Set(['docs/assets/p.png']) }));
    expect(by(f, 5)).toEqual([]);
  });

  it('日文假名也算 CJK（不把日文译本误报成「中文版里没中文」）', () => {
    expect(cjkRatio('これはテストです')).toBe(1);
  });

  it('代码块里的英文不算进中文版的分母', () => {
    const zh = ZH('a', '\n\n中文说明。\n\n```ts\nconst aVeryLongEnglishIdentifier = somethingElseEntirely();\n```');
    expect(by(lint(snap([['docs/a.md', EN('a')], ['docs/a.zh-CN.md', zh]])), 5)).toEqual([]);
  });

  it('.payload 的英文版是中文 → 不报；它的中文版仍照查', () => {
    const f = lint(snap(
      [['docs/a.md', '各位好：这是要发出去的中文正文。'], ['docs/a.zh-CN.md', '[English](a.md) · **中文**\n\nAll English here and a lot more English words to sink the ratio.\n\n不要从本页复制']],
      { payload: ['docs/a.md'] },
    ));
    expect(by(f, 5).map((x) => x.subject)).toEqual(['docs/a.zh-CN.md']);
  });
});
