// **唯一碰奏折仓的模块**（SPEC §4.2）。它拿锁、开临时 worktree、拷文档、commit、push，
// 用完即收。agent 全程不碰 `~/Developer/review` —— 互踩才真的堵死（CLAUDE.md 的
// 「并行别互踩」记着 2026-07-27 的事故：多个 session 同时动那个仓，切走了对方的分支、
// 把暂存文件卷进了别人的 commit）。
//
// 这也是 `guard.ts` 里 fs 写 + git 写两张白名单**唯一**的共同成员。
//
// ── 锁为什么不是 flock ──
//
// SPEC §4.2 写的是 flock，任务书原本也照抄了 `O_EXLOCK | O_NONBLOCK`。**实测在这台机器上
// 行不通**：Node v25.2.1 的 `fs.constants` 里根本没有 `O_EXLOCK`（`O_*` 只有
// RDONLY/WRONLY/RDWR/CREAT/EXCL/NOCTTY/TRUNC/APPEND/DIRECTORY/NOFOLLOW/SYNC/DSYNC/
// SYMLINK/NONBLOCK）。照写的话 `O_CREAT | O_RDWR | undefined | O_NONBLOCK` 里的
// `undefined` 在按位或里当 0 —— **锁标志静默消失，得到一把永远锁不上的锁**，
// 而且全部测试照绿。macOS 也没有 `flock(1)` 可以 shell 出去。
//
// 改成：`O_EXCL` 原子创建锁文件 + 里面记 pid/时间 + 三条判活。
// 崩溃后不死锁靠的是判活，不是靠内核放锁 —— 这一条必须有测试真 kill 一个进程来证。
//
// 残留竞态（写下来，不假装没有）：A 读到陈旧锁 → C 抢先拿到新锁 → A 把 C 的新锁挪走。
// 窗口是微秒级，且 A 与 C 都会在拿锁后**回读确认锁里是自己的 pid**，被挪走的一方
// 会重新排队。最坏结果是两个 git 操作撞上，git 自己的 index/ref 锁会明着报错，
// 不是静默串仓。

import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { reviewPath } from './config.js';
import { fail, isFailure } from './errors.js';

/**
 * 锁文件放**仓外**（SPEC §4.2）—— 放仓里会被 `git clean` 和 worktree 操作牵连。
 * `ZHUPI_LOCK_PATH` 是测试接缝：集成测试要并发跑，不能去抢真机上的那把锁。
 * 每次读 env 而不是模块加载时算一次，否则测试改了 env 也不生效。
 */
export const lockPathDefault = (): string =>
  process.env.ZHUPI_LOCK_PATH ?? `${process.env.HOME ?? tmpdir()}/.zhupi-mcp/review.lock`;
/** 超过这个岁数的锁一律当陈旧。临界区是秒级的，五分钟是极宽松的上界。 */
export const STALE_MS = 5 * 60_000;
const POLL_MS = 120;
export const DEFAULT_TIMEOUT_MS = 60_000;

interface LockInfo { pid: number; at: number }

export interface LockOpts {
  lockPath?: string;
  timeoutMs?: number;
  /** 测试用：让 kill(pid,0) 可替换。 */
  isAlive?: (pid: number) => boolean;
  /**
   * 测试接缝：在「建好锁」与「回读确认」之间插一手。
   *
   * 为它开一个口子是因为**没有它那句回读就是零覆盖的** —— 变异战役里
   * 「拿到后不回读确认」原样存活。而回读防的是文件头写的那个残留竞态
   * （A 读到陈旧锁 → C 抢先拿锁 → A 把 C 的新锁挪走），微秒级窗口靠并发跑是撞不出来的。
   * 一句没有测试的防御等于一句注释。
   */
  onCreated?: () => void;
}

