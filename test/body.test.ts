import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { buildBody, verifyMarker, MARKER_RE } from '../src/body.js';
import { resetAuthCache } from '../src/github.js';

const full = {
  destination: 'merge 后落 main',
  directLink: '- 渲染版：https://example.invalid/x',
  tldr: '一句话',
  decisions: '1. 这个行不行',
  howto: '批完说「读批注」',
};

describe('五段拼装', () => {
  it('段名与顺序跟现有折逐字一致（对着 #34 #35 的真 body 核过）', () => {
    const { text, missing, warnings } = buildBody(full, 'sid123');
    expect(missing).toEqual([]);
    expect(warnings).toEqual([]);
    expect(text.match(/^## .+$/gm)).toEqual(['## 目的地', '## 直达链', '## TLDR', '## 待你拍板', '## 怎么用']);
    expect(text.endsWith('<!-- happy-session: sid123 -->\n')).toBe(true);
  });

  // SPEC §5.3 #6：SKILL.md 体例表第 5 行与老脚本注释都写「缺项也拦」，那是假的。
  // 照代码来 —— 只警告。
  it('缺段只警告不拦，且报得出缺的是哪一段', () => {
    const { text, missing, warnings } = buildBody({ ...full, decisions: '   ' }, 'sid');
    // 缺段进 missing，**不进 warnings** —— lint 规则 8 已经在查同一件事，
    // 两边都塞一句的话同一个问题在输出里出现两次。
    expect(missing).toEqual(['待你拍板']);
    expect(warnings).toEqual([]);
    expect(text).not.toContain('## 待你拍板');
    expect(text).toContain('## TLDR'); // 其余照出
  });

  it('directLink 省了 —— 出警告，不出空段', () => {
    const { text, missing } = buildBody({ ...full, directLink: undefined }, 'sid');
    expect(missing).toEqual(['直达链']);
    expect(text).not.toContain('## 直达链');
    expect(text).not.toMatch(/\n\n\n/); // 别留下空洞
  });

  it('会话 id 探不到 —— body 里一行都不多，且明说按钮不会出现', () => {
    const { text, warnings } = buildBody(full, null);
    expect(text).not.toContain('happy-session');
    expect(MARKER_RE.test(text)).toBe(false);
    expect(warnings.join()).toContain('不埋');
  });

  it('正文里有全角括号、反引号、代码块也不破坏结构', () => {
    const { text } = buildBody({ ...full, tldr: '看 `folder-lint.sh:58` 的 `${ZH}（`\n\n```sh\necho 1\n```' }, 'sid');
    expect(text.match(/^## .+$/gm)?.length).toBe(5);
  });
});

// —— 回读自核 ——
//
// 老脚本 open-folder.sh:141 就在做这件事，理由是「gh 有过静默吞 body 的先例」。
// 换成 Octokit 不代表这条失效：吞不吞是服务端的事。
let server: Server;
let baseUrl = '';
let bodyToServe = '';
let failNext = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (failNext) {
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ body: bodyToServe }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.ZHUPI_GITHUB_BASEURL = baseUrl;
  process.env.GH_TOKEN = 'fake-test-token';
  resetAuthCache();
});

afterAll(() => {
  server?.close();
  delete process.env.ZHUPI_GITHUB_BASEURL;
  delete process.env.GH_TOKEN;
  resetAuthCache();
});

const repo = { owner: 'o', repo: 'r', slug: 'o/r' };

describe('回读自核', () => {
  it('标记真在线上 —— ok', async () => {
    bodyToServe = '## TLDR\n\nx\n\n<!-- happy-session: sid123 -->\n';
    expect(await verifyMarker(repo, 7, 'sid123')).toEqual({ ok: true, unverified: false });
  });

  it('标记没落上 —— 报出来，且给一句能照着补的命令', async () => {
    bodyToServe = '## TLDR\n\nx\n';
    const r = await verifyMarker(repo, 7, 'sid123');
    expect(r.ok).toBe(false);
    expect(r.unverified).toBe(false);
    expect(r.message).toContain('gh pr edit 7 -R o/r');
  });

  // 这一条防的是「以为核过了其实核的是别人的 id」。
  // 陈旧 hostPid 指错会话正是 session.ts 那条判活要防的事故，这里是它的下游。
  it('body 里是**别人的**会话 id —— 报错，不当成 ok', async () => {
    bodyToServe = '<!-- happy-session: someone-else -->';
    const r = await verifyMarker(repo, 7, 'sid123');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('someone-else');
  });

  // SPEC §3.1 图里的橙色分支：折已经建了，瞒着更糟；但也不能因为核不了就判整个调用失败
  // —— 那会让调用方以为折没建成而重开一折。
  it('回读本身失败 —— 不抛，且把「核不了」与「没落上」分开报', async () => {
    bodyToServe = '';
    failNext = true;
    try {
      const r = await verifyMarker(repo, 7, 'sid123');
      expect(r.ok).toBe(false);
      expect(r.unverified).toBe(true);
      expect(r.message).toContain('折是好的');
    } finally {
      failNext = false;
    }
  });

  it('本来就没有会话 id —— 没什么可核的，不算失败', async () => {
    expect(await verifyMarker(repo, 7, null)).toEqual({ ok: true, unverified: false });
  });
});
