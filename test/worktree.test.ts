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

  // 变异战役（2026-07-30）里「拿到后不回读确认」**原样存活** —— 那句防御当时是零覆盖的。
  // 它防的是文件头写的残留竞态：A 读到陈旧锁 → C 抢先拿锁 → A 把 C 的新锁挪走。
  // 微秒级窗口靠并发跑撞不出来，所以开了 onCreated 这个接缝，直接把那一手插进去。
  it('建好锁之后被人挪走 —— 回读发现不是自己的，重新排队而不是揣着假锁往下走', async () => {
    const path = lockPath();
    let stolen = 0;
    const release = await acquireLock({
      lockPath: path,
      timeoutMs: 5_000,
      onCreated: () => {
        // 只偷第一次：第二轮让它正常拿到，否则测试会一直转到超时。
        if (stolen === 0) {
          stolen += 1;
          writeFileSync(path, JSON.stringify({ pid: 999_999, at: Date.now() }));
        }
      },
      // 偷锁那一手写的是个不存在的 pid，判活说它死了 —— 于是第二轮能抢回来。
      isAlive: (pid) => pid === process.pid,
    });
    expect(stolen).toBe(1);
    // 关键断言：最终握在手里的锁**确实是自己的**。
    expect((JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid).toBe(process.pid);
    release();
  }, 20_000);

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

  // 分支已存在一律拦。**「本地有」和「远端有」是两件事，提示不同** ——
  // 逐条断言在下面「崩溃残留要说人话」那一组里。这里只钉「一定拦得住」。
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
      )).rejects.toThrow(/分支 taken/);
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

// ── 第二轮评审（2026-07-30）之后补的：两条会让两个进程同时进临界区的时序 ──

