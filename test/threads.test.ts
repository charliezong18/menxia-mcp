import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  conversationEntriesOf,
  isOurReply,
  buildInlineThreads,
  classifyConversation,
  countsOf,
  isRoot,
  isFromDesk,
  reviewBodyById,
  quoteFromHunk,
  attentionOf,
  deskFallbackNotes,
  preview,
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
    expect(countsOf(threads, []).needsReply).toBe(0);
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
    expect(countsOf(t, []).needsReply).toBe(2);
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
    expect(countsOf(t, []).needsReply).toBe(0);
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
    expect(countsOf([], [])).toEqual({ needsReply: 0, unclear: 0 });
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

describe('第二轮评审的三处修复', () => {
  it('LEFT 侧批注（锚在被删除的那一行）要引删除行，不能引后面的新增行', () => {
    // 评审实证：v2 无条件滤掉 '-'，于是「他批的正是那句被删掉的话」时，
    // 引文变成紧随其后的新增行——引了一句他根本没划的话，而且是静默的。
    const hunk = '@@ -10,3 +10,2 @@\n ctx\n-这行被删了，他就是在批这一行\n+新行';
    expect(quoteFromHunk(hunk, 1, 'LEFT')).toBe('这行被删了，他就是在批这一行');
    expect(quoteFromHunk(hunk, 1, 'RIGHT')).toBe('新行');
  });

  it('side=LEFT 从 payload 一路传到引文', () => {
    const c: RawInlineComment = {
      ...pr17Comments[0]!,
      id: 700,
      side: 'LEFT',
      diff_hunk: '@@ -1,2 +1,1 @@\n ctx\n-被删的原话\n+替换后的话',
    };
    const t = buildInlineThreads([c], pr17Reviews);
    expect(t[0]!.quote).toBe('被删的原话');
  });

  it('孤儿回话不再被静默丢弃', () => {
    // 根被删或分页截断时，reply 的 in_reply_to_id 指向不存在的 comment。
    // v2 只在 roots.map 里查 repliesByRoot，孤儿在输出里彻底不存在。
    const orphan: RawInlineComment = { ...pr17Comments[2]!, id: 990, in_reply_to_id: 123456789, body: '他的追问' };
    const t = buildInlineThreads([pr17Comments[0]!, orphan], pr17Reviews);
    expect(JSON.stringify(t)).toContain('他的追问');
    expect(t.find((x) => x.id === 990)?.orphan).toBe(true);
  });

  it('attention 带正文预览，且按时间倒序', () => {
    const roots = pr17Comments.filter(isRoot);
    const t = buildInlineThreads(roots, pr17Reviews);
    const a = attentionOf(t, classifyConversation(pr18Conv));
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((x) => x.preview.length > 0)).toBe(true);
    expect(a.every((x, i) => i === 0 || a[i - 1]!.createdAt >= x.createdAt)).toBe(true);
  });

  it('preview 压平空白并截断到 80 字', () => {
    expect(preview('  多余   空白\n换行  ')).toBe('多余 空白 换行');
    expect(preview('x'.repeat(200))).toHaveLength(81);
  });
});

