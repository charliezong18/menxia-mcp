import { describe, it, expect } from 'vitest';
import { stripCode } from '../src/strip.js';

// 这个 helper 错了会让断图检查和语言方向检查**同时**误判，方向相反
// （剥多了 → 断图漏报；剥少了 → 语言方向误报）。两个方向都不容易靠观察发现。

const kept = (md: string) => stripCode(md).replace(/\s+/g, ' ').trim();

describe('保持字符数不变（调用方要报行号）', () => {
  it('长度和行数都不变', () => {
    const md = 'a\n```\ncode\n```\nb `x` c';
    const s = stripCode(md);
    expect(s.length).toBe(md.length);
    expect(s.split('\n').length).toBe(md.split('\n').length);
  });

  it('删掉而不是留白会让行号错位 —— 这里断言不会', () => {
    const md = '```\nx\n```\n![图](assets/a.png)';
    expect(stripCode(md).split('\n')[3]).toContain('assets/a.png');
  });
});

describe('fenced code block', () => {
  it('剥掉围栏内的内容，也剥掉带 info string 的围栏行', () => {
    expect(kept('前\n```ts\nconst 中文 = 1;\n```\n后')).toBe('前 后');
  });

  it('`~~~` 围栏同样算', () => {
    expect(kept('前\n~~~\n中文\n~~~\n后')).toBe('前 后');
  });

  it('**``` 不能被 ~~~ 关掉** —— 混用时不许提前收工', () => {
    // 若错误地互相关闸，`应该还在代码里` 会被当成正文
    expect(kept('前\n```\n~~~\n应该还在代码里\n```\n后')).toBe('前 后');
  });

  it('**代码块套代码块**：```` 里的 ``` 是内容不是关闸', () => {
    expect(kept('前\n````\n```\n里层\n```\n````\n后')).toBe('前 后');
  });

  it('关闸围栏比开闸长也算关（CommonMark：不短于即可）', () => {
    expect(kept('前\n```\nx\n`````\n后')).toBe('前 后');
  });

  it('**围栏没关就剥到末尾** —— 宁可断图漏报，也不要语言方向误报', () => {
    expect(kept('前\n```\n没关\n中文正文')).toBe('前');
  });

  it('围栏可以有最多 3 个前导空格', () => {
    expect(kept('前\n   ```\nx\n   ```\n后')).toBe('前 后');
  });

  it('4 个前导空格不是围栏（那是缩进代码块的范围，本 helper 不管）', () => {
    expect(stripCode('    ```\nx')).toContain('```');
  });
});

describe('inline code', () => {
  it('单反引号', () => {
    expect(kept('看 `assets/a.png` 这个')).toBe('看 这个');
  });

  it('双反引号里可以含单反引号', () => {
    expect(kept('前 ``a ` b`` 后')).toBe('前 后');
  });

  it('**长度必须配对**：`` 开的不能被单个 ` 关掉', () => {
    // 若按最短匹配，`x` 会被误认为闭合，导致后面的正文被当代码剥掉
    expect(kept('前 ``x`` 后 `y` 尾')).toBe('前 后 尾');
  });

  it('没闭合的反引号是正文，不吃掉后面的内容', () => {
    expect(kept('前 `没闭合 后面还有正文')).toContain('后面还有正文');
  });

  it('一行里多段', () => {
    expect(kept('`a` 和 `b` 与 `c`')).toBe('和 与');
  });

  it('**不跨行**（刻意的取舍，别当 bug 修）', () => {
    // 跨行 inline code 需要整篇扫描，会把「行号」搞复杂；这个仓的文档里没有这种写法
    expect(kept('前 `开\n闭` 后')).toContain('前');
  });
});

describe('两条规则真实会撞到的形状', () => {
  it('SPEC 那次的病历：写在 inline code 里的图片路径**不算引用**', () => {
    const md = '规则 4 检查的是 `![图](assets/example.png)` 这种写法。\n\n![真图](assets/real.png)';
    const s = stripCode(md);
    expect(s).not.toContain('assets/example.png');   // 例子被剥掉 → 不报假断图
    expect(s).toContain('assets/real.png');          // 真引用还在 → 该报的仍报
  });

  it('代码块里的中文注释不算进正文 CJK 占比', () => {
    const md = 'All prose here is English.\n\n```ts\n// 这里全是中文注释，占比会把英文版判成翻反了\nconst 变量 = 1;\n```\n';
    expect(/[一-鿿]/.test(stripCode(md))).toBe(false);
  });
});