describe('锁的两条竞态（评审推演出来的，不是撞出来的）', () => {
  // A 持锁超过 STALE_MS（一次特别慢的 push），B 判它陈旧抢走并进了临界区；
  // A 这时候收工，一句 rmSync 把 B 的有效锁删掉 —— 于是 C 能和 B 同时进去。
  it('持锁超时被人抢走后，自己 release **不能**删掉别人的锁', async () => {
    const path = lockPath();
    const release = await acquireLock({ lockPath: path, timeoutMs: 2_000 });
    // 模拟「B 抢走了」：锁文件现在记着别人的 pid
    writeFileSync(path, JSON.stringify({ pid: 424242, at: Date.now() }));
    release();
    expect(existsSync(path), '别人的锁被我删了').toBe(true);
    expect((JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid).toBe(424242);
  });

  // B 判定陈旧 → B 被调度走 → A 判定陈旧、抢锁、建新锁、回读确认，进临界区
  // → B 醒来 renameSync，挪走的是 A 刚建的**有效**锁（rename 成功）→ B 也进去了。
  it('抢锁时挪到手的不是刚才判陈旧的那一个 —— 原样还回去，继续排队', async () => {
    const path = lockPath();
    // 摆一个陈旧锁（pid 已死）
    writeFileSync(path, JSON.stringify({ pid: 999_998, at: Date.now() - STALE_MS - 1_000 }));
    let swapped = false;
    const release = await acquireLock({
      lockPath: path,
      timeoutMs: 5_000,
      isAlive: (pid) => pid !== 999_998, // 只有那个陈旧 pid 算死的
      onCreated: () => {
        // 第一次建好锁之后立刻替换成「别人的有效锁」，模拟 A 抢先拿到 ——
        // 回读会发现不是自己的，于是重排；重排时看到的是有效锁，等它。
        if (!swapped) {
          swapped = true;
          writeFileSync(path, JSON.stringify({ pid: 999_998, at: Date.now() - STALE_MS - 1_000 }));
        }
      },
    });
    // 最终握在手里的必须是自己的
    expect((JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid).toBe(process.pid);
    release();
  }, 20_000);
});

describe('崩溃残留要说人话（第二轮评审）', () => {
  it('本地有分支、远端没有 —— 说是崩溃残留并给清理命令，不是「换个 slug」', async () => {
    const { repo, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, 'crashed.md'), 'x\n');
    git(repo, ['branch', 'crashed']); // 模拟上次崩在 push 之前
    try {
      const e = await stageFolder(
        { docs: [join(src, 'crashed.md')], branch: 'crashed', message: 'm' },
        async () => {},
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      ).catch((x: unknown) => x);
      const msg = String((e as Error).message);
      expect(msg).toContain('崩在中途');
      expect(msg).toContain('branch -D crashed');
      expect(msg).not.toContain('换个 slug');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('远端也有 —— 那是重复呈折，提示不一样', async () => {
    const { repo, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, 'dupe.md'), 'x\n');
    git(repo, ['branch', 'dupe']);
    git(repo, ['push', '-q', 'origin', 'dupe']);
    git(repo, ['fetch', '-q', 'origin']);
    try {
      const e = await stageFolder(
        { docs: [join(src, 'dupe.md')], branch: 'dupe', message: 'm' },
        async () => {},
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      ).catch((x: unknown) => x);
      expect(String((e as Error).message)).toContain('远端已经存在');
      expect(String((e as Error).message)).toContain('list_folders');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('两条只能靠接缝证的防御（变异战役里原样存活过）', () => {
  // 时序：B 判陈旧 → B 被调度走 → A 抢锁成功并进临界区 → B 才动手 rename，
  // 挪走的是 A 刚建的**有效**锁。不核对的话 B 顺手就把它删了，两个人同时在里面。
  it('抢锁前有人拿到了有效锁 —— 挪错了要原样还回去，不是删掉', async () => {
    const path = lockPath();
    const stale = { pid: 999_997, at: Date.now() - STALE_MS - 1_000 };
    writeFileSync(path, JSON.stringify(stale));
    const other = { pid: 424_243, at: Date.now() };
    let swapped = false;
    // 只等一小会儿就放弃 —— 我们要的是「它没删掉别人的锁」，不是「它拿到了锁」。
    await expect(acquireLock({
      lockPath: path,
      timeoutMs: 700,
      isAlive: (pid) => pid !== 999_997,
      onBeforeSteal: () => {
        // 判完陈旧、动手之前，别人拿到了有效锁
        if (!swapped) { swapped = true; writeFileSync(path, JSON.stringify(other)); }
      },
    })).rejects.toThrow(/另一个会话/);
    expect(swapped).toBe(true);
    // 关键：别人的有效锁必须还在
    expect(existsSync(path), '别人的有效锁被抢锁流程删了').toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(other);
  }, 20_000);

  // 真机上 `commit.gpgsign=true` 会等 pinentry，仓里的钩子也可能等输入。
  // 没有超时 = server 永远挂着**而且锁还在手上**，别的会话跟着一起死。
  it('git 卡住（pre-commit 钩子不返回）—— 超时失败，不是永远挂着', async () => {
    const { repo, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, 'hang.md'), 'x\n');
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nsleep 60\n');
    execFileSync('chmod', ['+x', hook]);
    const prev = process.env.ZHUPI_GIT_TIMEOUT_MS;
    process.env.ZHUPI_GIT_TIMEOUT_MS = '1500';
    const t0 = Date.now();
    try {
      await expect(stageFolder(
        { docs: [join(src, 'hang.md')], branch: 'hangs', message: 'm' },
        async () => {},
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      )).rejects.toThrow(/commit/);
      expect(Date.now() - t0).toBeLessThan(20_000);
    } finally {
      if (prev === undefined) delete process.env.ZHUPI_GIT_TIMEOUT_MS;
      else process.env.ZHUPI_GIT_TIMEOUT_MS = prev;
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});

// ── 单语读物登记（2026-07-31 补）──
//
// `docs/.monolingual` 是 D9 给「不需要译本的读物」留的豁免，但它从加上起**一次都没能用上**：
// 那是个仓内文件，而 open_folder 只会把 docs 拷成 `docs/<basename>`，
// 没有任何路径能创建或追加它。后果不是理论上的 —— #31（22 章官制史）长期在巡检里
// 报 22 条假硬伤，而**一个开始报假红的检查，人就学会忽略它**。
describe('单语读物登记（docs/.monolingual）', () => {
  const noLint = async (): Promise<void> => {};

  it('第一次登记 —— 建出文件，内容是本折的文档路径', async () => {
    const { repo, origin, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, 'reading.md'), '# 只有中文的读物\n');
    try {
      const out = await stageFolder(
        { docs: [join(src, 'reading.md')], branch: 'mono-1', message: 'm', monolingual: true },
        noLint,
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      );
      expect(out.copied).toContain('docs/.monolingual');
      expect(git(origin, ['show', 'mono-1:docs/.monolingual'])).toBe('docs/reading.md');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  // 这一条是命脉：main 上已有的条目（前几折登记过的）一条都不能丢 ——
  // 丢了那几折下次就又被规则 1 判死，而且没人会立刻发现。
  it('已有条目**追加不覆盖**，且不重复', async () => {
    const { repo, origin, scratch } = fakeReviewRepo();
    const src = mkScratch();
    // main 上先有一份登记（模拟前几折留下的）
    writeFileSync(join(repo, 'docs', '.monolingual'), 'docs/older.md\ndocs/reading.md\n');
    git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'seed registry']); git(repo, ['push', '-q', 'origin', 'main']);
    writeFileSync(join(src, 'reading.md'), '# 又一篇\n');
    writeFileSync(join(src, 'fresh.md'), '# 新的\n');
    try {
      await stageFolder(
        { docs: [join(src, 'reading.md'), join(src, 'fresh.md')], branch: 'mono-2', message: 'm', monolingual: true },
        noLint,
        { reviewPath: repo, lockPath: join(src, 'l.lock') },
      );
      const got = git(origin, ['show', 'mono-2:docs/.monolingual']).split('\n');
      expect(got).toEqual(['docs/older.md', 'docs/reading.md', 'docs/fresh.md']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it('不给这个开关就一个字都不写', async () => {
    const { repo, origin, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, 'plain.md'), 'x\n');
    try {
      const out = await stageFolder(
        { docs: [join(src, 'plain.md')], branch: 'mono-3', message: 'm' },
        noLint, { reviewPath: repo, lockPath: join(src, 'l.lock') },
      );
      expect(out.copied).not.toContain('docs/.monolingual');
      expect(() => git(origin, ['show', 'mono-3:docs/.monolingual'])).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  // 登记的路径必须与 lint 的匹配方式一致：`lint.ts:190` 比的是**整行仓内路径**
  // （`snap.monolingual.includes(en)`），不是 slug。写错形式 = 豁免静默失效。
  it('写进去的是整行仓内路径，规则 1 真的认', async () => {
    const { repo, origin, scratch } = fakeReviewRepo();
    const src = mkScratch();
    writeFileSync(join(src, 'zh-only.md'), '# 中文读物\n');
    try {
      await stageFolder(
        { docs: [join(src, 'zh-only.md')], branch: 'mono-4', message: 'm', monolingual: true },
        noLint, { reviewPath: repo, lockPath: join(src, 'l.lock') },
      );
      const reg = git(origin, ['show', 'mono-4:docs/.monolingual']);
      expect(reg).toBe('docs/zh-only.md');
      // lint 侧真跑一遍：登记了就不该再报规则 1
      const { collect } = await import('../src/snapshot.js');
      const { lint } = await import('../src/lint.js');
      const findings = lint(collect({ worktree: repo, ref: 'origin/mono-4', base: 'origin/main', skipFetch: false }));
      expect(findings.filter((f) => f.rule === 1)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
