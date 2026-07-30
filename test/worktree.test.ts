import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { acquireLock, stageFolder, STALE_MS } from '../src/worktree.js';
import { isFailure } from '../src/errors.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

/** 造一个假奏折仓：bare 当 origin，clone 当本地 checkout，main 上有一篇旧文档。 */
function fakeReviewRepo(): { repo: string; origin: string; scratch: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'zhupi-test-'));
  const origin = join(scratch, 'origin.git');
  const repo = join(scratch, 'review');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, repo]);
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'already-here.md'), '旧的\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  return { repo, origin, scratch };
}

const scratches: string[] = [];
const mkScratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'zhupi-src-'));
  scratches.push(d);
  return d;
};
afterEach(() => {
  for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true });
});

const lockPath = (): string => join(mkScratch(), 'review.lock');

describe('锁：崩溃后不能死锁（O_EXLOCK 在 Node 25 上不存在，这条是替代方案的命脉）', () => {
  beforeAll(() => {
    // 子进程要 import 编译产物；`npm test` 里 tsc 先跑，单跑这个文件时补一次。
    execFileSync('npx', ['tsc'], { cwd: root, stdio: 'ignore' });
  });

  it('持锁进程被 SIGKILL 之后，下一次拿锁**不超时**（真 kill 一个子进程）', async () => {
    const path = lockPath();
    const script = `
      import { acquireLock } from '${join(root, 'dist/worktree.js')}';
      await acquireLock({ lockPath: ${JSON.stringify(path)} });
      process.stdout.write('held\\n');
      setInterval(() => {}, 1000);   // 抓着锁不放，等着被 kill
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((r) => { child.stdout.on('data', (b: Buffer) => { if (String(b).includes('held')) r(); }); });
    expect(existsSync(path)).toBe(true);
    const held = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    expect(held.pid).toBe(child.pid);

    child.kill('SIGKILL');
    await new Promise<void>((r) => { child.on('exit', () => r()); });
    // 锁文件**还在**（SIGKILL 没有 finally），所以这条走的是判活那条路，不是「文件没了」。
    expect(existsSync(path)).toBe(true);

    const t0 = Date.now();
    const release = await acquireLock({ lockPath: path, timeoutMs: 5_000 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    release();
    expect(existsSync(path)).toBe(false);
  }, 30_000);

  it('持锁进程还活着 —— 等到超时，报「另一个会话在呈折」，不是挂死', async () => {
    const path = lockPath();
    const release = await acquireLock({ lockPath: path, isAlive: () => true });
    try {
      const t0 = Date.now();
      await expect(acquireLock({ lockPath: path, timeoutMs: 600, isAlive: () => true }))
        .rejects.toThrow(/另一个会话/);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    } finally {
      release();
    }
  });

  it('锁文件写了一半就崩（内容读不出来）—— 当陈旧，可抢', async () => {
    const path = lockPath();
    writeFileSync(path, '{"pid":');
    const release = await acquireLock({ lockPath: path, timeoutMs: 2_000 });
    release();
  });

  it('锁太老（超过 STALE_MS）—— 当陈旧，即便 pid 还活着', async () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() - STALE_MS - 1_000 }));
    const release = await acquireLock({ lockPath: path, timeoutMs: 2_000, isAlive: () => true });
    release();
  });

  it('两个真进程同时抢 —— 持锁窗口不重叠（这才叫锁生效）', async () => {
    const path = lockPath();
    const one = (tag: string): Promise<string> => {
      const script = `
        import { acquireLock } from '${join(root, 'dist/worktree.js')}';
        const rel = await acquireLock({ lockPath: ${JSON.stringify(path)}, timeoutMs: 20000 });
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, 400));
        rel();
        process.stdout.write(JSON.stringify({ tag: '${tag}', t0, t1: Date.now() }));
      `;
      return new Promise((res, rej) => {
        const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        c.stdout.on('data', (b: Buffer) => { out += String(b); });
        c.stderr.on('data', (b: Buffer) => { err += String(b); });
        c.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(err))));
      });
    };
    const [a, b] = (await Promise.all([one('a'), one('b')])).map((s) => JSON.parse(s) as { t0: number; t1: number });
    const overlap = Math.min(a!.t1, b!.t1) - Math.max(a!.t0, b!.t0);
    expect(overlap).toBeLessThanOrEqual(0);
  }, 40_000);
});

describe('stageFolder：端到端', () => {
  const noLint = async (): Promise<void> => {};

  it('推上去了，远端真多一个分支，内容逐字节相等', async () => {
    const { repo, origin, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, 'demo.md'), '# English\n\n正文里有中文\n');
    writeFileSync(join(src, 'demo.zh-CN.md'), '# 中文\n');
    mkdirSync(join(src, 'img'));
    writeFileSync(join(src, 'img', 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
    try {
      const out = await stageFolder(
        {
          docs: [join(src, 'demo.md'), join(src, 'demo.zh-CN.md')],
          assets: [join(src, 'img', 'p.png')],
          branch: 'demo-folder',
          message: '读物：demo',
        },
        noLint,
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      );
      expect(out.copied.sort()).toEqual(['docs/assets/p.png', 'docs/demo.md', 'docs/demo.zh-CN.md']);

      // 从 **origin**（bare）读，不是从本地读 —— 证明真推上去了
      expect(git(origin, ['rev-parse', '--verify', 'demo-folder'])).toBe(out.headSha);
      expect(git(origin, ['show', 'demo-folder:docs/demo.md'])).toBe('# English\n\n正文里有中文');
      const png = execFileSync('git', ['show', 'demo-folder:docs/assets/p.png'], { cwd: origin, maxBuffer: 1 << 20 });
      expect(Buffer.compare(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(0);

      // worktree 收干净了
      expect(git(repo, ['worktree', 'list'])).not.toContain('zhupi-wt-');
      expect(existsSync(out.worktree)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  // MILESTONES 判据：不合格时远端零变化、本地零残留。
  // 老脚本做不到这一点 —— 它跑的时候分支早被人手推上去了。
  it('lint 不合格 —— 远端零变化，本地无残留 worktree、无残留分支', async () => {
    const { repo, origin, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, 'bad.md'), 'x\n');
    const before = git(origin, ['for-each-ref', '--format=%(refname)']);
    try {
      await expect(stageFolder(
        { docs: [join(src, 'bad.md')], branch: 'bad-folder', message: 'm' },
        async () => { throw new Error('体例不合格：缺中文对子'); },
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      )).rejects.toThrow(/体例不合格/);

      expect(git(origin, ['for-each-ref', '--format=%(refname)'])).toBe(before);
      expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).not.toContain('bad-folder');
      expect(git(repo, ['worktree', 'list'])).not.toContain('zhupi-wt-');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('分支已存在 —— 明着报，不覆盖（重复呈折是真事故）', async () => {
    const { repo, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, 'a.md'), 'x\n');
    git(repo, ['branch', 'taken']);
    try {
      await expect(stageFolder(
        { docs: [join(src, 'a.md')], branch: 'taken', message: 'm' },
        noLint,
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      )).rejects.toThrow(/已经存在/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('文件名撞上 main 里已有的 —— 明着报，不静默覆盖', async () => {
    const { repo, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, 'already-here.md'), '新的\n');
    try {
      await expect(stageFolder(
        { docs: [join(src, 'already-here.md')], branch: 'clash', message: 'm' },
        noLint,
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      )).rejects.toThrow(/已经在 main 上/);
      expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).not.toContain('clash');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('源文件不存在 —— 报出是哪一个，不是 ENOENT stack', async () => {
    const { repo, scratch } = fakeReviewRepo();
    const src = mkScratch();
    try {
      const e = await stageFolder(
        { docs: [join(src, 'nope.md')], branch: 'x', message: 'm' },
        noLint,
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      ).catch((err: unknown) => err);
      expect(isFailure(e)).toBe(true);
      expect(String((e as Error).message)).toContain('nope.md');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('两份文档重名 —— 拷进去会互相覆盖，先拦下来', async () => {
    const { repo, scratch } = fakeReviewRepo();
    const src = mkScratch();
    mkdirSync(join(src, 'a')); mkdirSync(join(src, 'b'));
    writeFileSync(join(src, 'a', 'same.md'), '1\n');
    writeFileSync(join(src, 'b', 'same.md'), '2\n');
    try {
      await expect(stageFolder(
        { docs: [join(src, 'a', 'same.md'), join(src, 'b', 'same.md')], branch: 'dup', message: 'm' },
        noLint,
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      )).rejects.toThrow(/重名/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  // 中文名文件是 #31 那折 22 篇踩过的坑（git 默认转义非 ASCII 路径）。
  it('中文名文档照样推得上去（core.quotePath=false）', async () => {
    const { repo, origin, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, '官制-第一章.md'), '# 一\n');
    try {
      const out = await stageFolder(
        { docs: [join(src, '官制-第一章.md')], branch: 'zh-name', message: 'm' },
        noLint,
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      );
      expect(out.copied).toEqual(['docs/官制-第一章.md']);
      expect(git(origin, ['show', 'zh-name:docs/官制-第一章.md'])).toBe('# 一');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
