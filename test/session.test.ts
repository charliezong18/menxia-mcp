import { describe, it, expect } from 'vitest';
import { detectSessionId } from '../src/session.js';

// 这组测试守的是一句话：**探不到就返回 null，绝不编。**
//
// 全部走注入的 ps / readSessions，不碰真进程树 —— 依赖真 ppid 链的测试
// 在别人的机器上、在 CI 里、在 daemon 起的会话里各是一个结果，等于没测。

type Row = { command: string; ppid: number };
const psFrom = (tree: Record<number, Row>) => (fmt: 'command=' | 'ppid=', pid: number): string => {
  const row = tree[pid];
  if (!row) return '';
  return fmt === 'command=' ? row.command : String(row.ppid);
};
const sessions = (m: Record<string, number>) => () => ({
  sessions: Object.fromEntries(Object.entries(m).map(([sid, hostPid]) => [sid, { metadata: { hostPid } }])),
});

describe('会话 id 探测', () => {
  it('沿 ppid 爬到 happy 进程 —— 命中', () => {
    const tree = {
      100: { command: 'node mcp-server', ppid: 200 },
      200: { command: 'claude --mcp', ppid: 300 },
      300: { command: '/opt/homebrew/bin/happy daemon', ppid: 1 },
    };
    expect(detectSessionId({ startPid: 100, ps: psFrom(tree), readSessions: sessions({ sid_abc: 300 }) }))
      .toBe('sid_abc');
  });

  // 这是原脚本里最不能省的一行，SPEC §4.4 单独写了一段。
  // sessions.json 只累加不清理，陈旧记录的 hostPid 早被 OS 回收给别的进程。
  it('hostPid 撞上了但那个进程不是 happy（陈旧记录）—— 返回 null，不指错', () => {
    const tree = {
      100: { command: 'node mcp-server', ppid: 300 },
      300: { command: '/usr/sbin/cupsd', ppid: 1 }, // pid 被回收给了别的进程
    };
    expect(detectSessionId({ startPid: 100, ps: psFrom(tree), readSessions: sessions({ sid_stale: 300 }) }))
      .toBeNull();
  });

  it('陈旧记录挡在中间时，继续往上爬能找到真的那个', () => {
    const tree = {
      100: { command: 'node mcp-server', ppid: 300 },
      300: { command: '/usr/sbin/cupsd', ppid: 400 },
      400: { command: 'happy', ppid: 1 },
    };
    expect(detectSessionId({
      startPid: 100, ps: psFrom(tree), readSessions: sessions({ sid_stale: 300, sid_real: 400 }),
    })).toBe('sid_real');
  });

  it('sessions.json 读不到 —— 返回 null，不抛', () => {
    expect(detectSessionId({
      startPid: 100,
      ps: () => 'happy',
      readSessions: () => { throw new Error('ENOENT'); },
    })).toBeNull();
  });

  it('sessions.json 是别的形状 —— 返回 null，不抛', () => {
    for (const raw of [null, {}, { sessions: null }, { sessions: [] }, 'nope', 42]) {
      expect(detectSessionId({ startPid: 100, ps: () => 'happy', readSessions: () => raw })).toBeNull();
    }
  });

  it('缺 hostPid / hostPid 不是整数的条目被跳过，不当 key', () => {
    const raw = () => ({
      sessions: {
        a: { metadata: {} },
        b: { metadata: { hostPid: null } },
        c: { metadata: { hostPid: '300' } }, // 字符串不撞 —— 与原脚本（python int key）一致
        d: {},
        e: null,
      },
    });
    expect(detectSessionId({
      startPid: 300, ps: psFrom({ 300: { command: 'happy', ppid: 1 } }), readSessions: raw,
    })).toBeNull();
  });

  it('根本不在 happy 下面跑（ppid 链走到 1）—— 返回 null', () => {
    const tree = { 100: { command: 'node x', ppid: 1 } };
    expect(detectSessionId({ startPid: 100, ps: psFrom(tree), readSessions: sessions({ s: 999 }) }))
      .toBeNull();
  });

  it('ppid 成环也不会死循环', () => {
    const tree = {
      100: { command: 'a', ppid: 200 },
      200: { command: 'b', ppid: 100 },
    };
    expect(detectSessionId({ startPid: 100, ps: psFrom(tree), readSessions: sessions({ s: 999 }) }))
      .toBeNull();
  });

  it('链超过 12 级就放弃（原脚本的上限，照搬）', () => {
    const tree: Record<number, Row> = {};
    for (let i = 0; i < 20; i += 1) tree[100 + i] = { command: 'x', ppid: 101 + i };
    tree[120] = { command: 'happy', ppid: 1 };
    expect(detectSessionId({ startPid: 100, ps: psFrom(tree), readSessions: sessions({ far: 120 }) }))
      .toBeNull();
    // 起点挪近一点就够得着 —— 证明上面那条 null 是被 MAX_HOPS 挡的，不是别的原因
    expect(detectSessionId({ startPid: 110, ps: psFrom(tree), readSessions: sessions({ far: 120 }) }))
      .toBe('far');
  });

  it('ps 整个不可用（返回空串）—— 返回 null，不抛', () => {
    expect(detectSessionId({ startPid: 100, ps: () => '', readSessions: sessions({ s: 100 }) })).toBeNull();
  });
});