describe('第三轮评审：他不走朱批台的两条路（明早最可能踩的）', () => {
  const deskId = () => pr17Reviews.find((r) => /御笔朱批/.test(r.body ?? ''))!.id;
  const emptyId = () => pr17Reviews.find((r) => !r.body)!.id;

  it('zhupi 降级把朱批塞进 review body —— 不能当没看见', () => {
    // zhupi/src/ui.js:551：草稿写于旧版本或行号锚不到时，那些朱批不进 inline，
    // 被塞进 review body。全部降级时 review 里零条 comment，他写的东西只在 body 里。
    const fallback: RawReview = {
      id: 9001,
      body: '以下朱批锚定不到可批注行（或写于旧版本），并入总批：\n\n这段结论我不同意',
      submitted_at: '2026-07-29T10:00:00Z',
    };
    const notes = deskFallbackNotes([fallback, ...pr17Reviews]);
    expect(notes).toHaveLength(1);
    const conv = classifyConversation([], notes);
    expect(conv[0]!.fromDesk).toBe(true);
    expect(conv[0]!.body).toContain('这段结论我不同意');
    // 确定是他发的、没人接话 → 确定要回，不是「判不了」
    expect(countsOf([], conv).needsReply).toBe(1);
    expect(attentionOf([], conv)[0]!.why).toBe('no-reply');
  });

  it('只要有一条降级，整批成功锚上的批注也不能被判成我方', () => {
    // 降级时整个 review body 不再是「御笔朱批 · N 条」，
    // 于是这一批里**成功锚上的**批注会被判成非朱批台 → answered=true → 看不见。
    const mixed: RawReview = { id: 9002, body: '以下朱批锚定不到可批注行（或写于旧版本），并入总批：\n\nA' };
    const anchored: RawInlineComment = { ...pr17Comments[0]!, id: 9100, pull_request_review_id: 9002 };
    delete (anchored as { in_reply_to_id?: unknown }).in_reply_to_id;
    const t = buildInlineThreads([anchored], [mixed]);
    expect(t[0]!.fromDesk).toBe(true);
    expect(t[0]!.answered).toBe(false);
    expect(countsOf(t, []).needsReply).toBe(1);
  });

  it('他从 GitHub 网页在串里回一句 —— 不能让串变得更安静', () => {
    // 最坏的一种错：他一开口，串反而变成已回，工具比他不说话时更安静。
    // 他的网页回话与我方回话完全同形（都是空 body review），所以只能标「判不了」。
    const root = pr17Comments.filter(isRoot)[0]!;
    const hisWebReply: RawInlineComment = {
      ...pr17Comments[2]!, id: 9200, in_reply_to_id: root.id,
      pull_request_review_id: emptyId(), body: '不对，我说的是第二段',
    };
    const t = buildInlineThreads([root, hisWebReply], pr17Reviews);
    const c = countsOf(t, []);
    expect(c.needsReply + c.unclear).toBeGreaterThan(0); // 绝不能两个都是 0
    const a = attentionOf(t, []);
    expect(a).toHaveLength(1);
    expect(a[0]!.why).toBe('reply-author-unclear');
    // 预览取最后一条回话，让人一眼分辨是我方的「已改」还是他的「不对」
    expect(a[0]!.preview).toContain('不对，我说的是第二段');
  });

  it('正常已回的串仍然不进 needsReply（只进 unclear，代价可控）', () => {
    const t = buildInlineThreads(pr17Comments, pr17Reviews);
    const c = countsOf(t, []);
    expect(c.needsReply).toBe(0);
    expect(c.unclear).toBe(2);
  });

  it('降级 review 与普通总批按时间混排', () => {
    const note: RawReview = {
      id: 9003, body: '以下朱批锚定不到可批注行（或写于旧版本），并入总批：\n\n晚说的',
      submitted_at: '2026-07-29T23:00:00Z',
    };
    const conv = classifyConversation(pr18Conv, deskFallbackNotes([note]));
    expect(conv[conv.length - 1]!.body).toContain('晚说的');
    expect(conv[conv.length - 1]!.answered).toBe('pending');
  });
});

describe('总批的 answered 改用本地记录（review#29）', () => {
  const mk = (id: number, body: string, at: string): RawIssueComment => ({ id, body, created_at: at, user: null });
  const three = [
    mk(1, '第一条', '2026-07-29T10:00:00Z'),
    mk(2, '第二条', '2026-07-29T11:00:00Z'),
    mk(3, '第三条', '2026-07-29T12:00:00Z'),
  ];

  it('没记过 → 全部 pending。**他连发三条不会互相清掉**（这是位置推断的漏报洞）', () => {
    const conv = classifyConversation(three);
    expect(conv.map((c) => c.answered)).toEqual(['pending', 'pending', 'pending']);
    expect(countsOf([], conv).needsReply).toBe(3);
  });

  it('位置推断的旧行为已经不存在 —— 非末条不再被判成已答', () => {
    // 旧规则：i < len-1 → inferred（已答）。他连发三条，前两条被静默清掉。
    const conv = classifyConversation(three);
    expect(conv[0]!.answered).not.toBe('handled');
    expect(conv[1]!.answered).not.toBe('handled');
  });

  it('记过的变 handled，且不进 needsReply / attention', () => {
    const conv = classifyConversation(three, [], new Set([1, 2]));
    expect(conv.map((c) => c.answered)).toEqual(['handled', 'handled', 'pending']);
    expect(countsOf([], conv).needsReply).toBe(1);
    expect(attentionOf([], conv).map((a) => a.id)).toEqual([3]);
  });

  it('全记过 → 干净', () => {
    const conv = classifyConversation(three, [], new Set([1, 2, 3]));
    expect(countsOf([], conv).needsReply).toBe(0);
    expect(attentionOf([], conv)).toEqual([]);
  });

  it('answered 只有 handled / pending 两值，不再出现 inferred / unknown', () => {
    for (const h of [new Set<number>(), new Set([2])]) {
      for (const c of classifyConversation(three, [], h)) {
        expect(['handled', 'pending']).toContain(c.answered);
      }
    }
  });

  it('降级并入总批的朱批同样受记录管', () => {
    const note: RawReview = { id: 900, body: '以下朱批锚定不到可批注行（或写于旧版本），并入总批：\n\nA', submitted_at: '2026-07-29T13:00:00Z' };
    const notes = deskFallbackNotes([note]);
    expect(classifyConversation([], notes)[0]!.answered).toBe('pending');
    expect(classifyConversation([], notes, new Set([900]))[0]!.answered).toBe('handled');
  });

  it('counts 里已经没有 hasFollowUp（它数的是坏掉的推断的产物）', () => {
    expect(countsOf([], classifyConversation(three))).not.toHaveProperty('hasFollowUp');
  });
});