const liveByKill = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程在，只是我们没权限发信号 —— 当成活的。
    // 判成死的会去抢一把有效的锁，方向比误等严重得多。
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function readLock(p: string): LockInfo | null {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as Partial<LockInfo>;
    return typeof j.pid === 'number' && typeof j.at === 'number' ? { pid: j.pid, at: j.at } : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * 拿锁。拿到返回一个 release 函数，拿不到抛 `locked`。
 *
 * 三条判活，任一成立就当陈旧可抢：内容读不出来（写了一半就崩）、pid 已死、超过 STALE_MS。
 */
export async function acquireLock(opts: LockOpts = {}): Promise<() => void> {
  const path = opts.lockPath ?? lockPathDefault();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const alive = opts.isAlive ?? liveByKill;
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) mkdirSync(dir, { recursive: true });

  const started = Date.now();
  let lastHolder: number | undefined;

  for (;;) {
    try {
      // 'wx' = O_CREAT | O_EXCL | O_WRONLY，原子。
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockInfo));
      closeSync(fd);
      opts.onCreated?.();
      // **回读确认是自己的。** 这一句关掉上面注释里那个残留竞态的另一半：
      // 如果有人在这两步之间把我的锁挪走了，我要重新排队，而不是揣着一把不存在的锁往下走。
      if (readLock(path)?.pid === process.pid) {
        return () => { try { rmSync(path, { force: true }); } catch { /* 已经没了就算了 */ } };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = readLock(path);
      lastHolder = held?.pid;
      const stale = held === null || !alive(held.pid) || Date.now() - held.at > STALE_MS;
      if (stale) {
        // 挪走再删，不直接 unlink：rename 的源只有一个，两个进程同时抢时只有一个能成，
        // 另一个拿到 ENOENT 会回去继续排队。直接 unlink 的话两个都「成功」。
        const aside = `${path}.stale-${process.pid}`;
        try {
          renameSync(path, aside);
          rmSync(aside, { force: true });
        } catch { /* 被别人抢先了，下一轮重来 */ }
        continue;
      }
    }
    if (Date.now() - started >= timeoutMs) {
      return fail({ kind: 'locked', waitedMs: Date.now() - started, ...(lastHolder ? { heldBy: lastHolder } : {}) });
    }
    await sleep(POLL_MS);
  }
}

