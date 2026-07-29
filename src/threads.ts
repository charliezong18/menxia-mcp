// 纯逻辑：原始 GitHub payload → 批注串 + 作者判定 + answered。
// 无 IO、无网络 import。这是 Phase 1 唯一「写错了不报错、只是答案悄悄不对」的模块。
//
// 作者判定的依据见 design §3.0：
//   zhupi 提交批注走 POST /pulls/{n}/reviews，review body 固定为「御笔朱批 · N 条」；
//   agent 回话走 /comments/{id}/replies，GitHub 为它自动建一个 body 为空的 review。
//   而 zhupi 没有任何发 reply 的代码路径。
// 所以 pull_request_review_id 回查 review body 即可判作者，且追溯有效。

export const DESK_MARK = /^御笔朱批/;

/**
 * zhupi 的降级路径（zhupi/src/ui.js:545-553）：草稿写于旧版本（`stale = d.ref !== ref`）
 * 或行号锚不到可批注行时，那些朱批**不进 inline，被塞进 review body**，前缀是这一句。
 *
 * 两个后果，都严重且静默：
 *   ① 只要有一条降级，整个 review body 就不再是「御笔朱批 · N 条」——
 *      这一批里**成功锚上的**批注会被判成非朱批台 → answered=true → 看不见；
 *   ② 若全部降级，review 里零条 comment，他写的东西只存在于 body 里 → 工具直接说「这折没事」。
 * 而「隔夜草稿 + agent 推过改版」正是最常见的形态。
 */
export const DESK_FALLBACK_MARK = /^以下朱批锚定不到可批注行/;

export const isDeskBody = (body: string): boolean => DESK_MARK.test(body) || DESK_FALLBACK_MARK.test(body);

// —— 原始形状（只声明真正用到的字段，故意不引 Octokit 类型，保持本模块可脱离网络测试）——

export interface RawReview {
  id: number;
  body?: string | null;
  submitted_at?: string | null;
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
  /** LEFT = 批注锚在被删除的那一行上；RIGHT/缺省 = 锚在新文件上 */
  side?: string | null;
  original_side?: string | null;
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
  /** 它的根批注不在结果里（被删或被截断）。形状怪，但总比整条消失强。 */
  orphan?: boolean;
  answered: boolean;
}

export type ConversationVerdict = 'inferred' | 'unknown';

export interface ConversationItem {
  id: number;
  body: string;
  author: string | null;
  createdAt: string;
  /** true = 确定是他发的（zhupi 降级并入总批的朱批）。普通总批判不了，为 false。 */
  fromDesk?: boolean;
  /**
   * 会话区没有任何判别信号（createIssueComment 裸发 body），所以：
   *   inferred = 它后面还有别的总批，推测有人接过话了
   *   unknown  = 它是最后一条，无法判定是他的新意见还是我的回话
   * 永不返回 true/false —— 要等 Phase 3 埋标记才谈得上确定。
   */
  answered: ConversationVerdict;
}

export interface Counts {
  /** 确定要我处理：他发的、一条回话都没有的 inline 批注 */
  needsReply: number;
  /** 判不了：账号共用导致无法确定是他的新话还是我方回话。**必须配合 attention 的预览看** */
  unclear: number;
  /**
   * 后面还有别的总批。**不代表已回**——他连发两条时第一条也会落这里。
   * v1 管这叫 inferred（「推测已回」），第二轮评审判定那是在撒谎，故改名。
   */
  hasFollowUp: number;
}

/**
 * 需要人看一眼的东西，带正文预览。
 *
 * 存在的理由（第二轮可用性评审）：光给数字答不了「哪些折在等我」。
 * 实测 #9 的 counts 是 0/1/0，而那条 unknown 的正文是「文档是不是有点旧了。」——
 * 他发的、没人回过的真问题。数字全 0，模型看到就跳过了。
 * 把预览带上，一眼就能判，不用再调一次 read_comments。
 */
export interface AttentionItem {
  kind: 'inline' | 'conversation';
  id: number;
  preview: string;
  createdAt: string;
  why: 'no-reply' | 'last-word-unclear' | 'reply-author-unclear';
}

const PREVIEW_LEN = 80;
export const preview = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LEN ? `${flat.slice(0, PREVIEW_LEN)}…` : flat;
};

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
  return isDeskBody(bodies.get(rid) ?? '');
}

/**
 * 被 zhupi 降级塞进 review body 的朱批。zhupi 自己的说法就是「并入总批」，
 * 所以按总批处理——而且这类**确定是他发的**（带 zhupi 的前缀），作者不用猜。
 */
