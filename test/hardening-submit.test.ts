import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder, replyComment, branchProblem, type OpenFolderResult } from '../src/submit.js';
import { resetAuthCache, setFetchForTests } from '../src/github.js';
import { handleTool } from '../src/tools.js';

// HARDENING-2026-11 · 写入侧的失败模式（F4–F10）。
//
// 真 git（bare origin + clone，全在 tmpdir）+ **进程内的假 GitHub**（setFetchForTests）。
// 没有 HTTP server、没有真网络：baseUrl 指回环 9 号口当保险。
//
// 断言一律落在「真正发生的事」上：假 GitHub 里有几折、几条回话；origin 上的分支 sha 变没变。

const ref = { owner: 'o', repo: 'r', slug: 'o/r' };
const SID = 'cmszzzzzzzzzzzzzzzzzzzzzz';
const deps = { detectSessionId: () => SID };

interface Pr { number: number; html_url: string; head: { ref: string }; state: string; merged_at: null; body: string; title: string; labels: string[] }
interface Reply { id: number; in_reply_to_id: number; body: string; pull: number }

/** 假 GitHub 的状态。每条测试前清空。 */
const gh = {
  prs: [] as Pr[],
  replies: [] as Reply[],
  labels: [] as string[],
  log: [] as Array<{ method: string; path: string }>,
  /** 按「METHOD path 前缀」注入故障：返回 'drop' = 服务端照做了、回包丢了；'fail' = 没做、连接层报错；数字 = 回这个状态码。 */
  faults: new Map<string, Array<'drop' | 'fail' | number>>(),
  comment: { in_reply_to_id: null as number | null, pull_request_url: 'https://api.github.com/repos/o/r/pulls/12' },
};

const net = (): TypeError => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect EADDRNOTAVAIL 140.82.112.6:443 - Local (0.0.0.0:0)'), { code: 'EADDRNOTAVAIL' }),
});
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function takeFault(key: string): 'drop' | 'fail' | number | undefined {
  for (const [k, q] of gh.faults) if (key.startsWith(k) && q.length > 0) return q.shift();
  return undefined;
}

async function fakeGitHub(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(String(url));
  const method = String(init?.method ?? 'GET').toUpperCase();
  const path = u.pathname;
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  gh.log.push({ method, path });
  const fault = takeFault(`${method} ${path}`);
  if (fault === 'fail') throw net();
  if (typeof fault === 'number') return json(fault, { message: `injected ${fault}` });

  let res: Response;
  if (method === 'POST' && path === '/repos/o/r/pulls') {
    if (gh.prs.some((p) => p.head.ref === body.head && p.state === 'open')) {
      res = json(422, { message: 'Validation Failed', errors: [{ message: `A pull request already exists for o:${String(body.head)}.` }] });
    } else {
      const n = 40 + gh.prs.length + 1;
      const pr: Pr = { number: n, html_url: `https://github.com/o/r/pull/${n}`, head: { ref: String(body.head) }, state: 'open', merged_at: null, body: String(body.body), title: String(body.title), labels: [] };
      gh.prs.push(pr);
      res = json(201, pr);
    }
  } else if (method === 'GET' && path === '/repos/o/r/pulls') {
    const head = u.searchParams.get('head')?.split(':')[1];
    res = json(200, gh.prs.filter((p) => p.state === (u.searchParams.get('state') ?? 'open') && (!head || p.head.ref === head)));
  } else if (method === 'GET' && /^\/repos\/o\/r\/pulls\/\d+$/.test(path)) {
    const pr = gh.prs.find((p) => p.number === Number(path.split('/').pop()));
    res = pr ? json(200, pr) : json(200, { state: 'open', merged_at: null, body: '' });
  } else if (method === 'GET' && /^\/repos\/o\/r\/pulls\/comments\/\d+$/.test(path)) {
    res = json(200, gh.comment);
  } else if (method === 'GET' && /^\/repos\/o\/r\/pulls\/\d+\/comments$/.test(path)) {
    const n = Number(path.split('/')[5]);
    res = json(200, gh.replies.filter((r) => r.pull === n));
  } else if (method === 'POST' && /^\/repos\/o\/r\/pulls\/\d+\/comments\/\d+\/replies$/.test(path)) {
    const parts = path.split('/');
    const r: Reply = { id: 7000 + gh.replies.length, pull: Number(parts[5]), in_reply_to_id: Number(parts[7]), body: String(body.body) };
    gh.replies.push(r);
    res = json(201, r);
  } else if (method === 'GET' && path === '/repos/o/r/labels') {
    res = json(200, gh.labels.map((name) => ({ name })));
  } else if (method === 'POST' && path === '/repos/o/r/labels') {
    gh.labels.push(String(body.name));
    res = json(201, { name: body.name });
  } else if (method === 'POST' && /^\/repos\/o\/r\/issues\/\d+\/labels$/.test(path)) {
    const pr = gh.prs.find((p) => p.number === Number(path.split('/')[5]))!;
    for (const l of body.labels as string[]) if (!pr.labels.includes(l)) pr.labels.push(l);
    res = json(200, pr.labels.map((name) => ({ name })));
  } else {
    res = json(404, { message: 'Not Found' });
  }
  if (fault === 'drop') throw net(); // 服务端已经照做，回包丢在路上
  return res;
}

