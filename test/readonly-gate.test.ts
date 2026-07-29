import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Octokit } from '@octokit/rest';
import { installReadOnlyGate, sanitizeParams } from '../src/github.js';

// R7 的执行机制在这里被证明，不在文本扫描里。
//
// 第一轮代码评审用本地 server 实证了 v1 的两道「闸门」都是假的：
//   ① octokit.request('GET /x', { method: 'POST' }) 真的会发 POST ——
//      Octokit 的 endpoint merge 是 Object.assign({method,url}, options)，options 覆盖 method。
//   ② 文本守卫扫字面量 `octokit.`，而真实代码写的是 `oc.request(...)`，从没生效过。
// 下面用同一套手法证明修好了：起一个本地 server，看真正发出去的是什么。

const seen: string[] = [];
let server: Server;
let baseUrl = '';

const start = async (): Promise<void> => {
  if (server) return;
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
};

afterAll(() => server?.close());

const gated = () => installReadOnlyGate(new Octokit({ auth: 'fake', baseUrl, request: { retries: 0 } }));

describe('sanitizeParams：剔除能覆盖动词与地址的 key', () => {
  it('method / url / baseUrl / request 全被剔除', () => {
    const out = sanitizeParams({
      owner: 'o', repo: 'r', method: 'POST', url: '/evil', baseUrl: 'http://evil', request: { x: 1 },
    });
    expect(out).toEqual({ owner: 'o', repo: 'r' });
  });

  it('正常参数一个不少', () => {
    expect(sanitizeParams({ owner: 'o', repo: 'r', per_page: 100, state: 'open' }))
      .toEqual({ owner: 'o', repo: 'r', per_page: 100, state: 'open' });
  });
});

describe('运行时闸门：非 GET 发不出去', () => {
  it('params.method 想把 GET 改成 POST —— 被拦，且一个字节都没到 server', async () => {
    await start();
    const before = seen.length;
    const oc = gated();
    await expect(
      oc.request('GET /repos/{owner}/{repo}/issues/{n}/comments', {
        owner: 'o', repo: 'r', n: 1, method: 'POST', body: '写进去了',
      }),
    ).rejects.toThrow(/只读/);
    expect(seen.slice(before)).toEqual([]);
  });

  it('params.method 想发 PUT（合 PR）—— 被拦', async () => {
    await start();
    const before = seen.length;
    await expect(
      gated().request('GET /repos/{owner}/{repo}/pulls/{n}/merge', { owner: 'o', repo: 'r', n: 1, method: 'PUT' }),
    ).rejects.toThrow(/只读/);
    expect(seen.slice(before)).toEqual([]);
  });

  it('直接写 POST route —— 被拦', async () => {
    await start();
    const before = seen.length;
    await expect(gated().request('POST /repos/{owner}/{repo}/issues', { owner: 'o', repo: 'r' }))
      .rejects.toThrow(/只读/);
    expect(seen.slice(before)).toEqual([]);
  });

  it('DELETE —— 被拦', async () => {
    await start();
    const before = seen.length;
    await expect(gated().request('DELETE /repos/{owner}/{repo}/x', { owner: 'o', repo: 'r' }))
      .rejects.toThrow(/只读/);
    expect(seen.slice(before)).toEqual([]);
  });

  it('正常 GET 照常放行（证明闸门没把好人一起拦了）', async () => {
    await start();
    const before = seen.length;
    await gated().request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' });
    expect(seen.slice(before)).toEqual(['GET /repos/o/r']);
  });

  it('没装闸门的裸 Octokit 确实会发 POST —— 证明这个测试本身有效', async () => {
    await start();
    const before = seen.length;
    const naked = new Octokit({ auth: 'fake', baseUrl, request: { retries: 0 } });
    await naked.request('GET /repos/{owner}/{repo}/issues/{n}/comments', {
      owner: 'o', repo: 'r', n: 1, method: 'POST', body: 'x',
    });
    // 这一条就是评审报的那个洞：GET 的 route 真发出了 POST。
    expect(seen.slice(before)).toEqual(['POST /repos/o/r/issues/1/comments']);
  });
});
