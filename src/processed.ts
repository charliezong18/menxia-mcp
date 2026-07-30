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
//
// R7 的口径随之精确成「**不写远端**」：本文件是全项目唯一的写路径，
// 且只写一个文件（`storePath()`）。guard.ts 有一条规则焊死这一点。
//
// ——第一轮评审（2026-07-29）在这个文件上抓到两条高危，都已修，别改回去——
//
// ① **`load` 吞掉失败 + `save` 覆写 = 全量清零。** 「读不到一律当空」对读是良性的
//    （多报），但 `mark` 拿那个空基线 `save` 一次，**所有折的标记永久没了**。
//    并发实测 2.5% 触发。所以 `load` 现在必须分清「文件不存在」（合法空）和
//    「读不出来」（`unreadable`），后者**拒绝写**——宁可让 mark_handled 明着失败。
//
// ② **只记 id 认不出「他改了那条总批」。** 他在 GitHub 上原地补一句
//    「第 3 点你根本没改」，id 不变 → 还是 handled → 那句话永不出现。
//    这正是本版要杀的漏报换了个形态。所以记的是 `id → 当时的 updated_at`，
//    他一编辑就重新变 pending。

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_STORE = join(homedir(), '.zhupi-mcp', 'processed.json');

/** `{ "<折号>": { "<comment id>": "标记时看到的 updated_at" } }` */
export type ProcessedStore = Record<string, Record<string, string>>;

export type LoadResult = {
  store: ProcessedStore;
  /** 文件在那儿但读不出来（坏 JSON / 没权限 / 半截写入）。**此时禁止写。** */
  unreadable: boolean;
};

/** 一条总批的身份：id + 服务端最后修改时间。 */
export type Entry = { id: number; updatedAt: string };

export function storePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZHUPI_STATE_FILE || DEFAULT_STORE;
}

const validId = (id: unknown): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0;

/**
 * 读。**读不到一律当空** —— 失效方向永远是多报：宁可让人多看几条，绝不静默吞掉他的话。
 *
 * 但要分清两种「读不到」：文件不存在是正常的第一次运行；**读不出来是异常**，
 * 拿它当基线去写会把别的折全抹掉（评审实测）。所以后者带 `unreadable: true` 出来。
 */
export function load(path = storePath()): LoadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    // 只有「不存在」是合法空。EACCES / EISDIR / EMFILE 一律算读不出来。
    const code = (e as NodeJS.ErrnoException)?.code;
    return { store: {}, unreadable: code !== 'ENOENT' };
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { store: {}, unreadable: true };
    // Object.create(null)：`__proto__` 这个键会命中 Object.prototype 的 setter。
    // 用 `{}` 的话该折的记录会**跨折读穿**（`store['7']` 从原型链上取到别人的值），
    // 而且这里的 try 接不住下游因此抛的错。第二轮评审指出上一版护着这行的测试是恒绿的
    // （断言的是「原型不是数组」，而那其实被下面 `Array.isArray(v) → continue` 挡掉了）。
    const store = Object.create(null) as ProcessedStore;
    for (const [pr, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null || typeof v !== 'object' || Array.isArray(v)) continue;
      const bucket = Object.create(null) as Record<string, string>;
      for (const [id, at] of Object.entries(v as Record<string, unknown>)) {
        if (validId(Number(id)) && typeof at === 'string') bucket[id] = at;
      }
      store[pr] = bucket;
    }
    return { store, unreadable: false };
  } catch {
    return { store: {}, unreadable: true };
  }
}

/**
 * 原子写：先写临时文件再 rename。
 * 裸 writeFileSync 是 truncate-then-write —— 写一半被杀（客户端退出 / SIGTERM）就留下
 * 半截 JSON，下一次读会走 `unreadable`。同目录 rename 在 POSIX 上是原子替换。
 */
export function save(store: ProcessedStore, path = storePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 临时文件清不掉就算了，别掩盖真正的错误 */
    }
    throw e;
  }
}

// —— 互斥锁 ——
//
// 第二轮评审把「残余竞态是良性多报」这个声称**实测推翻**了：
//   4 进程 × 40 次 commit → 丢更新 66%；两折并发各标一条 → 只剩一折
//   而且 **commitUnmark 与 commit 竞争时，33% 会「报 removed 成功但盘上还是 handled」**
//   —— 那是漏报，不是多报。方向不对称，所以必须真锁。
//
// 用 mkdir 当锁：POSIX 上 mkdir 是原子的，已存在就 EEXIST。
// 必须能接管陈旧锁，否则持锁进程被杀一次就永久卡死。