const posts = (p: RegExp): number => gh.log.filter((l) => l.method === 'POST' && p.test(l.path)).length;

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

const scratches: string[] = [];
function fixture(slug: string): { repo: string; origin: string; src: string; docs: string[] } {
  const scratch = mkdtempSync(join(tmpdir(), 'zhupi-hard-'));
  scratches.push(scratch);
  const origin = join(scratch, 'origin.git');
  const repo = join(scratch, 'review');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'seed.md'), 'seed\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['config', 'user.email', 't@t']);
  const src = join(scratch, 'src');
  mkdirSync(src);
  writeFileSync(join(src, `${slug}.md`), `**English** · [中文](${slug}.zh-CN.md)\n\n# Demo\n\nPlain English body for the language ratio rule.\n`);
  writeFileSync(join(src, `${slug}.zh-CN.md`), `[English](${slug}.md) · **中文**\n\n# 演示\n\n这是中文正文，用来满足语言方向那条规则。\n`);
  process.env.ZHUPI_REVIEW_PATH = repo;
  process.env.ZHUPI_LOCK_PATH = join(scratch, 'review.lock');
  return { repo, origin, src, docs: [join(src, `${slug}.md`), join(src, `${slug}.zh-CN.md`)] };
}

const body = { destination: 'merge 后落 main', directLink: '- 渲染版：https://example.invalid/x', tldr: '一句话', decisions: '1. 行不行', howto: '批完说「读批注」' };
const track = { proj: ['menxia'], kind: '设计' as const, wait: '你读' as const, qian: [], needs: [], supersedes: [] };

beforeAll(() => {
  process.env.ZHUPI_GITHUB_BASEURL = 'http://127.0.0.1:9';
  process.env.GH_TOKEN = 'fake-test-token';
  process.env.ZHUPI_HTTP_RETRY_DELAY_MS = '0';
  resetAuthCache();
  setFetchForTests(fakeGitHub);
});

afterAll(() => {
  setFetchForTests(null);
  for (const k of ['ZHUPI_GITHUB_BASEURL', 'GH_TOKEN', 'ZHUPI_HTTP_RETRY_DELAY_MS', 'ZHUPI_REVIEW_PATH', 'ZHUPI_LOCK_PATH']) delete process.env[k];
  resetAuthCache();
  for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  gh.prs = [];
  gh.replies = [];
  gh.labels = [];
  gh.log = [];
  gh.faults = new Map();
  gh.comment = { in_reply_to_id: null, pull_request_url: 'https://api.github.com/repos/o/r/pulls/12' };
});

