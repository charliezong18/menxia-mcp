import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Octokit } from '@octokit/rest';
import {
  installWriteGate, installReadOnlyGate, write, resetAuthCache, WRITE_ALLOWED,
} from '../src/github.js';

// Phase 3 第一次往远端写。这一组证明的是「写入口只有三个洞，不是一扇门」。
//
// 手法沿用 readonly-gate.test.ts：起一个本地 server，看**真正发出去的是什么**，
// 而不是看代码里写了什么。第一轮代码评审就是用这个手法证明 v1 的两道闸门都是假的。

const seen: string[] = [];
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end('{"number":99}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => server?.close());

const wgate = () => installWriteGate(new Octokit({ auth: 'fake', baseUrl, request: { retries: 0 } }));
const rgate = () => installReadOnlyGate(new Octokit({ auth: 'fake', baseUrl, request: { retries: 0 } }));

// 写入面被钉死在这里。
//
// 为什么需要这一条：`guard.ts` 的规则③（route 必须以 GET 开头）**没看见** Phase 3
// 往 github.ts 里加了一条写入路 —— 它只匹配字面量 `octokit.request('POST …')`，
// 而本文件真实写法是 `oc.request(route, safe)`，route 是变量。实测加完 write() 之后
// 44 条守卫测试一条没红。守卫自己的注释承认它已降级为辅助 lint，那么「写入面有多大」
// 就必须由这条长度断言来守。加一条路由 = 必须改这里 = 必须被人看见一次。
describe('写入面的大小被钉死', () => {
  // 从三条收到两条：`PATCH /pulls/{n}` 的两个用户实现时都没了 ——
  // 补标记只能补成当前会话的 id（编一个，§4.4 禁止），draft 转正 REST 根本不支持
  // （只能走 GraphQL，而 `POST /graphql` 进白名单等于开放全部 mutation）。
  // 没有用户的路由不留着。
  // 2026-07-31 又从两条到四条：折务追踪（#61）的 label 两路。这条断言的意义
  // 就是「加路由必须被人看见一次」—— 本次被看见于 review #61 的批定。
  it('白名单恰好四条，且就是这四条', () => {
    expect([...WRITE_ALLOWED]).toEqual([
      'POST /repos/{owner}/{repo}/pulls',
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
      'POST /repos/{owner}/{repo}/labels',
      'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
    ]);
  });

  it('没有任何一条能改已存在的折 —— 建折与回话之外，写不了别的', () => {
    expect(WRITE_ALLOWED.filter((r) => /^(PATCH|PUT|DELETE)/.test(r))).toEqual([]);
  });

  it('没有一条是 GET —— 读走 get()', () => {
    expect(WRITE_ALLOWED.filter((r) => r.startsWith('GET '))).toEqual([]);
  });
});

describe('写入白名单：三条路由，逐字匹配', () => {
  it('白名单内的 POST 真的发出去了（证明闸门没把好人一起拦了）', async () => {
    const before = seen.length;
    await wgate().request('POST /repos/{owner}/{repo}/pulls', {
      owner: 'o', repo: 'r', title: 't', head: 'h', base: 'main',
    });
    expect(seen.slice(before)).toEqual(['POST /repos/o/r/pulls']);
  });

  it('白名单外的 DELETE（删仓）—— 被拦，一个字节都没到 server', async () => {
    const before = seen.length;
    await expect(wgate().request('DELETE /repos/{owner}/{repo}', { owner: 'o', repo: 'r' }))
      .rejects.toThrow(/写入白名单/);
    expect(seen.slice(before)).toEqual([]);
  });

  it('白名单外的 PUT（合折）—— 被拦', async () => {
    const before = seen.length;
    await expect(wgate().request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
      owner: 'o', repo: 'r', pull_number: 1,
    })).rejects.toThrow(/写入白名单/);
    expect(seen.slice(before)).toEqual([]);
  });

  // 疤痕：Octokit 的 endpoint merge 是 Object.assign({method,url}, options) ——
  // options.method 覆盖 route 里写的动词。第一轮评审用这一招证明了读侧的
  // 「route 必须以 GET 开头」是假闸门。写侧同一个形状要重验一遍，别以为换了个函数就不成立。
  it('params.method 想把 POST /pulls 换成 DELETE —— 被拦（评审实证过的假闸门形状）', async () => {
    const before = seen.length;
    await expect(wgate().request('POST /repos/{owner}/{repo}/pulls', {
      owner: 'o', repo: 'r', method: 'DELETE',
    })).rejects.toThrow(/写入白名单/);
    expect(seen.slice(before)).toEqual([]);
  });

  // 疤痕：`{+param}` 在 Octokit 里**不做 URL 编码**。实测 `{+repo}` 传
  // `r/pulls/1/merge` 会原样拼进路径（普通 `{repo}` 会编码成 `r%2Fpulls%2F1%2Fmerge`），
  // 也就是从 /pulls 逃到 merge 端点。逐字比对模板挡住它 —— `{+repo}` 与白名单里的
  // `{repo}` 不等。这条测试钉的是「为什么比对模板而不是比对展开后的 URL」。
  it('{+repo} 变体（不转义，能逃出路径）—— 被拦', async () => {
    const before = seen.length;
    await expect(wgate().request('POST /repos/{owner}/{+repo}/pulls', {
      owner: 'o', repo: 'r/pulls/1/merge',
    })).rejects.toThrow(/写入白名单/);
    expect(seen.slice(before)).toEqual([]);
  });

  it('写实例上的 GET 也拒 —— 读走 get()，不开第二条没护栏的读路径', async () => {
    const before = seen.length;
    await expect(wgate().request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' }))
      .rejects.toThrow(/写入白名单/);
    expect(seen.slice(before)).toEqual([]);
  });

  it('裸 Octokit 确实发得出去 —— 证明这组测试本身有效，不是恒绿', async () => {
    const before = seen.length;
    await new Octokit({ auth: 'fake', baseUrl, request: { retries: 0 } })
      .request('DELETE /repos/{owner}/{repo}', { owner: 'o', repo: 'r' });
    expect(seen.slice(before)).toEqual(['DELETE /repos/o/r']);
  });
});

