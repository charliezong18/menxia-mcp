import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder, replyComment, auditFolders } from '../src/submit.js';
import { resetAuthCache } from '../src/github.js';

// **整条写入链的集成测试**：假奏折仓（bare origin + clone）+ 本地 HTTP server 冒充 GitHub。
//
// 为什么必须有这一层：第二轮评审的唯一高危是「get() 零覆盖 —— 六条关键行为只活在
// 那个函数里，而测试把它整个 mock 掉」。写入侧的关键行为（lint 不过就什么都不推、
// 建折失败要说分支已推、已钦此的折拒回话、巡检一个非 GET 都不发）同样只活在编排里，
// 单测各个零件全绿也证明不了它们。
//
// 这里的断言全部落在**真正发生的事**上：origin 上有没有那个分支、server 收到了什么请求。

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

interface Seen { method: string; url: string; body: unknown }
const seen: Seen[] = [];
let server: Server;
let baseUrl = '';
/** 建折时返回什么；设成 'fail' 让 POST /pulls 失败。 */
let prMode: 'ok' | 'fail' = 'ok';
let openList: unknown[] = [];
let prState: { state: string; merged_at: string | null } = { state: 'open', merged_at: null };
let lastCreatedBody = '';

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : null; } catch { return raw; }
};

const ref = { owner: 'o', repo: 'r', slug: 'o/r' };
const scratches: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const url = (req.url ?? '').split('?')[0] ?? '';
      seen.push({ method: req.method ?? '', url, body });
      const send = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && url === '/repos/o/r/pulls') {
        if (prMode === 'fail') return send(422, { message: 'Validation Failed' });
        lastCreatedBody = String((body as { body?: string })?.body ?? '');
        return send(201, { number: 42, html_url: 'https://github.com/o/r/pull/42' });
      }
      if (req.method === 'GET' && url === '/repos/o/r/pulls') return send(200, openList);
      if (req.method === 'GET' && /^\/repos\/o\/r\/pulls\/\d+$/.test(url)) {
        return send(200, { ...prState, body: lastCreatedBody });
      }
      if (req.method === 'POST' && /\/comments\/\d+\/replies$/.test(url)) return send(201, { id: 7 });
      return send(404, { message: 'Not Found' });
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.ZHUPI_GITHUB_BASEURL = baseUrl;
  process.env.GH_TOKEN = 'fake-test-token';
  resetAuthCache();
  execFileSync('npx', ['tsc'], { cwd: join(import.meta.dirname ?? '.', '..'), stdio: 'ignore' });
});

afterAll(() => {
  server?.close();
  delete process.env.ZHUPI_GITHUB_BASEURL;
  delete process.env.GH_TOKEN;
  delete process.env.ZHUPI_REVIEW_PATH;
  delete process.env.ZHUPI_LOCK_PATH;
  resetAuthCache();
  for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  prMode = 'ok';
  prState = { state: 'open', merged_at: null };
});

/** 假奏折仓 + 一对过得了体例的文档。 */
function fixture(slug = 'demo-folder'): { repo: string; origin: string; docs: string[] } {
  const scratch = mkdtempSync(join(tmpdir(), 'zhupi-it-'));
  scratches.push(scratch);
  const origin = join(scratch, 'origin.git');
  const repo = join(scratch, 'review');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, repo]);
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'seed.md'), 'seed\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);

  const src = join(scratch, 'src');
  mkdirSync(src);
  // 互链头逐字照体例（lint.ts:41-42），否则规则 2 会判硬伤
  writeFileSync(join(src, `${slug}.md`), `**English** · [中文](${slug}.zh-CN.md)\n\n# Demo\n\nPlain English body for the language ratio rule.\n`);
  writeFileSync(join(src, `${slug}.zh-CN.md`), `[English](${slug}.md) · **中文**\n\n# 演示\n\n这是中文正文，用来满足语言方向那条规则。\n`);
  process.env.ZHUPI_REVIEW_PATH = repo;
  process.env.ZHUPI_LOCK_PATH = join(scratch, 'review.lock');
  return { repo, origin, docs: [join(src, `${slug}.md`), join(src, `${slug}.zh-CN.md`)] };
}

const goodBody = {
  destination: 'merge 后落 main',
  directLink: '- 渲染版：https://example.invalid/x',
  tldr: '一句话',
  decisions: '1. 行不行',
  howto: '批完说「读批注」',
};

const writes = (): Seen[] => seen.filter((s) => s.method !== 'GET');

