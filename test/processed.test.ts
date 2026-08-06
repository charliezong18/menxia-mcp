import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_STORE, commit, commitUnmark, handledIds, load, mark, save, storePath, unmark,
} from '../src/processed.js';

// 「已处理」放本地不放 GitHub（review#29）。两条不变量，第一轮评审在这两条上各抓了一个高危：
//   ① **失效方向永远是多报** —— 读不到就当全部未处理，绝不静默把他的话吞成已答。
//      而且**写路径也得成立**：拿读失败的空基线覆写会把别的折全抹掉。
//   ② **他改了那条判就要重新浮上来** —— 只记 id 认不出原地编辑。

let dir: string, file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zhupi-state-')); file = join(dir, 'processed.json'); });
afterEach(() => { try { chmodSync(file, 0o600); } catch { /* 可能不存在 */ } rmSync(dir, { recursive: true, force: true }); });

const E = (id: number, at = '2026-07-29T10:00:00Z') => ({ id, updatedAt: at });

describe('load：分清「不存在」和「读不出来」', () => {
  it('文件不存在 → 空，且 unreadable=false（合法的第一次运行）', () => {
    expect(load(join(dir, 'nope.json'))).toEqual({ store: {}, unreadable: false });
  });

  it('坏 JSON → 空，但 unreadable=true', () => {
    writeFileSync(file, '{ 这不是 json');
    expect(load(file)).toEqual({ store: {}, unreadable: true });
  });

  it('半截写入（模拟写一半被杀）→ unreadable=true', () => {
    save({ '9': { '1': 'a' }, '18': { '2': 'b' } }, file);
    writeFileSync(file, readFileSync(file, 'utf8').slice(0, 12));
    expect(load(file).unreadable).toBe(true);
  });

  it('没权限读 → unreadable=true，不当成空文件', () => {
    save({ '9': { '1': 'a' } }, file);
    chmodSync(file, 0o000);
    const r = load(file);
    // root 跑测试时 chmod 挡不住，那种环境跳过断言
    if (r.store['9'] === undefined) expect(r.unreadable).toBe(true);
  });

  it('顶层是数组 / 字符串 / null → 空 + unreadable', () => {
    for (const bad of ['[1,2,3]', '"str"', 'null', '42']) {
      writeFileSync(file, bad);
      expect(load(file)).toEqual({ store: {}, unreadable: true });
    }
  });

  it('值不是对象的折被丢掉（含旧的数组格式），其余保留', () => {
    writeFileSync(file, JSON.stringify({ '9': { '1': 'a' }, '7': [1, 2], '8': 'x', '6': null }));
    expect(Object.keys(load(file).store)).toEqual(['9']);
  });

  it('__proto__ 键不会把返回值的原型换掉 —— 否则下游抛 TypeError 且抛在 try 之外', () => {
    writeFileSync(file, '{"9":{"1":"a"},"__proto__":{"7":"b"}}');
    const { store } = load(file);
    expect(Array.isArray(Object.getPrototypeOf(store))).toBe(false);
    expect(() => handledIds(store, 0, [E(7)])).not.toThrow();
    expect(handledIds(store, 0, [E(7)]).size).toBe(0);
  });

  it('非法 id 键 / 非字符串时间戳被滤掉', () => {
    writeFileSync(file, JSON.stringify({ '9': { '0': 'a', '-1': 'a', 'x': 'a', '5': 123, '7': 'ok' } }));
    expect(Object.keys(load(file).store['9']!)).toEqual(['7']);
  });
});

