// 「回奏对」标记的会话 id 探测。移植自 `happy-session-id.sh`
// （那个脚本 2026-07-30 退休，原件存档在本仓 `retired/happy-session-id.sh`）。
//
// 原理：本进程是 happy CLI 的后代 —— 沿 ppid 往上爬，拿每一级 pid 去比
// `~/.happy/sessions.json` 里各会话记的 hostPid，撞上的那个就是我。
// stdio 模式下 MCP server 是 Claude Code 的子进程，这条链**碰巧仍然成立**（SPEC §4.4）。
//
// **策略：探不到就返回 null，绝不编。** 按钮不出现而已；静默指错比没有更糟。
//
// 这个文件是 `FS_IMPORT_ALLOWED` 里唯一不在 `FS_WRITE_ALLOWED` 里的成员 ——
// 它只读一个 JSON。守卫仍然会拦这里出现的任何写调用名。

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 往上爬几级就放弃。原脚本是 12，照搬。 */
const MAX_HOPS = 12;

export interface Probe {
  /** 读 sessions.json。抛异常 = 读不到。 */
  readSessions: () => unknown;
  /** `ps -o <fmt> -p <pid>`，取不到返回空串。 */
  ps: (fmt: 'command=' | 'ppid=', pid: number) => string;
  /** 从哪个 pid 开始爬。 */
  startPid: number;
}

const defaultProbe = (): Probe => ({
  readSessions: () => JSON.parse(readFileSync(join(homedir(), '.happy', 'sessions.json'), 'utf8')),
  ps: (fmt, pid) => {
    try {
      return execFileSync('ps', ['-o', fmt, '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  },
  startPid: process.pid,
});

/** hostPid → 会话 id。缺 hostPid 的条目直接跳过，别让 undefined 当 key。 */
function indexByHostPid(raw: unknown): Map<number, string> {
  const out = new Map<number, string>();
  const sessions = (raw as { sessions?: Record<string, unknown> } | null)?.sessions;
  if (!sessions || typeof sessions !== 'object') return out;
  for (const [sid, v] of Object.entries(sessions)) {
    const hostPid = (v as { metadata?: { hostPid?: unknown } } | null)?.metadata?.hostPid;
    // 实测 happy 写的是 number。**不做 Number(字符串) 的宽容转换** ——
    // 原脚本（python）拿 int 去撞 dict，字符串 key 本来就撞不上，
    // 宽容化会让新实现比老的多命中一类，那是「照文档移植不照实现移植」的方向（SPEC §5.1）。
    if (typeof hostPid === 'number' && Number.isInteger(hostPid)) out.set(hostPid, sid);
  }
  return out;
}

/**
 * 探当前会话 id。探不到返回 null。**任何异常都不往外抛** ——
 * 这条信息是锦上添花（探不到只是按钮不出现），让它把呈折搞挂是本末倒置。
 */
export function detectSessionId(probe: Partial<Probe> = {}): string | null {
  const p = { ...defaultProbe(), ...probe };
  let byPid: Map<number, string>;
  try {
    byPid = indexByHostPid(p.readSessions());
  } catch {
    return null;
  }
  if (byPid.size === 0) return null;

  let pid = p.startPid;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const sid = byPid.get(pid);
    // **命中后必须再验一句「这个 pid 现在跑的确实是 happy」。**
    // sessions.json 只累加不清理（SPEC §4.4 记的是实测 114 条全标 running；
    // 今天这台机器上是 32 条，数字会变，性质不变），陈旧记录的 hostPid 早被 OS
    // 回收给别的进程 —— 撞上就会给出一个**错的**会话 id，而错的 id 让「回奏对」
    // 按钮把 Charlie 送进别人的会话。这一句是原脚本里最不能省的一行。
    if (sid !== undefined && p.ps('command=', pid).includes('happy')) return sid;

    const parent = p.ps('ppid=', pid);
    if (!parent) break;
    const next = Number.parseInt(parent, 10);
    if (!Number.isInteger(next) || next <= 1 || next === pid) break;
    pid = next;
  }
  return null;
}