describe('`**回话**` 前缀：把「判不了」变成「确定」（第一轮评审）', () => {
  // 我在 skill 里写过「不盖前缀 list_folders 就分不出」——而当时**没有任何代码读它**。
  // 那句因果是编的。这里是它的兑现处。
  const root = (id: number): RawInlineComment => ({
    id, path: 'docs/a.md', body: '这段太绕', created_at: '2026-07-29T10:00:00Z',
    line: 3, diff_hunk: '@@ -1,2 +1,2 @@\n 这段太绕', pull_request_review_id: 900,
  });
  const reply = (id: number, body: string): RawInlineComment => ({
    id, path: 'docs/a.md', body, created_at: '2026-07-29T11:00:00Z',
    in_reply_to_id: 1, diff_hunk: '', pull_request_review_id: 901,
  });
  // 900 是朱批台发的（review body 带 marker）；901 是 /replies 自动建的空 body review——
  // 他从 GitHub 网页在串里回话产生的也是空 body，两者完全同形。
  const reviews: RawReview[] = [
    { id: 900, body: '御笔朱批 · 1 条', submitted_at: '2026-07-29T10:00:00Z' },
    { id: 901, body: '', submitted_at: '2026-07-29T11:00:00Z' },
  ];

  it('isOurReply 只认首行的加粗前缀', () => {
    expect(isOurReply('**回话**\n\n改了')).toBe(true);
    expect(isOurReply('  **回话** 改了')).toBe(true);
    expect(isOurReply('改了。**回话**')).toBe(false);
    expect(isOurReply('回话：改了')).toBe(false);
    expect(isOurReply('')).toBe(false);
  });

  it('盖了前缀 → 这串**确定**已回，不再进 unclear', () => {
    const t = buildInlineThreads([root(1), reply(2, '**回话**\n\n采纳，已改')], reviews);
    expect(t[0]!.replies[0]!.ours).toBe(true);
    expect(t[0]!.answered).toBe(true);
    expect(countsOf(t, [])).toEqual({ needsReply: 0, unclear: 0 });
    expect(attentionOf(t, [])).toEqual([]);
  });

  it('没盖前缀 → 仍然判不了，照旧进 unclear + attention', () => {
    const t = buildInlineThreads([root(1), reply(2, '采纳，已改')], reviews);
    expect(t[0]!.replies[0]!.ours).toBe(false);
    expect(countsOf(t, [])).toEqual({ needsReply: 0, unclear: 1 });
    expect(attentionOf(t, [])[0]!.why).toBe('reply-author-unclear');
  });

  it('**他在我方回话之后又追一句（没前缀）→ 必须回到 unclear**，不能因为前面盖过就当已回', () => {
    const t = buildInlineThreads(
      [root(1), reply(2, '**回话**\n\n采纳，已改'), reply(3, '不对，我说的是第二段')],
      reviews,
    );
    expect(countsOf(t, []).unclear).toBe(1);
    // 预览取最后一条，好让人一眼看出那不是我方的话
    expect(attentionOf(t, [])[0]!.preview).toContain('我说的是第二段');
  });

  it('总批带 updatedAt，供 mark_handled 记水位', () => {
    const c: RawIssueComment = {
      id: 5, body: '看看', created_at: '2026-07-29T10:00:00Z', updated_at: '2026-07-29T18:00:00Z',
    };
    expect(classifyConversation([c])[0]!.updatedAt).toBe('2026-07-29T18:00:00Z');
    // 没有 updated_at 时退回 created_at，不能是 undefined（会让水位比较永远为真）
    expect(classifyConversation([{ ...c, updated_at: undefined }])[0]!.updatedAt).toBe('2026-07-29T10:00:00Z');
  });
});

describe('conversationEntriesOf：水位必须取 updated_at（第二轮评审的接缝）', () => {
  // 这个接缝上一版没有测试：把它改成 created_at 之后 175 条全绿，
  // 而真数据上「他编辑过的总批」立刻被吞回 handled —— 原漏报复现。
  it('有 updated_at 就用它', () => {
    expect(conversationEntriesOf([
      { id: 1, body: 'x', created_at: '2026-07-29T10:00:00Z', updated_at: '2026-07-29T20:00:00Z' },
    ])).toEqual([{ id: 1, updatedAt: '2026-07-29T20:00:00Z' }]);
  });

  it('没有就退回 created_at，不能是 undefined（会让水位比较永远为真）', () => {
    for (const at of [undefined, null]) {
      expect(conversationEntriesOf([
        { id: 1, body: 'x', created_at: '2026-07-29T10:00:00Z', updated_at: at },
      ])).toEqual([{ id: 1, updatedAt: '2026-07-29T10:00:00Z' }]);
    }
  });
});
