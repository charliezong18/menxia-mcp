// 从 git 工作树采一份 Snapshot 喂给 lint.ts。这是 lint 侧唯一碰 IO 的模块。
//
// **不 import fs**（tasks T4 判据）：`guard.ts` 焊死了「src/ 下除 processed.ts 不许 import fs」，
// 而 2026-07-30 Phase 2 设计评审刚发现那条守卫拦不住 `node:fs/promises` ——
// 「换个写法顺手绕过」正是它要防的病。所以这里一律走 git 子进程。
//
// 顺带一个好处（设计 §0）：读**分支树**比读脏工作树更对 ——
// zhupi 渲染的是 GitHub 上的内容，也就是提交过的内容。
//
// 关于 `git fetch`：它是远端**读**，与 R8「不写远端」不冲突。
// 老脚本 `folder-lint.sh:21` 就做这件事，这里照搬，但**失败要报**（需求 R5，规则 9）。
// 这条网络出口不经 octokit，所以 guard.ts 的只读闸门管不到它 —— 写在这里，
// 免得将来有人以为它是漏过去的。

import { execFileSync } from 'node:child_process';
import type { Snapshot } from './lint.js';

export interface SnapshotOpts {
  /** 工作树路径，默认 cwd */
  worktree?: string;
  /** 要检查的 ref，默认 HEAD。巡检时传 `origin/<branch>` */
  ref?: string;
  /** 基线，默认 origin/main */
  base?: string;
  /** PR body（呈折时传，巡检时不传） */
  body?: string;
  /** 跳过 fetch（巡检批量跑时只在最外层 fetch 一次） */
  skipFetch?: boolean;
}

export class NotAGitWorktree extends Error {}

/**
 * 跑 git。两个参数是**必须**的，别删：
 *
 * ① `-c core.quotePath=false`：git 默认把非 ASCII 路径转义成八进制加引号
 *    （`"docs/assets/\347\253\213..."`）。不关掉的话中文名文件**全挂** ——
 *    assets 集合里是转义串、正文引用是真名，永远对不上 → 中文名的图一律误报断图（硬伤）；
 *    changed 里的路径也带引号 → `git show ref:"docs\344..."` 必失败 → 双语齐的也报缺译本。
 *    第一轮评审实测：敕草仓 #31 那折 22 个中文名文档全部踩在上面。
 *
 * ② `maxBuffer`：默认 1 MiB，超了抛 ENOBUFS 被 catch 吞掉返回 null，
 *    等价于「文件不存在」—— 于是大文档既谎报缺译本、又让规则 4 整条不跑（真断图漏报）。
 *    静默降级，不会有人发现。
 */
