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

  it('我方发的根批注不计入待回（R4 第三条）', () => {
    const ourRoot: RawInlineComment = {
      ...pr17Comments[0]!,
      id: 111,
      pull_request_review_id: pr17Reviews.find((r) => !r.body)!.id,
    };
    delete (ourRoot as { in_reply_to_id?: unknown }).in_reply_to_id;
    const t = buildInlineThreads([...pr17Comments, ourRoot], pr17Reviews);
    expect(t.map((x) => x.id)).not.toContain(111);
    expect(t).toHaveLength(2);
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
    const root = t.find((x) => x.id === pr17Comments[0]!.id)!;
    expect(root.replies.map((r) => r.id)).not.toContain(222);
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

  it('缺 hunk 返回空串而不是崩', () => {
    expect(quoteFromHunk(undefined)).toBe('');
    expect(quoteFromHunk(null)).toBe('');
    expect(quoteFromHunk('')).toBe('');
  });
});