describe('F4 · 推上去了、建折断网 → 原样重试能续上，不重推、不换 slug、不开第二折', () => {
  it('第一次报「原样重试」；第二次 outcome=resumed，origin 分支 sha 不变，全程只有一折', async () => {
    const { origin, docs } = fixture('f4-resume');
    gh.faults.set('POST /repos/o/r/pulls', ['fail']);
    const e = await openFolder({ title: 't', body, docs }, ref, deps).catch((x: unknown) => x);
    const msg = String((e as Error).message);
    expect(msg).toContain('已经推上去了');
    expect(msg).toContain('原样重试 open_folder');
    expect(msg).not.toMatch(/gh pr create/); // 那条路被守卫拦，指过去等于没给出口
    const sha = git(origin, ['rev-parse', 'f4-resume']);
    expect(gh.prs).toHaveLength(0);

    const out = await openFolder({ title: 't', body, docs }, ref, deps);
    expect(out.outcome).toBe('resumed');
    expect(out.complete).toBe(true);
    expect(gh.prs).toHaveLength(1);
    expect(git(origin, ['rev-parse', 'f4-resume'])).toBe(sha);
    expect(out.copied.sort()).toEqual(['docs/f4-resume.md', 'docs/f4-resume.zh-CN.md']);
  }, 60_000);

  it('**内容变了就不是重试**：照旧拒，且一个写请求都没发', async () => {
    const { src, docs } = fixture('f4-changed');
    gh.faults.set('POST /repos/o/r/pulls', ['fail']);
    await openFolder({ title: 't', body, docs }, ref, deps).catch(() => null);
    writeFileSync(join(src, 'f4-changed.md'), `**English** · [中文](f4-changed.zh-CN.md)\n\n# Demo v2\n\nChanged English body.\n`);
    gh.log = [];
    await expect(openFolder({ title: 't', body, docs }, ref, deps)).rejects.toThrow(/内容与这次要呈的不一样/);
    expect(gh.log.filter((l) => l.method !== 'GET')).toEqual([]);
  }, 60_000);

  it('续推时同样过 lint 闸门：远端孤儿分支体例不合格（缺中文版）→ 照拦，不建折', async () => {
    const { repo, docs } = fixture('f4-lint');
    // 手造一条「上次推上去、没建折」的孤儿分支，内容与这次要呈的一致，但只有英文版。
    git(repo, ['checkout', '-q', '-b', 'f4-lint']);
    execFileSync('cp', [docs[0]!, join(repo, 'docs', 'f4-lint.md')]);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'orphan']);
    git(repo, ['push', '-q', 'origin', 'f4-lint']);
    git(repo, ['checkout', '-q', 'main']);
    await expect(openFolder({ title: 't', body, docs: [docs[0]!] }, ref, deps)).rejects.toThrow(/体例不合格[\s\S]*缺中文版/);
    expect(posts(/\/pulls$/)).toBe(0);
  }, 60_000);
});

