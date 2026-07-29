import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildInlineThreads,
  classifyConversation,
  countsOf,
  isRoot,
  isFromDesk,
  reviewBodyById,
  quoteFromHunk,
  type RawInlineComment,
  type RawIssueComment,
  type RawReview,
} from '../src/threads.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = <T>(name: string): T => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8')) as T;

// fixture 一律是真实 API dump，不许手写：根批注的 in_reply_to_id 是 key 缺失而非 null，
// 手编 fixture 会写成 null，实现写 === null 就能过测试而线上全错。
const pr17Comments = fx<RawInlineComment[]>('pr17-comments.json');
const pr17Reviews = fx<RawReview[]>('pr17-reviews.json');
const pr18Conv = fx<RawIssueComment[]>('pr18-issue-comments.json');

describe('fixture 本身的形状（这些断言在保护后面全部测试的前提）', () => {
  it('#17 是 4 条批注 3 个 review', () => {
    expect(pr17Comments).toHaveLength(4);
    expect(pr17Reviews).toHaveLength(3);
  });

  it('根批注的 in_reply_to_id 是 key 缺失，不是 null', () => {
    const roots = pr17Comments.filter((c) => !('in_reply_to_id' in c));
    expect(roots).toHaveLength(2);
  });

  it('line 实测全为 null，真值在 original_line', () => {
    expect(pr17Comments.every((c) => c.line == null)).toBe(true);
    expect(pr17Comments.every((c) => typeof c.original_line === 'number')).toBe(true);
  });
});

describe('作者判定：靠 review body，不靠 user.login', () => {
  it('朱批台呈上来的 review body 带「御笔朱批」', () => {
    const bodies = reviewBodyById(pr17Reviews);
    const desk = pr17Comments.filter((c) => isFromDesk(c, bodies));
    expect(desk).toHaveLength(2);
    expect(desk.every(isRoot)).toBe(true);
  });

  it('我方回话所属的 review body 是空的', () => {
    const bodies = reviewBodyById(pr17Reviews);
    const ours = pr17Comments.filter((c) => !isFromDesk(c, bodies));
    expect(ours).toHaveLength(2);
    expect(ours.every((c) => !isRoot(c))).toBe(true);
  });

  it('把作者字段全抹成同一个值，判定结果不变（证明没读 user.login）', () => {
    const wiped = JSON.parse(JSON.stringify(pr17Comments)) as (RawInlineComment & { user?: unknown })[];
    for (const c of wiped) c.user = { login: 'same-account' };
    const a = buildInlineThreads(pr17Comments, pr17Reviews);
    const b = buildInlineThreads(wiped, pr17Reviews);
    expect(b).toEqual(a);
  });

  it('review id 查不到时保守判为「非朱批台」', () => {
    const bodies = reviewBodyById(pr17Reviews);
    expect(isFromDesk({ ...pr17Comments[0]!, pull_request_review_id: 999999 }, bodies)).toBe(false);
    expect(isFromDesk({ ...pr17Comments[0]!, pull_request_review_id: null }, bodies)).toBe(false);
  });
});

