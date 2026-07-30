// 组装层：把 github.ts 取来的原始数据喂给 threads.ts，产出对外形状。
//
// 两个工具共用这一条路径（design §2）。若各算各的，逻辑迟早分叉，
// 而「列折说 3 条未回、读批注只列出 2 条」这种矛盾极难发现。

import { reviewRepo, type RepoRef } from './config.js';
import { get, repoReadable } from './github.js';
import { fail, redact } from './errors.js';
import { handledIds, load, type ProcessedStore } from './processed.js';
import {
  attentionOf,
  buildInlineThreads,
  classifyConversation,
  countsOf,
  deskFallbackNotes,
  conversationEntriesOf,
  preview,
  type AttentionItem,
  type Counts,
  type ConversationItem,
  type InlineThread,
  type RawInlineComment,
  type RawIssueComment,
  type RawReview,
} from './threads.js';

export interface FolderSummary {
  /** 判别字段：坏折是 ok:false，形状完全不同。第二轮评审指出联合类型直接泄漏给模型会 TypeError。 */
  ok: true;
  number: number;
  title: string;
  headRefName: string;
  /** 最近活动时间。「哪些折在等我」隐含的是「按最近动过排」，没有它模型连自己排都排不了。 */
  updatedAt: string;
  counts: Counts;
  /** 要人看一眼的东西，带正文预览——光给数字答不了「哪些折在等我」。 */
  attention: AttentionItem[];
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
  updated_at?: string;
  created_at?: string;
}

const PER_PAGE = 100;

async function listPulls(ref: RepoRef, state: 'open' | 'merged'): Promise<RawPull[]> {
  // REST 只有 open|closed|all。merged 不是枚举值——直接用 closed 会把「打回关闭」的折
  // 当成已钦此（实测 #10 就是这种）。所以取 closed 再按 merged_at 过滤。
  const pulls = await get<RawPull[]>(
    'GET /repos/{owner}/{repo}/pulls',
    { owner: ref.owner, repo: ref.repo, state: state === 'merged' ? 'closed' : 'open', per_page: PER_PAGE },
    {
      pageGuard: { kind: 'tooManyFolders', repo: ref.slug },
      // v1 这里没传 notFound，仓名配错时落到默认值，用户看到「 里没有 #0。用 list_folders 看现有折号」
      // ——主语为空、编号不存在、还让人去跑他刚跑的那个工具（评审实证）。
      notFound: { kind: 'repo', repo: ref.slug },
    },
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
    return await get<RawPull>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner: ref.owner, repo: ref.repo, pull_number: pr },
      { pageGuard: { kind: 'unknown', detail: '单折查询不该分页' }, notFound: { kind: 'notFound', repo: ref.slug, pr } },
    );
  } catch (e) {
    if ((e as { info?: { kind?: string } }).info?.kind !== 'notFound') throw e;
    if (await repoReadable(ref.owner, ref.repo)) return fail({ kind: 'notFound', repo: ref.slug, pr });
    return fail({ kind: 'repo', repo: ref.slug });
  }
}

export async function readFolder(pr: number, ref: RepoRef = reviewRepo(), store?: ProcessedStore): Promise<FolderDetail> {
  // store 可注入：不然单测会去读用户真实的 ~/.zhupi-mcp/processed.json（第二轮评审）。
  return hydrate(ref, await getPull(ref, pr), store ?? load().store);
}

async function hydrate(ref: RepoRef, pull: RawPull, store: ProcessedStore): Promise<FolderDetail> {
  const base = { owner: ref.owner, repo: ref.repo, per_page: PER_PAGE };
  const guard = { kind: 'tooManyComments' as const, repo: ref.slug, pr: pull.number };
  const nf = { kind: 'notFound' as const, repo: ref.slug, pr: pull.number };

  const [comments, reviews, issueComments] = await Promise.all([
    get<RawInlineComment[]>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      { ...base, pull_number: pull.number },
      { pageGuard: guard, notFound: nf },
    ),
    // reviews 也必须带页护栏：它是作者判定的**唯一**数据源，截断会让他的根批注
    // 被判成我方 → 整条串从输出里消失 → 未回数少报。v1 恰恰漏在这个 endpoint 上（评审指出）。
    get<RawReview[]>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      { ...base, pull_number: pull.number },
      { pageGuard: guard, notFound: nf },
    ),
    get<RawIssueComment[]>(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { ...base, issue_number: pull.number },
      { pageGuard: guard, notFound: nf },
    ),
  ]);

  const inline = buildInlineThreads(comments, reviews, pull.head.sha);
  // 把 zhupi 降级塞进 review body 的朱批一并捞出来——否则那批话在输出里根本不存在。
  // 第三个参数是本地「已处理」记录：总批的 answered 不再靠位置推断（review#29）。
  const deskNotes = deskFallbackNotes(reviews);
  const entries = conversationEntriesOf([...issueComments, ...deskNotes]);
  const conversation = classifyConversation(issueComments, deskNotes, handledIds(store, pull.number, entries))
    .map(capBody);
  return {
    ok: true,
    number: pull.number,
    title: pull.title,
    headRefName: pull.head.ref,
    updatedAt: pull.updated_at ?? pull.created_at ?? '',
    headSha: pull.head.sha,
    inline,
    conversation,
    counts: countsOf(inline, conversation),
    attention: attentionOf(inline, conversation),
  };
}

