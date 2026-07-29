import { describe, it, expect } from 'vitest';
import { messageFor, redact, ZhupiFailure, type ZhupiError } from '../src/errors.js';

const FAKE_TOKENS = [
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'github_pat_11ABCDEFG0abcdefghijKL_mnopqrstuvwxyz0123456789',
  'gho_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  'a'.repeat(40),
];

describe('五种失败各有一句能照着修的话', () => {
  const cases: Array<[ZhupiError, string]> = [
    [{ kind: 'auth' }, 'gh auth login'],
    [{ kind: 'repo', repo: 'o/r' }, 'o/r'],
    [{ kind: 'notFound', repo: 'o/r', pr: 42 }, '#42'],
    [{ kind: 'network', reason: 'getaddrinfo ENOTFOUND' }, '网络恢复后重试'],
    [{ kind: 'badInput', what: 'state 只能是 open' }, '入参不对'],
    [{ kind: 'tooMany', repo: 'o/r', pr: 7 }, '超过一页'],
    [{ kind: 'unknown', detail: 'boom' }, '没预料到'],
  ];
  for (const [err, needle] of cases) {
    it(`${err.kind} → 含「${needle}」`, () => {
      expect(messageFor(err)).toContain(needle);
    });
  }

  it('折号不存在的话术指向 list_folders，不是叫人去查权限', () => {
    // 双 review 指出：GitHub 对「仓不存在/无权限/折号不存在」都返回 404，
    // 混为一谈会把折号敲错的人指去查权限，正好反向。
    expect(messageFor({ kind: 'notFound', repo: 'o/r', pr: 9 })).toContain('list_folders');
    expect(messageFor({ kind: 'notFound', repo: 'o/r', pr: 9 })).not.toContain('权限');
    expect(messageFor({ kind: 'repo', repo: 'o/r' })).toContain('权限');
  });
});

describe('token 绝不进错误文本', () => {
  for (const tok of FAKE_TOKENS) {
    it(`脱敏 ${tok.slice(0, 12)}…`, () => {
      expect(redact(`failed with ${tok} in header`)).not.toContain(tok);
    });
  }

  it('把假 token 塞进每一种带 detail 的错误，输出里都搜不到', () => {
    const tok = FAKE_TOKENS[0]!;
    const errs: ZhupiError[] = [
      { kind: 'network', reason: `connect failed Authorization: Bearer ${tok}` },
      { kind: 'unknown', detail: `HttpError token=${tok}` },
      { kind: 'badInput', what: `bad ${tok}` },
    ];
    for (const e of errs) {
      const msg = messageFor(e);
      expect(msg).not.toContain(tok);
      expect(msg).toContain('[已脱敏]');
    }
  });

  it('不吐 stack trace：多行 detail 只留第一行', () => {
    const msg = messageFor({ kind: 'unknown', detail: 'boom\n    at foo (/x/y.ts:1:1)\n    at bar' });
    expect(msg).not.toContain('at foo');
    expect(msg.split('\n')).toHaveLength(1);
  });

  it('超长 detail 被截断', () => {
    const msg = messageFor({ kind: 'unknown', detail: 'x'.repeat(500) });
    expect(msg.length).toBeLessThan(220);
  });
});

describe('ZhupiFailure', () => {
  it('message 就是给人看的那句话，info 保留分类', () => {
    const f = new ZhupiFailure({ kind: 'notFound', repo: 'o/r', pr: 3 });
    expect(f.message).toContain('#3');
    expect(f.info.kind).toBe('notFound');
  });
});
