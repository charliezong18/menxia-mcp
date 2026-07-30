// 「已处理」是 agent 的私有状态，放本地，不放 GitHub。
//
// 为什么（review#29）：agent 与 Charlie 共用同一个 GitHub 账号，任何编码进
// GitHub 的标记都会退化成「靠约定」——前三版方案（隐藏注释 / review body 前缀 /
// reaction）全死在这上面。而「这条我处理过了」本来就只有 agent 知道，
// 把它放在只有 agent 写的命名空间里，共享账号问题不是被解决，是变得**无关**。
//
// 顺带修掉一个更严重的洞：会话区的 answered 原本靠位置推断
// （`i < len-1 → 已答`），那成立的前提是「会话区是双方 channel」。
// agent 不再发折级小结之后它变成单方收件箱，「后面还有话」只意味着
// Charlie 又说了一句 → **他连发两条总批，前一条会被静默判成已答**（漏报）。
// 有了这份记录，answered 不再靠猜。
//
// R7 的口径随之精确成「**不写远端**」：本文件写本地 JSON，不碰 GitHub。
// 只读守卫（guard.ts）管的是远端写操作，与此不冲突。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_STORE = join(homedir(), '.zhupi-mcp', 'processed.json');

/** `{ "<折号>": [已处理的 comment id...] }` */
export type ProcessedStore = Record<string, number[]>;

export function storePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZHUPI_STATE_FILE || DEFAULT_STORE;
}

/**
 * 读。**读不到一律当空**——文件丢了、换机器、格式坏了，结果都是「全部未处理」。
 * 失效方向永远是多报：宁可让人多看几条，绝不静默吞掉他的话。
 */
export function load(path = storePath()): ProcessedStore {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: ProcessedStore = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is number => typeof x === 'number');
    }
    return out;
  } catch {
    return {};
  }
}

export function save(store: ProcessedStore, path = storePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export const idsFor = (store: ProcessedStore, pr: number): Set<number> => new Set(store[String(pr)] ?? []);

/** 记一批 id 为已处理。返回真正新增的（便于如实汇报，不谎报「记了 3 条」）。 */
export function mark(store: ProcessedStore, pr: number, ids: number[]): { store: ProcessedStore; added: number[] } {
  const key = String(pr);
  const have = new Set(store[key] ?? []);
  const added = ids.filter((id) => Number.isInteger(id) && id > 0 && !have.has(id));
  if (added.length === 0) return { store, added };
  return { store: { ...store, [key]: [...(store[key] ?? []), ...added].sort((a, b) => a - b) }, added };
}

/**
 * 灌水位：把某折当前全部 comment id 记成已处理，一次清空积压。
 * 存量那 9 条（含 4 条 agent 自己发的）靠这个安静，不用去动 GitHub 上的数据。
 */
export function seed(store: ProcessedStore, pr: number, allIds: number[]): ProcessedStore {
  return mark(store, pr, allIds).store;
}
