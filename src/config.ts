// 敕草仓是配置不是常量——本仓是公开的，别把私有仓名焊死在代码里。

import { fail } from './errors.js';

export interface RepoRef {
  owner: string;
  repo: string;
  slug: string;
}

export const DEFAULT_REVIEW_REPO = 'charliezong18/review';

/** 敕草仓的本地 checkout。**只有 worktree.ts 该用它**（SPEC §4.2）。 */
export function reviewPath(env: NodeJS.ProcessEnv = process.env): string {
  const p = (env.ZHUPI_REVIEW_PATH || '').trim();
  if (p) return p;
  const home = (env.HOME || '').trim();
  // HOME 都没有就别猜了 —— 猜出来的路径要么不存在（还好），要么恰好是别的仓（很糟）。
  if (!home) return fail({ kind: 'badInput', what: 'HOME 没设，也没给 ZHUPI_REVIEW_PATH' });
  return `${home}/Developer/review`;
}

export function reviewRepo(env: NodeJS.ProcessEnv = process.env): RepoRef {
  const slug = (env.ZHUPI_REVIEW_REPO || DEFAULT_REVIEW_REPO).trim();
  const [owner, repo] = slug.split('/');
  if (!owner || !repo || slug.split('/').length !== 2) {
    // 抛分类错误而不是裸 Error：裸 Error 会被 index.ts 包成「出了点没预料到的问题」，
    // 而配环境变量是这个工具最常见的一次性操作、第一次配错概率最高（第二轮评审实证）。
    return fail({ kind: 'badInput', what: `ZHUPI_REVIEW_REPO 得写成 owner/repo，现在是：${slug}` });
  }
  return { owner, repo, slug };
}
