import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { classify, get, write, resetAuthCache, setFetchForTests } from '../src/github.js';
import { messageFor, isFailure } from '../src/errors.js';

// HARDENING-2026-11 · 网络层（F1 / F2 / F3 / F11）。
//
// **零真网络**：底层 fetch 换成进程内的假实现（setFetchForTests）。baseUrl 指向回环的 9 号口
// （discard）当第二道保险 —— 就算接缝失效，请求也出不了本机。

const ref = { owner: 'o', repo: 'r' };
let calls: Array<{ method: string; url: string }> = [];

/** 照 undici 的真实形态造一个连接层错误：TypeError('fetch failed') + cause 带 code。 */
const undiciError = (code: string, message: string): TypeError => {
  const cause = Object.assign(new Error(message), { code, errno: -99, syscall: 'connect' });
  return Object.assign(new TypeError('fetch failed'), { cause });
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(() => {
  process.env.ZHUPI_GITHUB_BASEURL = 'http://127.0.0.1:9';
  process.env.GH_TOKEN = 'fake-test-token';
  process.env.ZHUPI_HTTP_RETRY_DELAY_MS = '0';
  resetAuthCache();
});

afterAll(() => {
  setFetchForTests(null);
  delete process.env.ZHUPI_GITHUB_BASEURL;
  delete process.env.GH_TOKEN;
  delete process.env.ZHUPI_HTTP_RETRY_DELAY_MS;
  delete process.env.ZHUPI_HTTP_TIMEOUT_MS;
  resetAuthCache();
});

beforeEach(() => {
  calls = [];
  delete process.env.ZHUPI_HTTP_TIMEOUT_MS;
});

/** 装一个按调用次序出牌的假 fetch。 */
function script(...steps: Array<() => Response | Promise<Response>>): void {
  let i = 0;
  setFetchForTests(async (url, init) => {
    calls.push({ method: String(init?.method ?? 'GET'), url: String(url) });
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return step();
  });
}

describe('F1 · EADDRNOTAVAIL 等「本机没路由」的错误归为网络，不是「没预料到的问题」', () => {
  // Octokit 9 的 fetch-wrapper 把 TypeError 的 cause.message 提上来当 message，status 500。
  const octokitWrapped = (code: string, msg: string): Error => {
    const inner = undiciError(code, msg);
    return Object.assign(new Error(msg), { name: 'HttpError', status: 500, cause: inner });
  };

  for (const [code, msg] of [
    ['EADDRNOTAVAIL', 'connect EADDRNOTAVAIL 140.82.112.6:443 - Local (0.0.0.0:0)'],
    ['ENETUNREACH', 'connect ENETUNREACH 140.82.112.6:443'],
    ['EHOSTUNREACH', 'connect EHOSTUNREACH 140.82.112.6:443'],
    ['ECONNABORTED', 'read ECONNABORTED'],
    ['UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'],
  ] as const) {
    it(`classify: ${code}（Octokit 包过一层）→ network`, () => {
      expect(classify(octokitWrapped(code, msg)).kind).toBe('network');
    });
    it(`classify: ${code}（只有 code、message 不含任何关键词）→ network`, () => {
      expect(classify(Object.assign(new Error('boom'), { code })).kind).toBe('network');
    });
  }

  it('get()：EADDRNOTAVAIL 一直不好 → 报「连不上 github.com」，不是「没预料到」', async () => {
    script(() => { throw undiciError('EADDRNOTAVAIL', 'connect EADDRNOTAVAIL 140.82.112.6:443 - Local (0.0.0.0:0)'); });
    const e = await get('GET /repos/{owner}/{repo}/pulls', ref, { pageGuard: { kind: 'unknown', detail: 'x' } }).catch((x: unknown) => x);
    expect(isFailure(e)).toBe(true);
    expect((e as { info: { kind: string } }).info.kind).toBe('network');
    expect(String((e as Error).message)).toContain('连不上 github.com');
    expect(String((e as Error).message)).not.toContain('没预料到');
  });
});

describe('F2 · 请求超时：不再永远挂着', () => {
  it('classify: TimeoutError / AbortError（DOMException 形态）→ network', () => {
    const t = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const a = Object.assign(new Error('This operation was aborted'), { name: 'AbortError', status: 500 });
    expect(classify(t).kind).toBe('network');
    expect(classify(a).kind).toBe('network');
    // Octokit 把 TimeoutError 包成 500 的 RequestError，cause 链里才有名字
    expect(classify(Object.assign(new Error('x'), { status: 500, cause: t })).kind).toBe('network');
  });

  it('get()：对端只握手不回包 → 在超时预算内失败，归为 network', async () => {
    process.env.ZHUPI_HTTP_TIMEOUT_MS = '60';
    resetAuthCache();
    // 假 fetch 永不自己返回，只认 signal —— 与半开连接同一个形态。
    setFetchForTests((_url, init) => new Promise<Response>((_, reject) => {
      calls.push({ method: 'GET', url: String(_url) });
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const t0 = Date.now();
    const e = await get('GET /repos/{owner}/{repo}', ref, { pageGuard: { kind: 'unknown', detail: 'x' } }).catch((x: unknown) => x);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((e as { info: { kind: string } }).info.kind).toBe('network');
    // 超时一次、重试一次（F3）
    expect(calls).toHaveLength(2);
  });
});

describe('F3 · GET 的瞬时网络错误重试一次（无副作用，安全）', () => {
  it('第一次 ECONNRESET、第二次好了 → 返回数据', async () => {
    script(
      () => { throw undiciError('ECONNRESET', 'read ECONNRESET'); },
      () => json(200, [{ number: 1 }]),
    );
    const out = await get<Array<{ number: number }>>('GET /repos/{owner}/{repo}/pulls', ref, { pageGuard: { kind: 'unknown', detail: 'x' } });
    expect(out).toEqual([{ number: 1 }]);
    expect(calls).toHaveLength(2);
  });

  it('只重试一次：连坏两次就报出来，不无限转', async () => {
    script(() => { throw undiciError('ECONNRESET', 'read ECONNRESET'); });
    await expect(get('GET /repos/{owner}/{repo}', ref, { pageGuard: { kind: 'unknown', detail: 'x' } })).rejects.toThrow(/连不上/);
    expect(calls).toHaveLength(2);
  });

  it('**404 不重试**（那不是瞬时问题）', async () => {
    script(() => json(404, { message: 'Not Found' }));
    await expect(get('GET /repos/{owner}/{repo}', ref, { pageGuard: { kind: 'unknown', detail: 'x' } })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('F3′ · 写请求**绝不**自动重试网络错误（重试 POST /pulls 就是开第二折）', () => {
  it('POST 遇到 EADDRNOTAVAIL → 只发一次，报 network', async () => {
    script(() => { throw undiciError('EADDRNOTAVAIL', 'connect EADDRNOTAVAIL'); });
    const e = await write('POST /repos/{owner}/{repo}/pulls', { ...ref, title: 't', head: 'b', base: 'main', body: 'x' }).catch((x: unknown) => x);
    expect((e as { info: { kind: string } }).info.kind).toBe('network');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('F11 · 网关 5xx 归为网络（不是认证、不是入参）', () => {
  for (const st of [502, 503, 504]) {
    it(`HTTP ${st} → network，话术不叫人去登录`, () => {
      const c = classify(Object.assign(new Error('Bad Gateway'), { status: st }));
      expect(c.kind).toBe('network');
      expect(messageFor(c)).not.toContain('gh auth login');
    });
  }
  it('500 仍归 unknown（GitHub 自己的 bug，不假装是网络）', () => {
    expect(classify(Object.assign(new Error('Internal'), { status: 500 })).kind).toBe('unknown');
  });
});

describe('network 错误的 hint 不被截断（写侧要靠它说「重试安不安全」）', () => {
  it('reason 再长，hint 也原样在', () => {
    const msg = messageFor({ kind: 'network', reason: 'x'.repeat(500), hint: '原样重试是安全的' });
    expect(msg).toContain('原样重试是安全的');
  });
});