describe('inline 串还原', () => {
  const threads = buildInlineThreads(pr17Comments, pr17Reviews);

  it('#17 得到 2 条他的根批注，各挂 1 条我方回话，全部已回', () => {
    expect(threads).toHaveLength(2);
    expect(threads.map((t) => t.replies.length)).toEqual([1, 1]);
    expect(threads.every((t) => t.answered)).toBe(true);
    expect(countsOf(threads, []).unanswered).toBe(0);
  });

  it('line 回退到 original_line，并标记 outdated', () => {
    expect(threads.map((t) => t.line)).toEqual([65, 92]);
    expect(threads.every((t) => t.outdated)).toBe(true);
  });

  it('引文剥掉了 diff 前缀', () => {
    for (const t of threads) {
      expect(t.quote.startsWith('+')).toBe(false);
      expect(t.quote.startsWith('-')).toBe(false);
    }
    expect(threads[0]!.quote).toContain('阶段 3');
  });

  it('没有回话的他的批注 → 未回', () => {
    const onlyRoots = pr17Comments.filter(isRoot);
    const t = buildInlineThreads(onlyRoots, pr17Reviews);
    expect(t).toHaveLength(2);
    expect(t.every((x) => !x.answered)).toBe(true);
    expect(countsOf(t, []).unanswered).toBe(2);
  });

  it('我方发的根批注：保留在输出里（防丢数据）但不计入待回', () => {
    const ourRoot: RawInlineComment = {
      ...pr17Comments[0]!,
      id: 111,
      pull_request_review_id: pr17Reviews.find((r) => !r.body)!.id,
    };
    delete (ourRoot as { in_reply_to_id?: unknown }).in_reply_to_id;
    const t = buildInlineThreads([...pr17Comments, ourRoot], pr17Reviews);
    // 第一轮代码评审指出：v1 只保留 desk 根，导致「我方发根批注、他在网页上回一句」时
    // 他那句话在输出里彻底不存在——那是丢数据不是计数错。所以现在保留，只是不计入未回。
    const mine = t.find((x) => x.id === 111)!;
    expect(mine).toBeTruthy();
    expect(mine.fromDesk).toBe(false);
    expect(mine.answered).toBe(true);
    expect(countsOf(t, []).unanswered).toBe(0);
  });

  it('我方根批注下面他的回话不会被丢掉', () => {
    const emptyReviewId = pr17Reviews.find((r) => !r.body)!.id;
    const ourRoot: RawInlineComment = { ...pr17Comments[0]!, id: 444, pull_request_review_id: emptyReviewId };
    delete (ourRoot as { in_reply_to_id?: unknown }).in_reply_to_id;
    const hisReply: RawInlineComment = { ...pr17Comments[2]!, id: 555, in_reply_to_id: 444, body: '这里我不同意' };
    const t = buildInlineThreads([ourRoot, hisReply], pr17Reviews);
    expect(JSON.stringify(t)).toContain('这里我不同意');
  });

  it('串再长也不会因为他在里面反驳就变成已回——他的反驳走的是新根批注', () => {
    // GitHub 把整串 reply 都指向根。若照 v1「有 reply 就算已回」，
    // 他在串里的反驳会让整串显示成已回。v2 靠作者判，反驳若来自朱批台则是新根。
    const deskReviewId = pr17Reviews.find((r) => /御笔朱批/.test(r.body ?? ''))!.id;
    const hisRebuttal: RawInlineComment = {
      ...pr17Comments[2]!,
      id: 222,
      pull_request_review_id: deskReviewId, // 来自朱批台
    };
    const t = buildInlineThreads([...pr17Comments, hisRebuttal], pr17Reviews);
    // 断言必须落在**这条反驳真正挂着的那个根**上。
    // 第一轮代码评审抓到：v1 断言在另一条串上，于是把 desk 守卫整行删掉测试依然全绿。
    const root = t.find((x) => x.id === hisRebuttal.in_reply_to_id)!;
    expect(root).toBeTruthy();
    // 他的反驳**保留在串里**（不丢数据），但因为串的最后一句是他说的，这条重新变成待回。
    expect(root.replies.map((r) => r.id)).toContain(222);
    expect(root.replies[root.replies.length - 1]!.fromDesk).toBe(true);
    expect(root.answered).toBe(false);
  });

  it('反向自验：把作者判定去掉，上面那条必然变红', () => {
    // 手工模拟「不看作者、有 reply 就算已回」的旧逻辑，确认它会得出错误答案。
    const deskReviewId = pr17Reviews.find((r) => /御笔朱批/.test(r.body ?? ''))!.id;
    const hisRebuttal: RawInlineComment = { ...pr17Comments[2]!, id: 222, pull_request_review_id: deskReviewId };
    const all = [...pr17Comments, hisRebuttal];
    const naive = all.filter((c) => !isRoot(c) && c.in_reply_to_id === hisRebuttal.in_reply_to_id);
    expect(naive.length).toBeGreaterThan(0); // 旧逻辑：「有 reply 就算已回」→ 判成已回
    const t = buildInlineThreads(all, pr17Reviews);
    const root = t.find((x) => x.id === hisRebuttal.in_reply_to_id)!;
    expect(root.answered).toBe(false); // 新逻辑：最后一句是他说的 → 待回
  });

  it('他反驳之后我方再回一句 → 重新变成已回', () => {
    const deskId = pr17Reviews.find((r) => /御笔朱批/.test(r.body ?? ''))!.id;
    const emptyId = pr17Reviews.find((r) => !r.body)!.id;
    const rootId = pr17Comments[1]!.id;
    const rebuttal: RawInlineComment = { ...pr17Comments[2]!, id: 301, in_reply_to_id: rootId, pull_request_review_id: deskId, created_at: '2026-07-29T10:00:00Z' };
    const ourReply: RawInlineComment = { ...pr17Comments[2]!, id: 302, in_reply_to_id: rootId, pull_request_review_id: emptyId, created_at: '2026-07-29T11:00:00Z' };
    const t = buildInlineThreads([...pr17Comments, rebuttal, ourReply], pr17Reviews);
    expect(t.find((x) => x.id === rootId)!.answered).toBe(true);
  });

  it('outdated 走生产分支（传 headSha）—— 变异测试盲区', () => {
    // 评审用变异测试证明：v1 的测试从不传 headSha，把 commit_id !== headSha 判反或写死常量，
    // 23 条测试全绿，而生产调用永远传 headSha。
    const sha = pr17Comments[0]!.commit_id!;
    const current: RawInlineComment = { ...pr17Comments[0]!, id: 900, line: 65, commit_id: sha };
    const stale: RawInlineComment = { ...pr17Comments[1]!, id: 901, line: null, commit_id: 'deadbeef' };
    const t = buildInlineThreads([current, stale], pr17Reviews, sha);
    expect(t.find((x) => x.id === 900)!.outdated).toBe(false);
    expect(t.find((x) => x.id === 901)!.outdated).toBe(true);
  });

  it('多条回话按时间排序（fixture 每串只有 1 条，是覆盖盲区）', () => {
    const rootId = pr17Comments[0]!.id;
    const empty = pr17Reviews.find((r) => !r.body)!.id;
    const later: RawInlineComment = { ...pr17Comments[2]!, id: 801, in_reply_to_id: rootId, created_at: '2026-07-29T10:00:00Z', pull_request_review_id: empty };
    const earlier: RawInlineComment = { ...pr17Comments[2]!, id: 802, in_reply_to_id: rootId, created_at: '2026-07-29T09:00:00Z', pull_request_review_id: empty };
    const t = buildInlineThreads([...pr17Comments, later, earlier], pr17Reviews);
    const root = t.find((x) => x.id === rootId)!;
    expect(root.replies.map((r) => r.id).slice(-2)).toEqual([802, 801]);
  });

  it('空输入不抛异常', () => {
    expect(buildInlineThreads([], [])).toEqual([]);
    expect(countsOf([], [])).toEqual({ unanswered: 0, unknown: 0, inferred: 0 });
  });
});