describe('F5 · POST /pulls 报错但折其实建成了 → 认领，不报失败、不重复建', () => {
  it('回包丢了（服务端已建）→ outcome=existing，只有一折', async () => {
    const { docs } = fixture('f5-drop');
    gh.faults.set('POST /repos/o/r/pulls', ['drop']);
    const out = await openFolder({ title: 't', body, docs }, ref, deps);
    expect(out.outcome).toBe('existing');
    expect(out.pr).toBe(gh.prs[0]!.number);
    expect(gh.prs).toHaveLength(1);
    expect(out.warnings.join()).toContain('没有重复建');
  }, 60_000);

  it('上次其实全成功了，调用方没收到回包又调一次 → outcome=existing，第二次零个 POST /pulls', async () => {
    const { docs } = fixture('f5-twice');
    const first = await openFolder({ title: 't', body, docs }, ref, deps);
    expect(first.outcome).toBe('created');
    gh.log = [];
    const second = await openFolder({ title: 't', body, docs }, ref, deps);
    expect(second.outcome).toBe('existing');
    expect(second.pr).toBe(first.pr);
    expect(posts(/\/pulls$/)).toBe(0);
    expect(gh.prs).toHaveLength(1);
  }, 60_000);

  it('并发重试撞上 422「already exists」→ 认领那一折', async () => {
    const { docs } = fixture('f5-race');
    gh.faults.set('POST /repos/o/r/pulls', ['fail']);
    await openFolder({ title: 't', body, docs }, ref, deps).catch(() => null);
    // 另一边抢先建好了
    gh.prs.push({ number: 99, html_url: 'https://github.com/o/r/pull/99', head: { ref: 'f5-race' }, state: 'open', merged_at: null, body: '', title: 't', labels: [] });
    const out = await openFolder({ title: 't', body, docs }, ref, deps);
    expect(out.pr).toBe(99);
    expect(out.outcome).toBe('existing');
    expect(gh.prs).toHaveLength(1);
  }, 60_000);

  it('建折失败、回头查也查不了 → 明说分支已推、原样重试安全', async () => {
    const { docs } = fixture('f5-blind');
    gh.faults.set('POST /repos/o/r/pulls', ['fail']);
    gh.faults.set('GET /repos/o/r/pulls', ['fail', 'fail']);
    const e = await openFolder({ title: 't', body, docs }, ref, deps).catch((x: unknown) => x);
    expect(String((e as Error).message)).toContain('已经推上去了');
    expect(String((e as Error).message)).toContain('不会开第二折');
  }, 60_000);
});

describe('F6 · 折建好了、label 没贴上 → 部分失败要报清楚，重试补齐', () => {
  it('label 那一步断网 → complete=false，incomplete 指名 labels 与补救；重试 → 补上，仍是一折', async () => {
    const { docs } = fixture('f6-labels');
    gh.faults.set('POST /repos/o/r/issues/', ['fail']);
    const out: OpenFolderResult = await openFolder({ title: 't', body, docs, track }, ref, deps);
    expect(out.outcome).toBe('created');
    expect(out.complete).toBe(false);
    expect(out.incomplete).toHaveLength(1);
    expect(out.incomplete[0]!.step).toBe('labels');
    expect(out.incomplete[0]!.remedy).toContain('原样重试 open_folder');
    expect(out.warnings.join()).toContain('折本身已建好');
    expect(gh.prs[0]!.labels).toEqual([]);

    const again = await openFolder({ title: 't', body, docs, track }, ref, deps);
    expect(again.outcome).toBe('existing');
    expect(again.complete).toBe(true);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]!.labels).toEqual(expect.arrayContaining(['proj:menxia', 'kind:设计', 'wait:你读']));
  }, 60_000);

  it('回读核标记那一步断网 → 不抛（折是好的），incomplete 记 verifyMarker', async () => {
    const { docs } = fixture('f6-verify');
    gh.faults.set('GET /repos/o/r/pulls/4', ['fail', 'fail']);
    const out = await openFolder({ title: 't', body, docs }, ref, deps);
    expect(out.pr).toBe(41);
    expect(out.complete).toBe(false);
    expect(out.incomplete.map((s) => s.step)).toEqual(['verifyMarker']);
  }, 60_000);

  it('全部顺利 → complete=true、incomplete=[]（旧字段一个不少）', async () => {
    const { docs } = fixture('f6-clean');
    const out = await openFolder({ title: 't', body, docs, track }, ref, deps);
    expect(out).toMatchObject({ outcome: 'created', complete: true, incomplete: [] });
    for (const k of ['pr', 'desk', 'prUrl', 'branch', 'copied', 'findings', 'warnings']) expect(out).toHaveProperty(k);
  }, 60_000);
});