describe('读实例没有被写入侧的改动放松', () => {
  it('读实例仍然一个非 GET 都发不出去', async () => {
    const before = seen.length;
    await expect(rgate().request('POST /repos/{owner}/{repo}/pulls', { owner: 'o', repo: 'r' }))
      .rejects.toThrow(/只读/);
    // 连白名单里的那三条也不行 —— 白名单是写实例的，不是全局的。
    for (const route of WRITE_ALLOWED) {
      await expect(rgate().request(route, { owner: 'o', repo: 'r', pull_number: 1, comment_id: 2 }))
        .rejects.toThrow(/只读/);
    }
    expect(seen.slice(before)).toEqual([]);
  });
});

describe('write()：函数级的字面量检查', () => {
  it('不在白名单里的 route 直接报一句能照着修的话，不建实例不打网络', async () => {
    await expect(write('DELETE /repos/{owner}/{repo}', { owner: 'o', repo: 'r' }))
      .rejects.toThrow(/写入白名单/);
  });

  // 第二轮评审的唯一高危是「get() 零覆盖」—— 关键行为只活在函数里而测试把它 mock 掉了。
  // 写入侧不重复那个错误：走 ZHUPI_GITHUB_BASEURL 接缝，真跑一遍 write()。
  it('走真实的 write() 路径打到本地 server（不是 mock）', async () => {
    const prev = process.env.ZHUPI_GITHUB_BASEURL;
    const prevToken = process.env.GH_TOKEN;
    process.env.ZHUPI_GITHUB_BASEURL = baseUrl;
    // `gh auth token` 认 GH_TOKEN（实测直接回显）。给个假的，这条测试就不依赖
    // 本机登没登录 —— 否则它在 CI 或新装机上会红，而红的原因与被测行为无关。
    process.env.GH_TOKEN = 'fake-test-token';
    resetAuthCache();
    try {
      const before = seen.length;
      const out = await write<{ number: number }>('POST /repos/{owner}/{repo}/pulls', {
        owner: 'o', repo: 'r', title: 't', head: 'h', base: 'main',
        // 这三个 key 会覆盖动词与地址，sanitizeParams 必须剔掉它们
        method: 'DELETE', url: '/evil', headers: { 'X-HTTP-Method-Override': 'DELETE' },
      });
      expect(seen.slice(before)).toEqual(['POST /repos/o/r/pulls']);
      expect(out.number).toBe(99);
    } finally {
      if (prev === undefined) delete process.env.ZHUPI_GITHUB_BASEURL;
      else process.env.ZHUPI_GITHUB_BASEURL = prev;
      if (prevToken === undefined) delete process.env.GH_TOKEN;
      resetAuthCache();
    }
  });
});
