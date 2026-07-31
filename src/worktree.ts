// **唯一碰敕草仓的模块**（SPEC §4.2）。它拿锁、开临时 worktree、拷文档、commit、push，
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
// 残留竞态（写下来，不假装没有）：有两个微秒级子窗，都靠同一条兜底收口 ——
//   ① 抢锁侧：A 读到陈旧锁 → C 抢先拿到新锁 → A 把 C 的新锁挪走。A 与 C 都会在拿锁后
//     **回读确认锁里是自己的 pid**，被挪走的一方会重新排队。
//   ② 释放侧：A 持锁过龄被 B 判陈旧、抢走并建了新锁；A 的 release 在「回读确认锁是自己的」
//     与「rmSync 删掉它」之间被调度走，醒来时把 **B 的新锁**删掉。前提是 A 已经过龄
//     （没过龄 B 根本不会来抢），所以把陈旧阈值抬到远超合法持锁（见 `staleMs()`）本身
//     就把这个窗口压到近乎不可达；剩下的残留与 ① 同口径接受。
// 两者最坏结果都一样：两个 git 操作撞上，git 自己的 index/ref 锁会明着报错，不是静默串仓。

import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, writeFileSync, writeSync,
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
/**
 * 每次 git 子调用的超时预算（毫秒）。env 可覆盖是测试接缝（真正用它的地方见 `git()`）。
 * 单拎成函数是因为**陈旧阈值 `staleMs()` 要从它推导** —— 两个数各写各的迟早漂移。
 */
export const gitTimeoutMs = (): number => Number(process.env.ZHUPI_GIT_TIMEOUT_MS) || 180_000;

/**
 * 超过这个岁数的锁才当陈旧、可抢。**这是从 git 超时预算推出来的下界，不是拍脑袋的五分钟。**
 *
 * 上一版写死 `5 * 60_000`，注释还说「临界区是秒级的」—— 那句话错了：`stageFolder`
 * 全程持锁跨 fetch → commit → push，每个 git 子调用各自可阻塞到 `gitTimeoutMs()`
 * （默认 180s，慢网络的 push 真能吃满）。一次合法持锁里最坏 ≈ 3× 单次超时 ≈ 540s，
 * **已经越过旧的 300s**。后果正是这把锁存在的意义所反的：一个正在慢 push 的活会话
 * 被判陈旧、锁被别人抢走 —— 两个 git 操作同时进临界区，恰好在最需要锁的时候。
 *
 * 所以阈值 = 3×（单次 git 超时）+ 60s 余量，且不低于 600s 硬底
 * （3× 是因为一次持锁里真能吃满超时的 git 调用就 fetch / commit / push 这三步；
 * 硬底防的是有人把 `ZHUPI_GIT_TIMEOUT_MS` 调得极小，短超时不该让锁变得好抢）。
 * **必须在判定时现算**（line 135 调 `staleMs()`，不是模块常量）：超时预算一旦调大，
 * 陈旧阈值要跟着涨，否则调大超时就把这个洞又开回来了。
 */
export const staleMs = (): number => Math.max(600_000, gitTimeoutMs() * 3 + 60_000);

/**
 * @deprecated 判定一律用 `staleMs()`（现算）。这个常量保留只为测试造「够老的锁」时有个
 * 稳定的岁数基准；默认超时预算下它 === `staleMs()`。别在判活逻辑里用它。
 */