export function deskFallbackNotes(reviews: RawReview[]): RawIssueComment[] {
  return reviews
    .filter((r) => DESK_FALLBACK_MARK.test(r.body ?? ''))
    .map((r) => ({
      id: r.id,
      body: (r.body ?? '').replace(DESK_FALLBACK_MARK, '（朱批锚不到行，zhupi 并入总批）'),
      created_at: r.submitted_at ?? '',
      user: null,
    }));
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
export function quoteFromHunk(hunk: string | null | undefined, span = 1, side: 'LEFT' | 'RIGHT' = 'RIGHT'): string {
  if (!hunk) return '';
  let lines = hunk.split('\n');
  // no-newline 标记要**全部**过滤，不只是末行——它出现在中间时会被当正文混进引文。
  lines = lines.filter((l) => l.trim() !== NO_NEWLINE);
  if (lines[0]?.startsWith('@@')) lines = lines.slice(1);
  // 取哪一侧由 side 决定：
  //   RIGHT（默认）= 锚在新文件上 → 留上下文行与新增行，滤掉 '-'
  //   LEFT          = 锚在**被删除的那一行**上 → 留上下文行与删除行，滤掉 '+'
  // 第二轮评审抓到：v2 无条件滤 '-'，于是「他批的正是那句被删掉的话」时，
  // 引文会变成紧随其后的新增行——引了一句他根本没划的话，而且是静默的。
  const drop = side === 'LEFT' ? '+' : '-';
  const picked = lines.filter((l) => l.length === 0 || l[0] !== drop);
  const pool = picked.length > 0 ? picked : lines;
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

  // 孤儿回话：in_reply_to_id 指向的根不在本次结果里（根被删、或分页截断）。
  // 静默丢掉就是丢数据——errors.ts 自己写着「回话变孤儿，凭空多出未回」是要防的事。
  const rootIds = new Set(roots.map((r) => r.id));
  const orphans = comments.filter((c) => !isRoot(c) && c.in_reply_to_id != null && !rootIds.has(c.in_reply_to_id));

  const built = roots.map((r) => {
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
      quote: quoteFromHunk(r.diff_hunk, span, (r.side ?? r.original_side) === 'LEFT' ? 'LEFT' : 'RIGHT'),
      body: r.body,
      createdAt: r.created_at,
      replies,
      // 我方自己发的根批注不算「待我回」（R4 第三条）
      answered: fromDesk ? lastIsOurs : true,
    };
  });

  // 孤儿挂成独立串，宁可形状怪也不让批注消失。
  const orphanThreads: InlineThread[] = orphans.map((c) => ({
    id: c.id,
    path: c.path,
    line: c.line ?? c.original_line ?? null,
    startLine: c.start_line ?? c.original_start_line ?? null,
    fromDesk: isFromDesk(c, bodies),
    outdated: c.line == null,
    quote: quoteFromHunk(c.diff_hunk, 1, (c.side ?? c.original_side) === 'LEFT' ? 'LEFT' : 'RIGHT'),
    body: c.body,
    createdAt: c.created_at,
    replies: [],
    orphan: true,
    answered: false,
  }));

  return [...built, ...orphanThreads];
}

// —— 总批 ——

export function classifyConversation(
  items: RawIssueComment[],
  deskNotes: RawIssueComment[] = [],
): ConversationItem[] {
  const deskIds = new Set(deskNotes.map((d) => d.id));
  const sorted = [...items, ...deskNotes].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return sorted.map((c, i) => ({
    id: c.id,
    body: c.body,
    author: c.user?.login ?? null,
    createdAt: c.created_at,
    fromDesk: deskIds.has(c.id),
    // 降级来的确定是他发的：后面有别的总批才算可能被接过话，否则就是确定要回。
    answered: i < sorted.length - 1 ? 'inferred' : 'unknown',
  }));
}

// —— 计数 ——

export function countsOf(inline: InlineThread[], conversation: ConversationItem[]): Counts {
  return {
    needsReply:
      inline.filter((t) => t.fromDesk && t.replies.length === 0).length +
      // 降级并入总批的朱批**确定是他发的**，后面没人接话就是确定要回。
      conversation.filter((c) => c.fromDesk && c.answered === 'unknown').length,
    // 判不了的：① 最后一条普通总批；② 非朱批台来源的根批注（他从 GitHub 网页发的）；
    // ③ **朱批根批注、有回话、但最后一句不是从朱批台来的**——
    //    他从网页在串里回一句，与我方回话完全同形。第三轮评审指出这条最坏：
    //    他一开口，串反而变成「已回」，工具比他不说话时更安静。
    unclear:
      conversation.filter((c) => !c.fromDesk && c.answered === 'unknown').length +
      inline.filter((t) => !t.fromDesk).length +
      inline.filter((t) => t.fromDesk && t.replies.length > 0).length,
    hasFollowUp: conversation.filter((c) => c.answered === 'inferred').length,
  };
}

/** 把「要人看一眼」的东西连正文预览一起摘出来。 */
export function attentionOf(inline: InlineThread[], conversation: ConversationItem[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const t of inline) {
    if (t.fromDesk && t.replies.length === 0) {
      out.push({ kind: 'inline', id: t.id, preview: preview(t.body), createdAt: t.createdAt, why: 'no-reply' });
    } else if (!t.fromDesk) {
      // 非朱批台来源：他从 GitHub 网页发的批注与我方自己发的完全同形，判不了。
      out.push({ kind: 'inline', id: t.id, preview: preview(t.body), createdAt: t.createdAt, why: 'last-word-unclear' });
    } else if (t.replies.length > 0) {
      // 朱批根 + 有回话：最后那句到底是我方回的还是他从网页追的，判不了。
      // 预览取**最后一条回话**——「我方回话：已改」和「不对，我说的是第二段」一眼可分。
      const last = t.replies[t.replies.length - 1]!;
      out.push({ kind: 'inline', id: t.id, preview: preview(last.body), createdAt: last.createdAt, why: 'reply-author-unclear' });
    }
  }
  for (const c of conversation) {
    if (c.answered === 'unknown') {
      out.push({
        kind: 'conversation',
        id: c.id,
        preview: preview(c.body),
        createdAt: c.createdAt,
        why: c.fromDesk ? 'no-reply' : 'last-word-unclear',
      });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