describe('总批：三态，永不返回 true/false', () => {
  it('#18 两条 → 第一条 inferred、第二条 unknown', () => {
    const conv = classifyConversation(pr18Conv);
    expect(conv).toHaveLength(2);
    expect(conv[0]!.answered).toBe('inferred');
    expect(conv[1]!.answered).toBe('unknown');
  });

  it('unknown 不计入 unanswered —— 否则最后一条（几乎永远是我方回话）会被谎报成待办', () => {
    const c = countsOf([], classifyConversation(pr18Conv));
    expect(c.unanswered).toBe(0);
    expect(c.unknown).toBe(1);
    expect(c.inferred).toBe(1);
  });

  it('只有一条 → unknown', () => {
    const conv = classifyConversation([pr18Conv[0]!]);
    expect(conv[0]!.answered).toBe('unknown');
  });

  it('任何输入都不会出现 true 或 false', () => {
    for (const input of [pr18Conv, [pr18Conv[0]!], []]) {
      for (const c of classifyConversation(input)) {
        expect(['inferred', 'unknown']).toContain(c.answered);
      }
    }
  });

  it('按时间排序，不依赖数组原顺序', () => {
    const conv = classifyConversation([...pr18Conv].reverse());
    expect(conv[0]!.createdAt < conv[1]!.createdAt).toBe(true);
    expect(conv[1]!.answered).toBe('unknown');
  });
});

describe('quoteFromHunk', () => {
  it('剥掉行首的 + - 空格', () => {
    expect(quoteFromHunk('@@ -1 +1 @@\n context\n+added')).toBe('added');
    expect(quoteFromHunk('@@ -1 +1 @@\n-removed')).toBe('removed');
    expect(quoteFromHunk('@@ -1 +1 @@\n plain')).toBe('plain');
  });

  it('末行是 no-newline 标记时取上一行', () => {
    expect(quoteFromHunk('@@ -1 +1 @@\n+real\n\\ No newline at end of file')).toBe('real');
  });

  it('多行划选取末尾 span 行', () => {
    expect(quoteFromHunk('@@ -1 +3 @@\n+a\n+b\n+c', 2)).toBe('b\nc');
  });

  it('多行划选要滤掉删除行 —— span 数的是新文件的行数', () => {
    // 评审实证：v1 直接取 hunk 末尾 span 行，在有删改的文件上会把已删除的旧文算进引文，
    // 同时漏掉真正被划中的首行。
    const hunk = '@@ -10,4 +10,4 @@\n ctx-line\n-old1\n-old2\n+new1\n+new2';
    expect(quoteFromHunk(hunk, 3)).toBe('ctx-line\nnew1\nnew2');
  });

  it('no-newline 标记出现在中间也要滤掉', () => {
    expect(quoteFromHunk('@@ -1,2 +1,2 @@\n-old\n\\ No newline at end of file\n+new', 2)).toBe('new');
  });

  it('span 超过可用行数时不越界', () => {
    expect(quoteFromHunk('@@ -1 +1 @@\n+only', 99)).toBe('only');
  });

  it('缺 hunk 返回空串而不是崩', () => {
    expect(quoteFromHunk(undefined)).toBe('');
    expect(quoteFromHunk(null)).toBe('');
    expect(quoteFromHunk('')).toBe('');
  });
});
