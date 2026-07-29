// 纯逻辑：原始 GitHub payload → 批注串 + 作者判定 + answered。
// 无 IO、无网络 import。这是 Phase 1 唯一「写错了不报错、只是答案悄悄不对」的模块。
//
// 作者判定的依据见 design §3.0：
//   zhupi 提交批注走 POST /pulls/{n}/reviews，review body 固定为「御笔朱批 · N 条」；
//   agent 回话走 /comments/{id}/replies，GitHub 为它自动建一个 body 为空的 review。
//   而 zhupi 没有任何发 reply 的代码路径。
// 所以 pull_request_review_id 回查 review body 即可判作者，且追溯有效。

export const DESK_MARK = /^御笔朱批/;

// —— 原始形状（只声明真正用到的字段，故意不引 Octokit 类型，保持本模块可脱离网络测试）——

export interface RawReview {
  id: number;
  body?: string | null;
}

export interface RawInlineComment {
  id: number;
  pull_request_review_id?: number | null;
  /** 根批注**没有这个 key**（实测 #17 四条里两条缺失），不是 null。用 == null 兜住两者。 */
  in_reply_to_id?: number | null;
  path: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  original_start_line?: number | null;
  diff_hunk?: string | null;
  body: string;
  created_at: string;
  commit_id?: string | null;
}

export interface RawIssueComment {
  id: number;
  body: string;
  created_at: string;
  user?: { login?: string } | null;
}

// —— 输出形状 ——

export interface InlineReply {
  id: number;
  body: string;
  createdAt: string;
  /** 这句是不是他从朱批台说的（true = 他的反驳/追问，不是我方回话） */
  fromDesk: boolean;
}

export interface InlineThread {
  id: number;
  path: string;
  /** 批注后若推了改版，GitHub 对 outdated 批注返回 line: null，此时回退 original_line */
  line: number | null;
  startLine: number | null;
  /** 是不是从朱批台呈上来的（= 他的批注）。false 表示这条根批注是我方自己发的。 */
  fromDesk: boolean;
  outdated: boolean;
  quote: string;
  body: string;
  createdAt: string;
  replies: InlineReply[];
  answered: boolean;
}

export type ConversationVerdict = 'inferred' | 'unknown';

export interface ConversationItem {
  id: number;
  body: string;
  author: string | null;
  createdAt: string;
  /**
   * 会话区没有任何判别信号（createIssueComment 裸发 body），所以：
   *   inferred = 它后面还有别的总批，推测有人接过话了
   *   unknown  = 它是最后一条，无法判定是他的新意见还是我的回话
   * 永不返回 true/false —— 要等 Phase 3 埋标记才谈得上确定。
   */
  answered: ConversationVerdict;
}

export interface Counts {
  /** 确定未回：他发的、没有我方回话的 inline 批注 */
  unanswered: number;
  /** 待定：最后一条总批 */
  unknown: number;
  /** 推测已回的总批，仅供参考 */
  inferred: number;
}

// —— 作者判定 ——

export function reviewBodyById(reviews: RawReview[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const r of reviews) m.set(r.id, r.body ?? '');
  return m;
}

/** 这条 inline comment 是不是从朱批台呈上来的（= Charlie 的批注）。 */
export function isFromDesk(c: RawInlineComment, bodies: Map<number, string>): boolean {
  const rid = c.pull_request_review_id;
  if (rid == null) return false;
  return DESK_MARK.test(bodies.get(rid) ?? '');
}

/** 根批注：in_reply_to_id 缺失或为 null。**不能写 === null**，实测该 key 会整个缺失。 */
export const isRoot = (c: RawInlineComment): boolean => c.in_reply_to_id == null;

// —— 引文 ——

const NO_NEWLINE = '\\ No newline at end of file';

/**
 * 从 diff_hunk 取被锚定的原文。
 * hunk 每行行首带 diff 标记（' ' / '+' / '-'），必须剥掉，否则引文会以 '+' 开头。
 * span > 1 用于多行划选。
 */
