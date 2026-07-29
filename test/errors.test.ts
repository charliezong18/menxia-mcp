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
    [{ kind: 'tooManyComments', repo: 'o/r', pr: 7 }, '超过一页'],
    [{ kind: 'tooManyFolders', repo: 'o/r' }, '超过一页'],
    [{ kind: 'rateLimit', retryAfterSec: 30 }, '重新登录没用'],
    [{ kind: 'auth', why: 'noGh' }, '装 GitHub CLI'],
    [{ kind: 'auth', why: 'ghTimeout' }, '十秒没响应'],
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

describe('新增的错误分类（第一轮代码评审的产物）', () => {
  it('限流不再被误报成认证失效——重新登录对限流毫无帮助', () => {
    const m = messageFor({ kind: 'rateLimit', retryAfterSec: 42 });
    expect(m).toContain('限流');
    expect(m).toContain('42');
    expect(m).not.toContain('gh auth login');
  });

  it('gh 没装 → 叫人先装，不是叫人去登录', () => {
    expect(messageFor({ kind: 'auth', why: 'noGh' })).toContain('brew install gh');
  });

  it('折列表超页的话术里不出现「#0」这种不存在的折号', () => {
    expect(messageFor({ kind: 'tooManyFolders', repo: 'o/r' })).not.toContain('#0');
  });

  it('未知 kind 不会让 messageFor 崩（防新增分支时漏 case）', () => {
    const weird = { kind: 'nope' } as unknown as ZhupiError;
    expect(() => messageFor(weird)).not.toThrow();
    expect(messageFor(weird)).toContain('未知错误类型');
  });

  it('脱敏大小写不敏感，且能吃掉 scheme 后面的秘密', () => {
    expect(redact('GHP_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).not.toContain('GHP_ABCDEF');
    expect(redact('Authorization: Basic Z2hwX0FCQ0RFRkdISUpLTE1OT1A=')).not.toContain('Z2hwX0FCQ0RF');
    expect(redact('Authorization: token s3cr3t-xyz')).not.toContain('s3cr3t-xyz');
  });

  it('脱敏发生在唯一出口——裸插值的模板也过了一遍', () => {
    const m = messageFor({ kind: 'repo', repo: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
    expect(m).not.toContain('ghp_ABCDEF');
  });
});

describe('ZhupiFailure', () => {
  it('message 就是给人看的那句话，info 保留分类', () => {
    const f = new ZhupiFailure({ kind: 'notFound', repo: 'o/r', pr: 3 });
    expect(f.message).toContain('#3');
    expect(f.info.kind).toBe('notFound');
  });
});