describe('open_folder：整条链', () => {
  it('推分支 → 建折 → 回读自核，全程 agent 不碰奏折仓', async () => {
    const { origin, docs } = fixture();
    const out = await openFolder({ title: '读物：demo', body: goodBody, docs }, ref);

    expect(out.pr).toBe(42);
    // 主输出是朱批台深链（2026-07-27：给 GitHub 链接会被读成「让你发朱批你却发了个 PR」）
    expect(out.desk).toBe('https://charliezong18.github.io/zhupi/?pr=42');
    expect(out.warnings).toEqual([]);

    // 分支真在 origin 上
    expect(git(origin, ['rev-parse', '--verify', 'demo-folder'])).toMatch(/^[0-9a-f]{40}$/);

    const created = seen.find((s) => s.method === 'POST' && s.url === '/repos/o/r/pulls')!;
    const payload = created.body as { head: string; base: string; body: string; draft?: unknown };
    expect(payload.head).toBe('demo-folder');
    expect(payload.base).toBe('main');
    // 2026-07-26 起弃用 draft：私有单人仓里 draft 挡不住任何人，却挡住「钦此」的 squash merge
    expect(payload.draft).toBeUndefined();
    expect(payload.body).toContain('## 待你拍板');
    expect(payload.body).toMatch(/<!-- happy-session: .+ -->/);
  }, 60_000);

  // MILESTONES 判据 + SPEC §5.4 的刻意改进：闸门在 push 之前。
  it('体例不合格 —— origin 零变化，且**一个写请求都没发出去**', async () => {
    const { repo, origin, docs } = fixture('bad-folder');
    // 把中文版删掉 → 规则 1 硬伤（缺中文版）
    const only = [docs[0]!];
    const before = git(origin, ['for-each-ref', '--format=%(refname)']);

    await expect(openFolder({ title: '读物：bad', body: goodBody, docs: only }, ref))
      .rejects.toThrow(/体例不合格/);

    expect(git(origin, ['for-each-ref', '--format=%(refname)'])).toBe(before);
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).not.toContain('bad-folder');
    expect(writes()).toEqual([]);
  }, 60_000);

  it('体例报错要**逐条列全**，不砍成一行', async () => {
    const { docs } = fixture('multi-bad');
    const e = await openFolder({ title: 't', body: goodBody, docs: [docs[0]!] }, ref).catch((x: unknown) => x);
    expect(String((e as Error).message)).toContain('远端零变化');
    expect(String((e as Error).message)).toContain('缺中文版');
  }, 60_000);

  // 分支推上去了但建折失败 —— 这是最容易被误读成「什么都没发生」的状态。
  // 不说清楚的话调用方会换个 slug 重来，留下一条孤儿分支。
  it('建折失败 —— 明说分支已经在远端了，别换 slug 重来', async () => {
    const { origin, docs } = fixture('orphan-folder');
    prMode = 'fail';
    const e = await openFolder({ title: 't', body: goodBody, docs }, ref).catch((x: unknown) => x);
    const msg = String((e as Error).message);
    expect(msg).toContain('已经推上去了');
    expect(msg).toContain('别换 slug 重来');
    // 分支确实在远端 —— 提示说的是真的
    expect(git(origin, ['rev-parse', '--verify', 'orphan-folder'])).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it('显式传 sessionId —— 就用它，不去探', async () => {
    const { docs } = fixture('explicit-sid');
    const out = await openFolder({ title: 't', body: goodBody, docs, sessionId: 'sid-explicit' }, ref);
    expect(out.warnings).toEqual([]);
    expect(lastCreatedBody).toContain('<!-- happy-session: sid-explicit -->');
  }, 60_000);
});

describe('reply_comment', () => {
  it('前缀焊上，走的是 replies 路由（不是新开一条批注）', async () => {
    await replyComment({ pr: 12, commentId: 999, body: '采纳，已改。' }, ref);
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.url).toBe('/repos/o/r/pulls/12/comments/999/replies');
    expect((w[0]!.body as { body: string }).body).toBe('**回话** 采纳，已改。');
  });

  // 2026-07-29 #23：他说「批完了」时折已 merged，agent 照常回话，
  // **命令全部成功而结果是零**。guard-closed-folder.sh 拦的是 Bash，MCP 调用从旁边过去。
  it('已钦此的折 —— 拒，且一个写请求都没发', async () => {
    prState = { state: 'closed', merged_at: '2026-07-29T00:00:00Z' };
    await expect(replyComment({ pr: 32, commentId: 1, body: 'x' }, ref)).rejects.toThrow(/钦此/);
    expect(writes()).toEqual([]);
  });

  it('关掉（未 merge）的折 —— 也拒，措辞不一样', async () => {
    prState = { state: 'closed', merged_at: null };
    await expect(replyComment({ pr: 33, commentId: 1, body: 'x' }, ref)).rejects.toThrow(/关掉/);
    expect(writes()).toEqual([]);
  });
});

describe('audit_folders：纯只读', () => {
  it('跑完一个非 GET 请求都没有', async () => {
    // 巡检要对每折的**分支**跑体例检查，所以得真有一条分支。
    // 直接拿 open_folder 造一折 —— 顺带证明巡检读得懂它自己呈出来的东西。
    const { repo, docs } = fixture('audit-fixture');
    await openFolder({ title: 't', body: goodBody, docs, sessionId: 's1' }, ref);
    git(repo, ['fetch', '-q', 'origin']);
    seen.length = 0;

    openList = [
      { number: 1, title: 'a', body: '<!-- happy-session: s1 -->', draft: false, head: { ref: 'audit-fixture' } },
      { number: 2, title: 'b', body: null, draft: true, head: { ref: 'audit-fixture' } },
    ];
    const out = await auditFolders(ref);
    expect(writes()).toEqual([]);
    expect(out.folders).toHaveLength(2);
    expect(out.folders[0]!.problems).toEqual([]);
    // 缺标记要报，但**明说不补** —— 补只能补当前会话的 id，那是编一个（§4.4）
    expect(out.folders[1]!.problems.join()).toContain('不补');
    expect(out.folders[1]!.problems.join()).toContain('gh pr ready 2');
  }, 60_000);
});