/**
 * 一折读失败**不能**拖垮整个列表。
 * v1 用 Promise.all，评审实证：一折批注超 100 条 → 页护栏抛错 → list_folders 与
 * read_comments 双双返回零折，另外健康的折全读不到。design 里「宁可明着失败」
 * 的本意是**单折**明着失败，不是全仓不可用。
 */
export async function readAll(
  state: 'open' | 'merged' = 'open',
  ref: RepoRef = reviewRepo(),
): Promise<Array<FolderDetail | FolderError>> {
  const pulls = await listPulls(ref, state);
  const store = load().store;
  const settled = await Promise.allSettled(pulls.map((p) => hydrate(ref, p, store)));
  const out = settled.map((r, i): FolderDetail | FolderError => {
    if (r.status === 'fulfilled') return r.value;
    const p = pulls[i]!;
    return {
      ok: false,
      number: p.number,
      title: p.title,
      headRefName: p.head.ref,
      // 过一遍 redact：FolderError.error 直接进工具输出，是「脱敏只有唯一出口」的第二个出口。
      error: redact(r.reason instanceof Error ? r.reason.message : String(r.reason)),
    };
  });
  // 按最近活动倒序：实测「唯一有待回的那折 #7」在创建时间序里排最后一个。
  return out.sort((a, b) => (b.ok ? b.updatedAt : '').localeCompare(a.ok ? a.updatedAt : ''));
}

export interface FolderError {
  ok: false;
  number: number;
  title: string;
  headRefName: string;
  error: string;
}

export const isFolderError = (f: FolderDetail | FolderError): f is FolderError => f.ok === false;

/** list_folders 只是 readFolder 的投影——不另写计数逻辑（design §2）。 */
export const summarize = (d: FolderDetail | FolderError): FolderSummary | FolderError =>
  isFolderError(d)
    ? d
    : {
        ok: true,
        number: d.number,
        title: d.title,
        headRefName: d.headRefName,
        updatedAt: d.updatedAt,
        counts: d.counts,
        attention: d.attention,
      };

/** 某折当前全部会话区 comment id —— 灌水位用（一次清空积压）。 */
/**
 * 总批正文超长就截断。
 *
 * 立项理由是省 context，而第三轮评审实测比值从 3.9× 退到 3.47×，机制很具体：
 * `conversation[].body` 不截断，于是 agent 自己那些千字总批被原样搬回 agent 的 context
 * （#30 零 inline 却 6.2 KB）。要逐条回话的场景才需要全文，`attention` 已经有 preview 了。
 */
const BODY_CAP = 600;
function capBody(c: ConversationItem): ConversationItem {
  if (c.body.length <= BODY_CAP) return c;
  return { ...c, body: `${c.body.slice(0, BODY_CAP)}…`, bodyTruncated: true, bodyLength: c.body.length };
}

/**
 * 某折全部总批的 { id, updatedAt, preview, fromDesk }。
 * `mark_handled` 要 updatedAt 记水位；`seed` 要 preview 和 fromDesk 让人看清
 * **将要标掉什么**——评审实测 seed 会连他的朱批一起吞（#9 那句「文档是不是有点旧了」）。
 */
export async function conversationEntries(
  pr: number,
  ref: RepoRef = reviewRepo(),
): Promise<{ id: number; updatedAt: string; preview: string; fromDesk: boolean; answered: string }[]> {
  const d = await readFolder(pr, ref);
  return d.conversation.map((c) => ({
    id: c.id,
    updatedAt: c.updatedAt,
    preview: preview(c.body),
    fromDesk: c.fromDesk === true,
    answered: c.answered,
  }));
}