describe('F7 · reply_comment 重试不发两条', () => {
  it('回包丢了（其实发出去了）→ 当成功返回 alreadyPosted，串上只有一条', async () => {
    gh.faults.set('POST /repos/o/r/pulls/12/comments/', ['drop']);
    const out = await replyComment({ pr: 12, commentId: 900, body: '采纳，已改。' }, ref) as { alreadyPosted?: boolean; recoveredFrom?: string };
    expect(out.alreadyPosted).toBe(true);
    expect(out.recoveredFrom).toBeTruthy();
    expect(gh.replies).toHaveLength(1);
  });

  it('真没发出去 → 报错并明说重试安全；重试 → 发一条', async () => {
    gh.faults.set('POST /repos/o/r/pulls/12/comments/', ['fail']);
    const e = await replyComment({ pr: 12, commentId: 900, body: '采纳' }, ref).catch((x: unknown) => x);
    expect(String((e as Error).message)).toContain('原样重试 reply_comment 是安全的');
    expect(gh.replies).toHaveLength(0);
    await replyComment({ pr: 12, commentId: 900, body: '采纳' }, ref);
    expect(gh.replies).toHaveLength(1);
  });

  it('上次成功了又调一次 → 不发第二条', async () => {
    await replyComment({ pr: 12, commentId: 900, body: '采纳' }, ref);
    const again = await replyComment({ pr: 12, commentId: 900, body: '采纳' }, ref) as { alreadyPosted?: boolean };
    expect(again.alreadyPosted).toBe(true);
    expect(gh.replies).toHaveLength(1);
    expect(posts(/replies$/)).toBe(1);
  });

  it('同一串上**不同**的话照发（查重只认逐字相同）', async () => {
    await replyComment({ pr: 12, commentId: 900, body: '采纳' }, ref);
    await replyComment({ pr: 12, commentId: 900, body: '再补一句' }, ref);
    expect(gh.replies).toHaveLength(2);
  });

  it('对 reply 的 reply 也查重：归位到根之后再比', async () => {
    gh.comment = { ...gh.comment, in_reply_to_id: 555 };
    await replyComment({ pr: 12, commentId: 901, body: '采纳' }, ref);
    await replyComment({ pr: 12, commentId: 902, body: '采纳' }, ref);
    expect(gh.replies).toHaveLength(1);
    expect(gh.replies[0]!.in_reply_to_id).toBe(555);
  });

  it('查重那一步断网 → 在写之前失败，一条都没发', async () => {
    gh.faults.set('GET /repos/o/r/pulls/12/comments', ['fail', 'fail']);
    await expect(replyComment({ pr: 12, commentId: 900, body: '采纳' }, ref)).rejects.toThrow(/连不上/);
    expect(posts(/replies$/)).toBe(0);
  });
});

