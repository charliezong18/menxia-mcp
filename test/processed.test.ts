import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, save, mark, seed, idsFor, storePath, DEFAULT_STORE } from '../src/processed.js';

// 「已处理」放本地不放 GitHub（review#29）。核心不变量：
// **失效方向永远是多报** —— 读不到、格式坏、换机器，结果都是「全部未处理」，
// 绝不静默把他的话吞成已答。

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zhupi-state-')); file = join(dir, 'processed.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('读不到一律当空 —— 失效方向必须是多报', () => {
  it('文件不存在 → 空（全部未处理）', () => {
    expect(load(join(dir, 'nope.json'))).toEqual({});
  });

  it('坏 JSON → 空，不抛异常', () => {
    writeFileSync(file, '{ 这不是 json');
    expect(load(file)).toEqual({});
  });

  it('顶层是数组 / 字符串 / null → 空', () => {
    for (const bad of ['[1,2,3]', '"str"', 'null', '42']) {
      writeFileSync(file, bad);
      expect(load(file)).toEqual({});
    }
  });

  it('值不是数组的键被丢掉，其余保留', () => {
    writeFileSync(file, JSON.stringify({ '9': [1, 2], '7': 'oops', '8': null }));
    expect(load(file)).toEqual({ '9': [1, 2] });
  });

  it('数组里的非数字被过滤 —— 不让脏数据变成「已处理」', () => {
    writeFileSync(file, JSON.stringify({ '9': [1, 'x', null, 2.5, 3] }));
    expect(load(file)['9']).toEqual([1, 2.5, 3]);
  });
});

describe('mark', () => {
  it('如实返回真正新增的，不谎报', () => {
    const a = mark({}, 9, [100, 200]);
    expect(a.added).toEqual([100, 200]);
    const b = mark(a.store, 9, [200, 300]);
    expect(b.added).toEqual([300]); // 200 已在，不重复计
  });

  it('重复标记不改变 store 引用（省一次写盘）', () => {
    const a = mark({}, 9, [100]);
    const b = mark(a.store, 9, [100]);
    expect(b.added).toEqual([]);
    expect(b.store).toBe(a.store);
  });

  it('挡掉非正整数 id', () => {
    expect(mark({}, 9, [0, -1, 1.5, NaN, 7]).added).toEqual([7]);
  });

  it('不同折互不干扰', () => {
    let s = mark({}, 9, [1]).store;
    s = mark(s, 18, [2]).store;
    expect(idsFor(s, 9)).toEqual(new Set([1]));
    expect(idsFor(s, 18)).toEqual(new Set([2]));
  });

  it('id 排序存放，便于人读 diff', () => {
    expect(mark({}, 9, [300, 100, 200]).store['9']).toEqual([100, 200, 300]);
  });
});

describe('seed（灌水位清积压）', () => {
  it('把当前全部 id 一次记成已处理', () => {
    const s = seed({}, 18, [5110486334, 5113864010, 5113898663]);
    expect(idsFor(s, 18).size).toBe(3);
  });

  it('灌过之后新来的仍然浮上来 —— 自愈', () => {
    const s = seed({}, 18, [1, 2]);
    expect(idsFor(s, 18).has(3)).toBe(false);
  });
});

describe('存盘往返', () => {
  it('save 之后 load 得到同样内容', () => {
    const s = mark({}, 9, [1, 2]).store;
    save(s, file);
    expect(load(file)).toEqual(s);
  });

  it('目录不存在时自动建', () => {
    const deep = join(dir, 'a', 'b', 'processed.json');
    save({ '9': [1] }, deep);
    expect(load(deep)).toEqual({ '9': [1] });
  });
});

describe('存放位置', () => {
  it('默认在家目录下的 .zhupi-mcp/', () => {
    expect(DEFAULT_STORE).toMatch(/\.zhupi-mcp\/processed\.json$/);
  });

  it('可用 ZHUPI_STATE_FILE 覆盖（测试与多机场景用）', () => {
    expect(storePath({ ZHUPI_STATE_FILE: '/tmp/x.json' } as NodeJS.ProcessEnv)).toBe('/tmp/x.json');
  });

  it('不是全局单指针 —— 只是家目录下的状态文件，不进 PATH 不进 /usr/local', () => {
    expect(DEFAULT_STORE).not.toContain('/usr/local');
  });
});
