// 组装层：把 github.ts 取来的原始数据喂给 threads.ts，产出对外形状。
//
// 两个工具共用这一条路径（design §2）。若各算各的，逻辑迟早分叉，
// 而「列折说 3 条未回、读批注只列出 2 条」这种矛盾极难发现。

import { reviewRepo, type RepoRef } from './config.js';
import { get, repoReadable } from './github.js';
import { fail } from './errors.js';
import {
  buildInlineThreads,
  classifyConversation,
  countsOf,
  type Counts,
  type ConversationItem,
  type InlineThread,
  type RawInlineComment,
  type RawIssueComment,
  type RawReview,
} from './threads.js';

export interface FolderSummary {
  number: number;
  title: string;
  headRefName: string;
  counts: Counts;
}

export interface FolderDetail extends FolderSummary {
  headSha: string;
  inline: InlineThread[];
  conversation: ConversationItem[];
}

interface RawPull {
  number: number;
  title: string;
  head: { ref: string; sha: string };
  merged_at: string | null;
}

const PER_PAGE = 100;

async function listPulls(ref: RepoRef, state: 'open' | 'merged'): Promise<RawPull[]> {
  // REST 只有 open|closed|all。merged 不是枚举值——直接用 closed 会把「打回关闭」的折
  // 当成已钦此（实测 #10 就是这种）。所以取 closed 再按 merged_at 过滤。
  const pulls = await get<RawPull[]>(
    'GET /repos/{owner}/{repo}/pulls',
    { owner: ref.owner, repo: ref.repo, state: state === 'merged' ? 'closed' : 'open', per_page: PER_PAGE },
    { pageGuard: { kind: 'tooMany', repo: ref.slug, pr: 0 } },
  );
  return state === 'merged' ? pulls.filter((p) => p.merged_at != null) : pulls;
}

/**
 * 404 消歧：GitHub 对「仓不存在」「私有仓无权限」「折号不存在」返回的**都是 404**。
 * 不分清楚的话，折号敲错的人会被告知「去查权限」——正好把人指反（design §6）。
 * 规则：收到 404 先探一次仓，仓读得到才归为「折号不存在」。
 */
async function getPull(ref: RepoRef, pr: number): Promise<RawPull> {
  try {
    return await get<RawPull>('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: pr,
    });
  } catch (e) {
    if ((e as { info?: { kind?: string } }).info?.kind !== 'notFound') throw e;
    if (await repoReadable(ref.owner, ref.repo)) return fail({ kind: 'notFound', repo: ref.slug, pr });
    return fail({ kind: 'repo', repo: ref.slug });
  }
}

export async function readFolder(pr: number, ref: RepoRef = reviewRepo()): Promise<FolderDetail> {
  return hydrate(ref, await getPull(ref, pr));
}

async function hydrate(ref: RepoRef, pull: RawPull): Promise<FolderDetail> {
  const base = { owner: ref.owner, repo: ref.repo, per_page: PER_PAGE };
  const guard = { kind: 'tooMany' as const, repo: ref.slug, pr: pull.number };

  const [comments, reviews, issueComments] = await Promise.all([
    get<RawInlineComment[]>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      { ...base, pull_number: pull.number },
      { pageGuard: guard },
    ),
    get<RawReview[]>('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
      ...base,
      pull_number: pull.number,
    }),
    get<RawIssueComment[]>(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { ...base, issue_number: pull.number },
      { pageGuard: guard },
    ),
  ]);

  const inline = buildInlineThreads(comments, reviews, pull.head.sha);
  const conversation = classifyConversation(issueComments);
  return {
    number: pull.number,
    title: pull.title,
    headRefName: pull.head.ref,
    headSha: pull.head.sha,
    inline,
    conversation,
    counts: countsOf(inline, conversation),
  };
}

export async function readAll(
  state: 'open' | 'merged' = 'open',
  ref: RepoRef = reviewRepo(),
): Promise<FolderDetail[]> {
  const pulls = await listPulls(ref, state);
  return Promise.all(pulls.map((p) => hydrate(ref, p)));
}

/** list_folders 只是 readFolder 的投影——不另写计数逻辑（design §2）。 */
export const summarize = (d: FolderDetail): FolderSummary => ({
  number: d.number,
  title: d.title,
  headRefName: d.headRefName,
  counts: d.counts,
});