export async function withReviewLock<T>(fn: () => Promise<T>, opts: LockOpts = {}): Promise<T> {
  const release = await acquireLock(opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

// ── git ──

/**
 * `-c core.quotePath=false` 与 snapshot.ts 同一个理由：git 默认把非 ASCII 路径
 * 转义成八进制加引号，中文名文档（#31 那折 22 篇）会全线错位。
 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

const refExists = (repo: string, ref: string): boolean =>
  tryGit(repo, ['rev-parse', '--verify', '--quiet', ref]) !== null;

export interface StageRequest {
  /** 本机绝对路径，双语一对都要给。 */
  docs: string[];
  /** 本机绝对路径，正文引用的图。 */
  assets?: string[];
  /** 分支名。 */
  branch: string;
  message: string;
}

export interface Staged {
  /** 临时 worktree 的绝对路径。lint 对着它跑。 */
  worktree: string;
  branch: string;
  /** 仓内相对路径，如 `docs/foo.md` / `docs/assets/p.png`。 */
  copied: string[];
}

export interface StageResult extends Staged {
  headSha: string;
  fetchFailed: boolean;
}

export interface StageOpts extends LockOpts {
  reviewPath?: string;
  base?: string;
}

/** 落一个文件到 worktree 里的相对路径。**已存在就报错，不静默覆盖。** */
function place(src: string, wt: string, rel: string, copied: string[]): void {
  if (!existsSync(src)) {
    return fail({ kind: 'worktree', what: `读不到文件：${src}`, hint: 'docs / assets 要给本机绝对路径。' });
  }
  const dst = join(wt, rel);
  if (existsSync(dst)) {
    return fail({
      kind: 'worktree',
      what: `${rel} 已经在 main 上了`,
      hint: '同名会静默盖掉别人的稿子。改个文件名，或者这本来就该是同一折的新版本 —— 那就往那折的分支上推，别开新折。',
    });
  }
  mkdirSync(dirOf(dst), { recursive: true });
  copyFileSync(src, dst);
  copied.push(rel);
}

const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'));

/**
 * 全流程：拿锁 → fetch → 开 worktree → 拷 → commit → **跑 lint** → push → 收 worktree。
 *
 * **lint 卡在 commit 之后、push 之前**（刻意改进，SPEC §5.4）：
 * `snapshot.ts` 读的是提交过的内容（`git show <ref>:<path>`），不 commit 就没得测；
 * 而在 push 之前停住，不合格时远端一片干净 —— 删掉 worktree 和本地分支就什么都没发生。
 * 老脚本做不到：它跑的时候分支早被人手推上去了。
 *
 * `lint` 抛异常 = 中止。异常原样往外传，调用方负责翻译成人话。
 */
export async function stageFolder(
  req: StageRequest,
  lint: (s: Staged) => Promise<void>,
  opts: StageOpts = {},
): Promise<StageResult> {
  const repo = opts.reviewPath ?? reviewPath();
  const base = opts.base ?? 'origin/main';

  return withReviewLock(async () => {
    if (tryGit(repo, ['rev-parse', '--git-dir']) === null) {
      return fail({ kind: 'worktree', what: `奏折仓的本地 checkout 不是 git 工作树：${repo}`, hint: '用 ZHUPI_REVIEW_PATH 指对地方。' });
    }
    // 先清尸体。实测这台机器上 `git worktree list` 挂着 9 个 /private/tmp 的旧条目，
    // 都是并行 session 留下的；目录还在的不动，只清目录已经没了的。
    tryGit(repo, ['worktree', 'prune']);

    const fetchFailed = tryGit(repo, ['fetch', '-q', 'origin']) === null;

    if (refExists(repo, `refs/heads/${req.branch}`) || refExists(repo, `refs/remotes/origin/${req.branch}`)) {
      return fail({
        kind: 'worktree',
        what: `分支 ${req.branch} 已经存在`,
        hint: '重复呈折是真事故（同一篇被呈两次，他会看到两折）。要么换个 slug，要么去那折的分支上推新版本。',
      });
    }
    if (!refExists(repo, base)) {
      return fail({ kind: 'worktree', what: `拿不到基线 ${base}`, hint: '网络断了？分支基点是体例第 4 条，不能瞎切。' });
    }

    // mkdtemp 建的是空目录，`git worktree add` 接受空目录。
    const wt = mkdtempSync(join(tmpdir(), 'zhupi-wt-'));
    let pushed = false;
    try {
      const added = tryGit(repo, ['worktree', 'add', wt, '-b', req.branch, base]);
      if (added === null) return fail({ kind: 'worktree', what: `git worktree add 失败（${wt}）` });

      const copied: string[] = [];
      const seen = new Set<string>();
      for (const src of req.docs) {
        const rel = `docs/${basename(src)}`;
        if (seen.has(rel)) return fail({ kind: 'worktree', what: `两份文档重名：${basename(src)}`, hint: '拷进仓里之后会互相覆盖。' });
        seen.add(rel);
        place(src, wt, rel, copied);
      }
      for (const src of req.assets ?? []) {
        const rel = `docs/assets/${basename(src)}`;
        if (seen.has(rel)) return fail({ kind: 'worktree', what: `两张图重名：${basename(src)}` });
        seen.add(rel);
        place(src, wt, rel, copied);
      }
      if (copied.length === 0) return fail({ kind: 'worktree', what: '一个文档都没有', hint: 'docs 至少要给一对（中英各一份）。' });

      if (tryGit(wt, ['add', '--', 'docs']) === null) return fail({ kind: 'worktree', what: 'git add 失败' });
      if (tryGit(wt, ['commit', '-m', req.message]) === null) {
        return fail({ kind: 'worktree', what: 'git commit 失败', hint: '多半是没有可提交的改动，或者 git 身份没配。' });
      }

      // ── 闸门在这儿。过不去就什么都不推。 ──
      await lint({ worktree: wt, branch: req.branch, copied });

      if (tryGit(wt, ['push', '-u', 'origin', req.branch]) === null) {
        return fail({ kind: 'worktree', what: `git push 失败（分支 ${req.branch}）`, hint: '网络或权限。本地分支留着了，网络好了可以手推。' });
      }
      pushed = true;
      return { worktree: wt, branch: req.branch, copied, headSha: git(wt, ['rev-parse', 'HEAD']), fetchFailed };
    } finally {
      // worktree 一律收掉。**分支只在没推上去时删** —— 推上去了就是一折真奏折，
      // 本地分支留着，后面出 v2 还要往它上面推。
      tryGit(repo, ['worktree', 'remove', '--force', wt]);
      rmSync(wt, { recursive: true, force: true });
      if (!pushed) tryGit(repo, ['branch', '-D', req.branch]);
    }
  }, opts);
}

/** 中止路径也要能把残骸收掉 —— 给验收脚本和疤痕测试用。 */
export function cleanupBranch(repo: string, branch: string): void {
  tryGit(repo, ['worktree', 'prune']);
  tryGit(repo, ['branch', '-D', branch]);
}

export { isFailure };