export const STALE_MS = staleMs();
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
  /**
   * 测试接缝：判定「这把锁陈旧、我要抢」之后、真去 rename 之前插一手。
   *
   * 与 onCreated 同一个理由 —— 变异战役里「抢锁不核对挪到手的是哪一个」原样存活。
   * 那条防御要的时序是「判陈旧 → 被调度走 → 别人拿到了有效锁 → 我才动手抢」，
   * 靠并发跑撞不出来。
   */
  onBeforeSteal?: () => void;
  /**
   * 测试接缝：release 里「回读确认锁是自己的」与「rmSync 删掉它」之间插一手。
   *
   * 开这个口子是为了让文件头描述的**释放侧残留子窗**能被一条测试钉住 —— 那个窗口
   * 微秒级，靠并发跑撞不出来。时序：我持锁过龄 → 回读时锁还是我的 → 被调度走 →
   * B 判我陈旧、抢走、建了自己的新锁 → 我醒来 rmSync **删掉 B 的新锁**。
   * 与文件头的接受口径一致（残留子窗，git 自己的 ref 锁会明着报错兜底），
   * 这条测试记录的是**当前行为**，不是断言它被消除了。
   */
  onBeforeRelease?: () => void;
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
 * 三条判活，任一成立就当陈旧可抢：内容读不出来（写了一半就崩）、pid 已死、超过 `staleMs()`。
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
        // **释放前先确认锁还是自己的。**（第二轮评审 2026-07-30）
        // 上一版是无脑 `rmSync`。真实场景：我持锁超过 STALE_MS（比如一次特别慢的 push），
        // B 判我陈旧、抢走了锁并进了临界区；我这时候收工，一句 rmSync **把 B 的有效锁删掉** ——
        // 于是 C 进来，和 B 同时在临界区里。锁越是「快到期」越容易出这事，
        // 而慢 push 恰恰是最需要锁的时候。
        return () => {
          try {
            // 回读与删除之间是个 check-then-act 残留子窗（见文件头）：过龄被 B 抢走后，
            // 若 B 恰在这两步之间完成抢锁并建了新锁，下面这句会把 **B 的新锁**删掉。
            // 窗口微秒级，且只在「本会话已经过龄到被判陈旧」时才成立；兜底同抢锁侧 ——
            // 真串了仓，git 自己的 index/ref 锁会明着报错，不是静默。onBeforeRelease 把
            // 这个窗口暴露给测试钉住当前行为。
            const mine = readLock(path)?.pid === process.pid;
            opts.onBeforeRelease?.();
            if (mine) rmSync(path, { force: true });
          } catch { /* 已经没了就算了 */ }
        };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = readLock(path);
      lastHolder = held?.pid;
      const stale = held === null || !alive(held.pid) || Date.now() - held.at > staleMs();
      if (stale) {
        // 挪走再删，不直接 unlink：rename 的源只有一个，两个进程同时抢时只有一个能成，
        // 另一个拿到 ENOENT 会回去继续排队。直接 unlink 的话两个都「成功」。
        //
        // **挪走之后要核对挪到手的确实是刚才判陈旧的那一个。**（第二轮评审 2026-07-30）
        // 上一版少了这一步，于是这条时序能让两个进程同时进临界区：
        //   B 判定陈旧 → B 被调度走 → A 判定陈旧、抢锁、建新锁、回读确认，进临界区
        //   → B 醒来执行 renameSync，**挪走的是 A 刚建的有效锁**（rename 成功）→ B 也进去了
        // 现在挪错了就原样挪回去，继续排队。挪回去与失主的回读之间还有个亚微秒窗口，
        // 但那时失主的回读会失败、它自己回去重排 —— 方向是安全的（多等一轮，不是同时进）。
        const aside = `${path}.stale-${process.pid}`;
        opts.onBeforeSteal?.();
        try {
          renameSync(path, aside);
          const got = readLock(aside);
          const sameOne = (got === null && held === null) || (got !== null && held !== null && got.pid === held.pid && got.at === held.at);
          if (sameOne) rmSync(aside, { force: true });
          else renameSync(aside, path); // 抢错了 —— 那是别人刚建的有效锁，还回去
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
    // **必须有超时。**（第二轮评审 2026-07-30）测试用的是 /tmp 里现造的干净仓，
    // 它照不出真机上的两件事：全局 `commit.gpgsign=true` 会让 git 等 pinentry 弹窗，
    // 仓里的 pre-commit / pre-push 钩子也可能等输入。没有超时的话 server 就**永远挂在那儿**，
    // 而且锁还在手上 —— 别的会话跟着一起卡死。三分钟给慢网络的 push 留足了余量。
    // env 可覆盖是测试接缝（同 snapshot.ts 的 ZHUPI_GIT_MAXBUFFER）：
    // 不开这个口子，「有超时」这句话就只能靠等三分钟去证，也就是不会有人证。
    timeout: Number(process.env.ZHUPI_GIT_TIMEOUT_MS) || 180_000,
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
  /**
   * 这一折是**单语读物**，免双语对（D9）。
   *
   * 为什么要有这个开关：豁免机制 `docs/.monolingual` 从 2026-07-30 加上起
   * **一次都没能用上** —— 那是个仓内文件，而 `open_folder` 只会把 `docs` 里的东西
   * 拷成 `docs/<basename>`，没有任何路径能创建或追加它。第三轮跨系统评审把这个
   * 记成「登记表文件够不着」，当时归成理论问题；实际后果是 #31（22 章官制史）
   * 长期在巡检里报 22 条假硬伤，而**一个开始报假红的检查，人就学会忽略它**。
   *
   * 落在**折自己的分支**上，随折 merge 进 main —— 之后从 main 切的折自动继承。
   * 这与 `.payload` 同一个模型。
   */
  monolingual?: boolean;
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
 * 图落到仓里哪个路径。
 *
 * 上一版一律拍平成 `docs/assets/<basename>`。**那与敕草仓自己的布局对不上**
 * （第三轮跨系统评审 2026-07-30）：main 上真实存在的是
 * `docs/assets/shots/annotate.png` / `dark.png` / `setup.png`，
 * 而 `docs/zhupi-readme.md` 正文引用的是 `assets/shots/setup.png`。
 * zhupi 按**文档自身所在目录**解析相对路径（`render.js:27`
 * `const baseDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/') + 1) : ''`），
 * 所以那条引用解析出来就是 `docs/assets/shots/setup.png` —— 拍平之后它变成断图，
 * 而规则 4 会把账算在文档头上，让人去改正文。改完，同一篇在两折里说的话就不一样了。
 *
 * 规则：源路径里出现 `/assets/` 就保留它后面的整段，否则用 basename。
 * **是规则不是推断** —— 不去猜正文引用了什么（那是 BACKLOG B3，不在本阶段）。
 */
export function assetTarget(src: string): string {
  const i = src.lastIndexOf('/assets/');
  const tail = i >= 0 ? src.slice(i + '/assets/'.length) : basename(src);
  return `docs/assets/${tail}`;
}

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
      return fail({ kind: 'worktree', what: `敕草仓的本地 checkout 不是 git 工作树：${repo}`, hint: '用 ZHUPI_REVIEW_PATH 指对地方。' });
    }
    // 先清尸体。实测这台机器上 `git worktree list` 挂着 9 个 /private/tmp 的旧条目，
    // 都是并行 session 留下的；目录还在的不动，只清目录已经没了的。
    tryGit(repo, ['worktree', 'prune']);

    const fetchFailed = tryGit(repo, ['fetch', '-q', 'origin']) === null;

    // **本地有 / 远端有，是两件完全不同的事，提示不能一样。**（第二轮评审 2026-07-30）
    // 成功路径只在 push 之后才保留本地分支，而 push 会同时建出远端分支。
    // 所以「本地有、远端没有」唯一的来源是**上一次跑到一半死了**（SIGKILL、OOM、断电）——
    // 那时 finally 没执行，本地分支和临时 worktree 都留着。
    // 上一版对这种情况说的是「换个 slug」，等于让人绕开一次崩溃残留，
    // 下次还会再撞上；而真相是「删掉它重来就行」。
    const localHas = refExists(repo, `refs/heads/${req.branch}`);
    const remoteHas = refExists(repo, `refs/remotes/origin/${req.branch}`);
    if (remoteHas) {
      return fail({
        kind: 'worktree',
        what: `分支 ${req.branch} 在远端已经存在`,
        hint: '重复呈折是真事故（同一篇被呈两次，他会看到两折）。先用 list_folders 看是不是已经有这一折：' +
          '有就去那条分支上推新版本；没有折只有分支的话，是上次建折失败留下的孤儿，直接对它建折别重推。',
      });
    }
    if (localHas) {
      return fail({
        kind: 'worktree',
        what: `本地有分支 ${req.branch}，但远端没有 —— 这是上一次呈折崩在中途留下的残留`,
        hint: `远端一片干净，什么都没发生过。清掉再来：git -C ${repo} worktree prune && git -C ${repo} branch -D ${req.branch}`,
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
        const rel = assetTarget(src);
        if (seen.has(rel)) return fail({ kind: 'worktree', what: `两张图重名：${basename(src)}` });
        seen.add(rel);
        place(src, wt, rel, copied);
      }
      if (copied.length === 0) return fail({ kind: 'worktree', what: '一个文档都没有', hint: 'docs 至少要给一对（中英各一份）。' });

      // 单语读物登记。**追加不是覆盖** —— 从 main 继承来的条目（前几折登记过的）
      // 一条都不能丢，丢了那几折下次就又被规则 1 判死。
      if (req.monolingual) {
        const reg = join(wt, 'docs', '.monolingual');
        const had = existsSync(reg) ? readFileSync(reg, 'utf8') : '';
        const lines = had.split('\n').map((l) => l.trim()).filter(Boolean);
        const want = copied.filter((p) => p.endsWith('.md'));
        const merged = [...lines];
        for (const p of want) if (!merged.includes(p)) merged.push(p);
        writeFileSync(reg, `${merged.join('\n')}\n`);
        copied.push('docs/.monolingual');
      }

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
      // worktree 一律收掉。**分支只在没推上去时删** —— 推上去了就是一折真敕草，
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
