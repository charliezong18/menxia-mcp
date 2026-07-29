import { describe, it, expect } from 'vitest';
import { classify, sanitizeParams } from '../src/github.js';
import { messageFor } from '../src/errors.js';

// 第二轮评审的唯一高危：get() 零覆盖。六条关键行为只活在那个函数里，
// 而 folders.test.ts 把它整个 mock 掉。评审用探针在里面现场打穿了两条声称已修的分类。
// 分类逻辑抽成 classify() 之后就能直接测——和 threads.ts 同一个套路：把纯逻辑挤出 IO。

const err = (over: Record<string, unknown>): unknown => Object.assign(new Error(String(over.message ?? 'e')), over);

describe('网络失败（v21 走 undici，措辞和错误形状都变了）', () => {
  it('ENOTFOUND —— 域名解析不了', () => {
    expect(classify(err({ status: 500, message: 'getaddrinfo ENOTFOUND api.github.com' })).kind).toBe('network');
  });

  it('ECONNREFUSED', () => {
    expect(classify(err({ status: 500, message: 'connect ECONNREFUSED 127.0.0.1:443' })).kind).toBe('network');
  });

  it('连接中途被断：message 是 "other side closed"、code 是 undefined —— 评审用真 socket reset 打穿过', () => {
    const e = classify(err({ status: 500, message: 'other side closed', code: undefined }));
    expect(e.kind).toBe('network');
    expect(messageFor(e)).toContain('网络恢复后重试');
    expect(messageFor(e)).not.toContain('没预料到');
  });

  it('真正的 code 藏在 cause 链第二层也要认出来', () => {
    const deep = err({ status: 500, message: 'fetch failed', cause: { message: '', cause: { code: 'UND_ERR_SOCKET' } } });
    expect(classify(deep).kind).toBe('network');
  });
});

describe('限流不能被误报成认证失效', () => {
  it('primary：403 + x-ratelimit-remaining: 0', () => {
    const e = classify(err({ status: 403, response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' } } }));
    expect(e.kind).toBe('rateLimit');
  });

  it('retry-after 头', () => {
    const e = classify(err({ status: 429, response: { headers: { 'retry-after': '60' } } }));
    expect(e).toEqual({ kind: 'rateLimit', retryAfterSec: 60 });
  });

  it('secondary：403、remaining 非 0、唯一信号在 body message —— 评审实证 v2 也漏了这条', () => {
    const e = classify(err({
      status: 403,
      message: 'You have exceeded a secondary rate limit',
      response: { headers: { 'x-ratelimit-remaining': '4321' }, data: { message: 'You have exceeded a secondary rate limit' } },
    }));
    expect(e.kind).toBe('rateLimit');
    expect(messageFor(e)).toContain('限流');
    expect(messageFor(e)).not.toContain('gh auth login'); // 重登对限流毫无帮助
  });
});

describe('其余分类', () => {
  it('404 默认归「仓读不到」，未知上下文时那才是安全默认', () => {
    expect(classify(err({ status: 404 })).kind).toBe('repo');
  });

  it('404 可被调用方指定成「折号不存在」', () => {
    const e = classify(err({ status: 404 }), { notFound: { kind: 'notFound', repo: 'o/r', pr: 9 } });
    expect(messageFor(e)).toContain('#9');
    expect(messageFor(e)).toContain('list_folders');
  });

  it('401 → 认证过期', () => {
    expect(classify(err({ status: 401 }))).toEqual({ kind: 'auth', why: 'expired' });
  });

  it('403 但不是限流 → 认证问题', () => {
    expect(classify(err({ status: 403, response: { headers: {} } })).kind).toBe('auth');
  });

  it('认不出来的落 unknown，且不泄露 token', () => {
    const e = classify(err({ status: 500, message: 'weird Authorization: Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAA' }));
    expect(messageFor(e)).not.toContain('ghp_AAAA');
  });
});

describe('sanitizeParams 与 classify 合起来才是 R7 的防线', () => {
  it('request key 被剔除 —— 它能整个替换掉 Octokit 的 hook 绑定，绕开闸门', () => {
    const evil = { owner: 'o', request: { hook: () => undefined } };
    expect(sanitizeParams(evil)).toEqual({ owner: 'o' });
  });
});