describe('F8 · 无效入参在任何 git / 网络动作之前被拒', () => {
  it.each([
    ['-f', '选项'], ['--force', '选项'], ['main', 'main'], ['a b', '不认的字符'], ['x..y', '..'],
    ['feat/', '结尾'], ['.hidden', '开头'], ['x.lock', '.lock'], ['a~1', '不认的字符'], ['a:b', '不认的字符'],
  ])('branchProblem(%j) → 报', (b, needle) => {
    expect(branchProblem(b)).toContain(needle);
  });

  it.each(['官制-第一章', 'phase-3-tasks', 'feat/qian-tags', 'v2.1'])('branchProblem(%j) → 放行', (b) => {
    expect(branchProblem(b)).toBeNull();
  });

  it('坏分支名：origin 零变化、零请求', async () => {
    const { origin, docs } = fixture('f8-branch');
    const before = git(origin, ['for-each-ref']);
    await expect(openFolder({ title: 't', body, docs, branch: '--force' }, ref, deps)).rejects.toThrow(/选项/);
    expect(git(origin, ['for-each-ref'])).toBe(before);
    expect(gh.log).toEqual([]);
  });

  it('文件名推出来的 slug 带空格 → 在 git 之前说清楚，而不是「git worktree add 失败」', async () => {
    const { src } = fixture('f8-space');
    writeFileSync(join(src, 'my doc.md'), 'x');
    await expect(openFolder({ title: 't', body, docs: [join(src, 'my doc.md')] }, ref, deps)).rejects.toThrow(/不认的字符/);
  });

  it('标题超 256 / body 超 65536 → 推之前拒（否则会在 push 之后才 422，留下孤儿分支）', async () => {
    const { origin, docs } = fixture('f8-long');
    const before = git(origin, ['for-each-ref']);
    await expect(openFolder({ title: 'x'.repeat(257), body, docs }, ref, deps)).rejects.toThrow(/title 太长/);
    await expect(openFolder({ title: 't', body: { ...body, tldr: 'x'.repeat(70_000) }, docs }, ref, deps)).rejects.toThrow(/body 太长/);
    expect(git(origin, ['for-each-ref'])).toBe(before);
    expect(gh.log).toEqual([]);
  });

  it('回话超长 → 写之前拒', async () => {
    await expect(replyComment({ pr: 12, commentId: 900, body: 'x'.repeat(70_000) }, ref)).rejects.toThrow(/回话太长/);
    expect(gh.log).toEqual([]);
  });

  it('经 handleTool 走一遍（入参 schema 不变，新校验照样生效）', async () => {
    fixture('f8-tool');
    await expect(handleTool('open_folder', { title: 't', body, docs: ['/x/a.md'], branch: '-f' })).rejects.toThrow(/选项/);
    expect(gh.log).toEqual([]);
  });
});

describe('F10 · commentId 不在这一折上 → 写之前说清是哪一折', () => {
  it('批注在 #13，调用写的是 #12 → badInput，零写请求', async () => {
    gh.comment = { in_reply_to_id: null, pull_request_url: 'https://api.github.com/repos/o/r/pulls/13' };
    await expect(replyComment({ pr: 12, commentId: 900, body: '采纳' }, ref)).rejects.toThrow(/在 #13 上，不在 #12 上/);
    expect(posts(/./)).toBe(0);
  });
});

describe('L5 · assets 里的 .md 也要中文对子（走真 open_folder）', () => {
  it('只给 assets/notes.md → 体例不合格（缺中文版），origin 零变化', async () => {
    const { origin, src, docs } = fixture('l5-assets');
    mkdirSync(join(src, 'assets'));
    writeFileSync(join(src, 'assets', 'notes.md'), '**English** · [中文](notes.zh-CN.md)\n\nAsset notes in English.\n');
    const before = git(origin, ['for-each-ref']);
    const e = await openFolder({ title: 't', body, docs, assets: [join(src, 'assets', 'notes.md')] }, ref, deps).catch((x: unknown) => x);
    expect(String((e as Error).message)).toContain('notes 缺中文版');
    expect(git(origin, ['for-each-ref'])).toBe(before);
  }, 60_000);

  it('带上 notes.zh-CN.md → 过，两份都落在 docs/assets/', async () => {
    const { src, docs } = fixture('l5-assets-ok');
    mkdirSync(join(src, 'assets'));
    writeFileSync(join(src, 'assets', 'notes.md'), '**English** · [中文](notes.zh-CN.md)\n\nAsset notes in English.\n');
    writeFileSync(join(src, 'assets', 'notes.zh-CN.md'), '[English](notes.md) · **中文**\n\n这是素材说明的中文版。\n');
    const out = await openFolder({ title: 't', body, docs, assets: [join(src, 'assets', 'notes.md'), join(src, 'assets', 'notes.zh-CN.md')] }, ref, deps);
    expect(out.copied).toEqual(expect.arrayContaining(['docs/assets/notes.md', 'docs/assets/notes.zh-CN.md']));
    expect(out.findings.filter((f) => f.severity === 'hard')).toEqual([]);
  }, 60_000);
});