const LOCK_STALE_MS = 10_000;
/** 等锁上限。测试里调小，免得一条断言就拖 5 秒。 */
const lockTimeoutMs = (): number => Number(process.env.ZHUPI_LOCK_TIMEOUT_MS) || 5_000;

/** 同步睡眠。写操作稀少且极小，忙等这几十毫秒比引入异步传染更简单。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // 锁刚被别人释放
      }
      if (Date.now() > deadline) {
        throw new Error(`状态文件被别的进程占着，等超时了：${lock}\n卡住不动就手动删掉它。`);
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * 哪些是真·已处理：记过 **且** 记完之后他没再动过。
 *
 * `updatedAt > 记录值` = 他原地编辑了那条总批 → 重新变 pending。
 * 记录里有、但这次没传进来的（他删了总批）自然不出现，不用清理。
 */
export function handledIds(store: ProcessedStore, pr: number, items: Entry[]): Set<number> {
  const bucket = store[String(pr)];
  if (!bucket) return new Set();
  const out = new Set<number>();
  for (const it of items) {
    const at = bucket[String(it.id)];
    if (at != null && !(it.updatedAt > at)) out.add(it.id);
  }
  return out;
}

export type MarkResult = { store: ProcessedStore; added: number[]; refreshed: number[] };

/**
 * 记一批为已处理。纯函数，不落盘。
 * - `added` —— 本来没记过的
 * - `refreshed` —— 记过、但他改过之后又标一次的（时间戳被更新）
 * 两者分开报，才不会把「他改过我又确认了」说成「早就记过了」。
 */
export function mark(store: ProcessedStore, pr: number, entries: Entry[]): MarkResult {
  const key = String(pr);
  const bucket = { ...(store[key] ?? {}) };
  const added: number[] = [];
  const refreshed: number[] = [];
  // 同一次调用里的重复 id 要去重，否则 added 会报「记了 3 条」而其实只有 2 条。
  const seen = new Set<number>();
  for (const { id, updatedAt } of entries) {
    if (!validId(id) || seen.has(id)) continue;
    seen.add(id);
    const prev = bucket[String(id)];
    if (prev === undefined) added.push(id);
    else if (updatedAt > prev) refreshed.push(id);
    else continue;
    bucket[String(id)] = updatedAt;
  }
  if (added.length === 0 && refreshed.length === 0) return { store, added, refreshed };
  return { store: { ...store, [key]: bucket }, added, refreshed };
}

/** 撤销标记。唯一的写操作必须有回退——否则误标不可发现也不可修（第一轮评审）。 */
export function unmark(store: ProcessedStore, pr: number, ids: number[]): { store: ProcessedStore; removed: number[] } {
  const key = String(pr);
  const bucket = store[key];
  if (!bucket) return { store, removed: [] };
  const next = { ...bucket };
  const removed: number[] = [];
  for (const id of new Set(ids)) {
    if (next[String(id)] !== undefined) {
      delete next[String(id)];
      removed.push(id);
    }
  }
  if (removed.length === 0) return { store, removed };
  return { store: { ...store, [key]: next }, removed };
}

/**
 * 落盘：**在锁里**重新读一遍再合并，而不是覆盖调用方手里的快照。
 *
 * 并行 session 各起一个 MCP 进程共用这个文件。上一版只做了「重读合并」没加锁，
 * 我写「残余窗口只有 rename 那一瞬、丢更新是良性多报」—— 第二轮评审实测推翻：
 * 窗口是整个 load→mark→save，丢更新 66%，且 `commitUnmark` 撞 `commit` 时
 * **33% 会报撤销成功而盘上仍是 handled**（漏报）。所以现在真锁。
 */
export function commit(
  pr: number,
  entries: Entry[],
  path = storePath(),
): { added: number[]; refreshed: number[] } {
  return withLock(path, () => {
    const fresh = load(path);
    if (fresh.unreadable) {
      throw new Error(
        `状态文件读不出来，拒绝写入（否则会把其他折的记录全抹掉）：${path}\n` +
          '看一眼这个文件；确认没用就删掉，下次调用会重新建。',
      );
    }
    const { store, added, refreshed } = mark(fresh.store, pr, entries);
    if (added.length > 0 || refreshed.length > 0) save(store, path);
    return { added, refreshed };
  });
}

/** 撤销并落盘。同样在锁里重读——不锁的话 33% 会「报撤销成功而盘上还是 handled」（漏报）。 */
export function commitUnmark(pr: number, ids: number[], path = storePath()): { removed: number[] } {
  return withLock(path, () => {
    const fresh = load(path);
    if (fresh.unreadable) throw new Error(`状态文件读不出来，拒绝写入：${path}`);
    const { store, removed } = unmark(fresh.store, pr, ids);
    if (removed.length > 0) save(store, path);
    return { removed };
  });
}