describe('commit：读不出来时**拒绝写**（否则一次瞬时读失败 = 永久全量清零）', () => {
  it('坏文件 → commit 抛错，且原文件一个字节没动', () => {
    const broken = '{ 坏了';
    writeFileSync(file, broken);
    expect(() => commit(30, [E(1)], file)).toThrow(/读不出来|拒绝写入/);
    expect(readFileSync(file, 'utf8')).toBe(broken);
  });

  it('**多折 store 攒了几周，一次读失败不能把它们抹掉**（第一轮评审那条高危）', () => {
    const weeks = { '7': { '71': 'a' }, '9': { '91': 'a' }, '18': { '181': 'a' }, '29': { '291': 'a' } };
    save(weeks, file);
    writeFileSync(file, readFileSync(file, 'utf8').slice(0, 40)); // 半截
    expect(() => commit(30, [E(301)], file)).toThrow();
    writeFileSync(file, JSON.stringify(weeks)); // 人工修好之后
    commit(30, [E(301)], file);
    expect(Object.keys(load(file).store).sort()).toEqual(['18', '29', '30', '7', '9']);
  });

  it('正常路径：其他折全部存活', () => {
    save({ '7': { '71': 'a' }, '9': { '91': 'a' } }, file);
    commit(18, [E(181)], file);
    const { store } = load(file);
    expect(Object.keys(store).sort()).toEqual(['18', '7', '9']);
    expect(store['7']).toEqual({ '71': 'a' });
  });

  it('落盘前重读合并 —— 不用调用方的旧快照覆盖别人刚写的', () => {
    save({}, file);
    const stale = load(file).store;          // 拿到快照
    commit(9, [E(91)], file);                // 另一个「进程」写了
    expect(stale).toEqual({});               // 我手里的快照还是空的
    commit(18, [E(181)], file);              // 我再写
    expect(Object.keys(load(file).store).sort()).toEqual(['18', '9']); // 两边都在
  });

  it('save 是原子的：临时文件不留在目录里', () => {
    commit(9, [E(91)], file);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('handledIds：他改过就重新变 pending', () => {
  const store = { '18': { '100': '2026-07-29T10:00:00Z' } };

  it('记过且没动过 → handled', () => {
    expect(handledIds(store, 18, [E(100, '2026-07-29T10:00:00Z')])).toEqual(new Set([100]));
  });

  it('**他原地编辑（updated_at 变新）→ 重新 pending**', () => {
    expect(handledIds(store, 18, [E(100, '2026-07-29T18:00:00Z')]).size).toBe(0);
  });

  it('时间戳变旧（时钟乱了）仍算 handled —— 不因为怪数据反复刷屏', () => {
    expect(handledIds(store, 18, [E(100, '2026-07-01T00:00:00Z')])).toEqual(new Set([100]));
  });

  it('没记过的 → 不 handled', () => {
    expect(handledIds(store, 18, [E(999)]).size).toBe(0);
  });

  it('折号不在记录里 → 全部 pending', () => {
    expect(handledIds(store, 99, [E(100)]).size).toBe(0);
  });
});

describe('mark（纯函数）', () => {
  it('新记的进 added', () => {
    expect(mark({}, 9, [E(1), E(2)]).added).toEqual([1, 2]);
  });

  it('他改过之后再标 → 进 refreshed，不是 alreadyHandled', () => {
    const a = mark({}, 9, [E(1, '2026-07-29T10:00:00Z')]);
    const b = mark(a.store, 9, [E(1, '2026-07-29T18:00:00Z')]);
    expect(b.added).toEqual([]);
    expect(b.refreshed).toEqual([1]);
    expect(b.store['9']!['1']).toBe('2026-07-29T18:00:00Z');
  });

  it('原封不动地重标 → 两个都空，且 store 引用不变（省一次写盘）', () => {
    const a = mark({}, 9, [E(1)]);
    const b = mark(a.store, 9, [E(1)]);
    expect([b.added, b.refreshed]).toEqual([[], []]);
    expect(b.store).toBe(a.store);
  });

  it('**同一次调用里的重复 id 只算一次** —— 否则会报「记了 3 条」而其实 2 条', () => {
    expect(mark({}, 9, [E(1), E(1), E(2)]).added).toEqual([1, 2]);
  });

  it('挡掉非正整数 id', () => {
    expect(mark({}, 9, [E(0), E(-1), E(1.5), E(NaN), E(7)]).added).toEqual([7]);
  });

  it('不同折互不干扰', () => {
    const s = mark(mark({}, 9, [E(1)]).store, 18, [E(2)]).store;
    expect([handledIds(s, 9, [E(1)]).size, handledIds(s, 18, [E(2)]).size]).toEqual([1, 1]);
  });
});

describe('unmark：唯一的写操作必须有回退', () => {
  it('撤掉之后重新变 pending', () => {
    const s = mark({}, 9, [E(1), E(2)]).store;
    const u = unmark(s, 9, [1]);
    expect(u.removed).toEqual([1]);
    expect(handledIds(u.store, 9, [E(1), E(2)])).toEqual(new Set([2]));
  });

  it('撤没记过的 → removed 为空，如实反映', () => {
    expect(unmark(mark({}, 9, [E(1)]).store, 9, [999]).removed).toEqual([]);
  });

  it('commitUnmark 落盘，其他折不受影响', () => {
    save({ '7': { '71': 'a' } }, file);
    commit(9, [E(91)], file);
    expect(commitUnmark(9, [91], file).removed).toEqual([91]);
    const { store } = load(file);
    expect(store['7']).toEqual({ '71': 'a' });
    expect(store['9']).toEqual({});
  });

  it('坏文件时同样拒绝写', () => {
    writeFileSync(file, 'nope');
    expect(() => commitUnmark(9, [1], file)).toThrow(/拒绝写入/);
  });
});

describe('存放位置', () => {
  it('默认在家目录下的 .zhupi-mcp/，不进 /usr/local 不进 PATH', () => {
    expect(DEFAULT_STORE).toMatch(/\.zhupi-mcp\/processed\.json$/);
    expect(DEFAULT_STORE).not.toContain('/usr/local');
  });

  it('可用 ZHUPI_STATE_FILE 覆盖（测试与多机场景用）', () => {
    expect(storePath({ ZHUPI_STATE_FILE: '/tmp/x.json' } as NodeJS.ProcessEnv)).toBe('/tmp/x.json');
  });
});

describe('第二轮评审：这些修复原本没有测试护着', () => {
  it('**save 必须真的走 rename**（原来的「不留 tmp 文件」断言对裸写也成立，是恒绿的）', () => {
    // 判据：裸 writeFileSync 会**穿过** symlink 写到被指向的文件（path 仍是 symlink）；
    // rename 则用普通文件**替换掉** symlink 本身。所以 lstat 能分辨这两种实现。
    const real = join(dir, 'real.json');
    writeFileSync(real, '{}');
    symlinkSync(real, file);
    save({ '9': { '1': 'a' } }, file);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
  });

  it('**__proto__ 不能跨折读穿** —— 上一版断言的「原型不是数组」其实被无关过滤挡掉了，恒绿', () => {
    writeFileSync(file, '{"9":{"1":"a"},"__proto__":{"7":"b"}}');
    const { store } = load(file);
    expect(Object.getPrototypeOf(store)).toBe(null);
    expect(store['7']).toBeUndefined();          // 用 {} 时这里会从原型链取到 'b'
    expect(handledIds(store, 7, [E(7)]).size).toBe(0);
  });

  it('bucket 也不能被 __proto__ 污染', () => {
    writeFileSync(file, '{"9":{"__proto__":{"1":"a"}}}');
    const { store } = load(file);
    expect(handledIds(store, 9, [E(1)]).size).toBe(0);
  });

  it('并发写不丢更新：串行化之后两折都在', () => {
    // 锁的单进程可观察后果：拿着锁再 commit 不会自锁死（同一进程内是顺序执行的）
    commit(9, [E(91)], file);
    commit(18, [E(181)], file);
    expect(Object.keys(load(file).store).sort()).toEqual(['18', '9']);
    expect(readdirSync(dir).filter((f) => f.endsWith('.lock'))).toEqual([]);
  });

  it('陈旧锁能被接管 —— **用真实新锁**跑够超时，不许拨 mtime 骗自己', () => {
    // 上一版把锁的 mtime 往前拨 60 秒，于是「陈旧阈值 10s > 等锁上限 5s、这条路永远走不到」
    // 这个真 bug 被测试放过了（第三轮评审实测：持锁进程被杀一次就永久写不进去）。
    // 现在陈旧阈值恒为上限的 60%，所以真实新锁等到 60% 时就该被接管。
    process.env.ZHUPI_LOCK_TIMEOUT_MS = '400';
    try {
      mkdirSync(`${file}.lock`, { recursive: true });   // 真·新锁，mtime = now
      expect(commit(9, [E(91)], file).added).toEqual([91]);
      expect(handledIds(load(file).store, 9, [E(91)]).size).toBe(1);
    } finally {
      delete process.env.ZHUPI_LOCK_TIMEOUT_MS;
      rmSync(`${file}.lock`, { recursive: true, force: true });
    }
  });

  it('陈旧阈值必须小于等锁上限 —— 否则接管是死代码', () => {
    // 不测常量本身（会被改回去也不报），测**可观察后果**：无主锁最终一定被接管。
    process.env.ZHUPI_LOCK_TIMEOUT_MS = '400';
    try {
      mkdirSync(`${file}.lock`, { recursive: true });
      expect(() => commit(9, [E(91)], file)).not.toThrow();
    } finally {
      delete process.env.ZHUPI_LOCK_TIMEOUT_MS;
      rmSync(`${file}.lock`, { recursive: true, force: true });
    }
  });

  it('锁被一个**活着的**进程持有时，等到超时明着报错，不静默跳过写入', () => {
    // 必须真开子进程：commit 的忙等是 Atomics.wait，会把事件循环整个阻住，
    // 同进程里的 setInterval 一次都不会跑 —— 那样测出来的是「锁被接管」，
    // 恰好把要测的东西测反了。
    const lock = `${file}.lock`;
    const child = spawn(process.execPath, ['-e',
      `const {mkdirSync,utimesSync}=require('node:fs');mkdirSync(${JSON.stringify(lock)},{recursive:true});` +
      `setInterval(()=>{try{utimesSync(${JSON.stringify(lock)},new Date(),new Date())}catch{}},15);`,
    ], { stdio: 'ignore' });
    process.env.ZHUPI_LOCK_TIMEOUT_MS = '400';
    try {
      const until = Date.now() + 3000;
      while (!existsSync(lock) && Date.now() < until) { /* 等子进程建好锁 */ }
      expect(existsSync(lock)).toBe(true);
      expect(() => commit(9, [E(91)], file)).toThrow(/被别的进程占着/);
      expect(load(file).store).toEqual({});            // 没有偷偷写进去
    } finally {
      child.kill('SIGKILL');
      delete process.env.ZHUPI_LOCK_TIMEOUT_MS;
      rmSync(lock, { recursive: true, force: true });
    }
  });
});