function raw(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    // 可覆盖是为了能**真**测到 ENOBUFS 那条路径。
    // 不开这个接缝的话那条测试只能断言「异常类存在」——那是恒绿，
    // 而「测试恒绿」正是这个项目栽过五次的病。
    maxBuffer: Number(process.env.ZHUPI_GIT_MAXBUFFER) || 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** git 输出超过 maxBuffer。**不能当成「文件不存在」** —— 那是工具故障不是体例结论。 */
export class GitOutputTooLarge extends Error {}

/**
 * 区分「这个 ref 下没有这个东西」和「git 跑不起来」。
 *
 * 上一版一律 `catch { return null }`，于是 ENOBUFS（输出超限）被静默降级成
 * 「文件不存在」—— 双向都错：谎报缺译本 + 让规则 4 整条不跑。
 * 把 maxBuffer 从 1 MiB 抬到 64 MiB 只是把门槛挪远了，病灶还在（第二轮评审指出）。
 */
function classify(e: unknown): 'missing' | never {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOBUFS') throw new GitOutputTooLarge('git 输出超过 64 MB —— 这是工具限制，不是「文件不存在」');
  return 'missing';
}

/** 跑 git 拿**标量**（sha / 计数 / 路径清单），去掉尾部换行。取不到返回 null。 */
function tryGit(cwd: string, args: string[]): string | null {
  try {
    return raw(cwd, args).trimEnd();
  } catch (e) {
    classify(e);
    return null;
  }
}

/**
 * 跑 git 拿**文件内容**，一个字节都不动。
 *
 * 不能复用 tryGit：它 trimEnd 掉尾部换行，那是**静默改内容**。
 * 实测后果：`git show` 出来的正文与文件不一致，测试拿真实内容比就挂 ——
 * 而如果测试当时是拿 trim 过的期望值写的，这个偏差会一直躺着。
 */
function tryFile(cwd: string, args: string[]): string | null {
  try {
    return raw(cwd, args);
  } catch (e) {
    classify(e);
    return null;
  }
}

export function collect(opts: SnapshotOpts = {}): Snapshot {
  const cwd = opts.worktree ?? process.cwd();
  const ref = opts.ref ?? 'HEAD';
  const base = opts.base ?? 'origin/main';

  if (tryGit(cwd, ['rev-parse', '--git-dir']) === null) {
    throw new NotAGitWorktree(`不是 git 工作树：${cwd}`);
  }

  // fetch 失败不阻断（网络断了也该能跑），但要如实报出来 —— 老脚本 `|| true` 静默继续。
  const fetchFailed = opts.skipFetch === true ? false : tryGit(cwd, ['fetch', '-q', 'origin']) === null;

  const baseSha = tryGit(cwd, ['merge-base', base, ref]);
  const baseHead = tryGit(cwd, ['rev-parse', base]);
  let behind = 0;
  if (baseSha !== null && baseHead !== null && baseSha !== baseHead) {
    behind = Number(tryGit(cwd, ['rev-list', '--count', `${baseSha}..${baseHead}`]) ?? '0') || 0;
  }

  // pathspec `docs/*.md` 里的 `*` **跨 `/`**，所以子目录里的 md 也会命中 ——
  // 与老脚本一致（第一轮评审实测；我原来的注释写「不递归」是错的）。
  // 已知后果：子目录文档的图片引用仍按 `docs/assets/` 解析，而 GitHub 按相对路径解析，
  // 两边不一致。这是从老脚本继承的洞，改它属于扩大范围 —— 记在 BACKLOG，不在 Phase 2 内。
  const diff = tryGit(cwd, ['diff', '--name-only', `${base}...${ref}`, '--', 'docs/*.md']) ?? '';
  const changed = diff.split('\n').map((s) => s.trim()).filter(Boolean).sort();

  const files = new Map<string, string>();
  for (const f of changed) {
    const content = tryFile(cwd, ['show', `${ref}:${f}`]);
    if (content !== null) files.set(f, content);
  }

  // 双语对要查**对面那一半在不在**，而它可能没被本折改动（比如只改了中文版）。
  // 所以对每个 slug 的两边都探一次存在性，不只看 changed。
  for (const f of [...changed]) {
    const other = f.endsWith('.zh-CN.md') ? f.replace(/\.zh-CN\.md$/, '.md') : f.replace(/\.md$/, '.zh-CN.md');
    if (files.has(other)) continue;
    const content = tryFile(cwd, ['show', `${ref}:${other}`]);
    if (content !== null) files.set(other, content);
  }

  // 仓里真实存在的文件（相对 docs/）。
  // **扫整个 docs/ 而不是只扫 docs/assets/** —— 图片引用现在按文档自身目录解析
  // （与 zhupi `render.js:26` 一致），子目录文档会解析出 `sub/assets/p.png` 这种路径，
  // 只扫 docs/assets/ 的话查不到（第三轮评审）。
  const tree = tryGit(cwd, ['ls-tree', '-r', '--name-only', ref, 'docs/']) ?? '';
  const assets = new Set(
    tree.split('\n').map((s) => s.trim()).filter(Boolean).map((p) => p.replace(/^docs\//, '')),
  );

  // .payload：老脚本查 docs/.payload 和 .payload 两个位置。
  const payload = [
    tryGit(cwd, ['show', `${ref}:docs/.payload`]),
    tryGit(cwd, ['show', `${ref}:.payload`]),
  ]
    .filter((s): s is string => s !== null)
    .flatMap((s) => s.split('\n'))
    .map((s) => s.trim())
    .filter(Boolean);

  // 单语读物登记表。与 .payload 同一个形状。
  const monolingual = (tryGit(cwd, ['show', `${ref}:docs/.monolingual`]) ?? '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

  const onMain = new Set(changed.filter((f) => tryGit(cwd, ['cat-file', '-e', `${base}:${f}`]) !== null));

  return {
    files,
    changed,
    assets,
    payload,
    monolingual,
    onMain,
    base: { behind, fetchFailed },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  };
}

/**
 * docs 下有未提交的改动吗。
 *
 * 为什么单列：snapshot 读的是**提交过的**内容（`git show <ref>:<path>`），
 * 而老脚本读工作树。正常流程里 `open-folder.sh` 在 commit+push 之后才跑，两者相同；
 * 但要是有人改完没提交就呈折，新旧结论会不一样 —— 那是差异不是 bug，
 * 所以 CLI 会提醒一句，而不是悄悄按提交过的内容判。
 */
export function dirtyDocs(worktree?: string): string[] {
  const cwd = worktree ?? process.cwd();
  const out = tryGit(cwd, ['status', '--porcelain', '--', 'docs/']) ?? '';
  return out.split('\n').map((s) => s.slice(3).trim()).filter(Boolean);
}

/** 巡检用：敕草仓里所有 open 折的分支名，靠调用方给。 */
export function branchExists(worktree: string, ref: string): boolean {
  return tryGit(worktree, ['rev-parse', '--verify', '--quiet', ref]) !== null;
}