export function quoteFromHunk(hunk: string | null | undefined, span = 1): string {
  if (!hunk) return '';
  let lines = hunk.split('\n');
  // no-newline 标记要**全部**过滤，不只是末行——它出现在中间时会被当正文混进引文。
  lines = lines.filter((l) => l.trim() !== NO_NEWLINE);
  if (lines[0]?.startsWith('@@')) lines = lines.slice(1);
  // span 数的是**新文件**的行数，所以必须先滤掉删除行（'-'），只留上下文行与新增行。
  // v1 直接取 hunk 末尾 span 行，在有删改的文件上会把已删除的旧文算进引文、
  // 同时漏掉真正被划中的首行（评审用 '@@ -10,4 +10,4 @@ ctx/-old1/-old2/+new1/+new2' 实证）。
  const newSide = lines.filter((l) => l.length === 0 || l[0] !== '-');
  const pool = newSide.length > 0 ? newSide : lines;
  if (pool.length === 0) return '';
  const take = Math.max(1, Math.min(span, pool.length));
  return pool
    .slice(pool.length - take)
    .map((l) => (l.length > 0 && (l[0] === '+' || l[0] === '-' || l[0] === ' ') ? l.slice(1) : l))
    .join('\n');
}

// —— 串还原 ——

export function buildInlineThreads(
  comments: RawInlineComment[],
  reviews: RawReview[],
  headSha?: string | null,
): InlineThread[] {
  const bodies = reviewBodyById(reviews);
  // **所有**根批注都建串，不只是朱批台来的。
  // v1 只保留 desk 根，导致「我方发了根批注、他在网页/手机上回了一句」时，
  // 他那句话在输出里彻底不存在——那是丢数据，不只是计数错（评审实证）。
  const roots = comments.filter(isRoot);

  const repliesByRoot = new Map<number, RawInlineComment[]>();
  for (const c of comments) {
    if (isRoot(c)) continue;
    const rootId = c.in_reply_to_id;
    if (rootId == null) continue;
    const arr = repliesByRoot.get(rootId) ?? [];
    arr.push(c);
    repliesByRoot.set(rootId, arr);
  }

  return roots.map((r) => {
    const line = r.line ?? r.original_line ?? null;
    const startLine = r.start_line ?? r.original_start_line ?? null;
    const span = line != null && startLine != null && line >= startLine ? line - startLine + 1 : 1;
    const replies = (repliesByRoot.get(r.id) ?? [])
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((x) => ({ id: x.id, body: x.body, createdAt: x.created_at, fromDesk: isFromDesk(x, bodies) }));
    const fromDesk = isFromDesk(r, bodies);
    // 「已回」= 串里**最后一句是我方说的**。
    // 只看「有没有 reply」会被他的反驳骗过去（GitHub 把整串 reply 都指向根，
    // 他在串里再反驳一句，整串就显示成已回，而那恰恰是最要紧的一条）。
    // 只看「有没有我方 reply」同样会：他反驳在后，串仍然算已回。
    const lastIsOurs = replies.length > 0 && !replies[replies.length - 1]!.fromDesk;
    return {
      id: r.id,
      path: r.path,
      line,
      startLine,
      fromDesk,
      // 优先信 GitHub 自己的信号：line 非 null 就说明这条还锚在当前 diff 上。
      // commit_id 只作兜底——v1 只有 commit_id 那一支，而测试从不传 headSha，
      // 于是生产走的分支在测试里覆盖率为 0（评审用变异测试实证：判据写反也全绿）。
      outdated: r.line != null ? false : headSha != null && r.commit_id != null ? r.commit_id !== headSha : true,
      quote: quoteFromHunk(r.diff_hunk, span),
      body: r.body,
      createdAt: r.created_at,
      replies,
      // 我方自己发的根批注不算「待我回」（R4 第三条）
      answered: fromDesk ? lastIsOurs : true,
    };
  });
}

// —— 总批 ——

export function classifyConversation(items: RawIssueComment[]): ConversationItem[] {
  const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return sorted.map((c, i) => ({
    id: c.id,
    body: c.body,
    author: c.user?.login ?? null,
    createdAt: c.created_at,
    answered: i < sorted.length - 1 ? 'inferred' : 'unknown',
  }));
}

// —— 计数 ——

export function countsOf(inline: InlineThread[], conversation: ConversationItem[]): Counts {
  return {
    // 只数「他发的、我方还没回」的。我方自己发的根批注 answered 恒为 true，不进这里。
    unanswered: inline.filter((t) => t.fromDesk && !t.answered).length,
    unknown: conversation.filter((c) => c.answered === 'unknown').length,
    inferred: conversation.filter((c) => c.answered === 'inferred').length,
  };
}
