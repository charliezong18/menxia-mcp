import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, dirtyDocs, NotAGitWorktree } from '../src/snapshot.js';
import { lint } from '../src/lint.js';

// snapshot 是 lint 侧唯一碰 IO 的模块，所以这里造真 git 仓。
// 注意：测试文件可以 import fs（守卫只管 src/），src/snapshot.ts 自己不许。

let root: string, origin: string, wt: string;
const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const EN = '**English** · [中文](a.zh-CN.md)\n\nAll prose here is English.\n';
const ZH = '[English](a.md) · **中文**\n\n这里全是中文正文。\n';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'zhupi-snap-'));
  origin = join(root, 'origin.git');
  wt = join(root, 'wt');

  g(root, 'init', '--bare', '-q', origin);
  g(root, 'clone', '-q', origin, wt);
  g(wt, 'config', 'user.email', 't@t');
  g(wt, 'config', 'user.name', 'T');
  g(wt, 'config', 'commit.gpgsign', 'false');

  // main 上先放一篇，用来测「已在 main 上」
  mkdirSync(join(wt, 'docs', 'assets'), { recursive: true });
  writeFileSync(join(wt, 'docs', 'old.md'), '**English** · [中文](old.zh-CN.md)\n\nOld.\n');
  writeFileSync(join(wt, 'docs', 'old.zh-CN.md'), '[English](old.md) · **中文**\n\n旧的。\n');
  g(wt, 'add', '.');
  g(wt, 'commit', '-qm', 'main');
  g(wt, 'branch', '-M', 'main');
  g(wt, 'push', '-q', '-u', 'origin', 'main');

  // 本折分支
  g(wt, 'checkout', '-qb', 'feature');
  writeFileSync(join(wt, 'docs', 'a.md'), EN);
  writeFileSync(join(wt, 'docs', 'a.zh-CN.md'), ZH);
  writeFileSync(join(wt, 'docs', 'assets', 'real.png'), 'png');
  writeFileSync(join(wt, 'docs', '.payload'), 'docs/p.md\n');
  g(wt, 'add', '.');
  g(wt, 'commit', '-qm', 'folder');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('happy path（真 git 仓）', () => {
  it('采到本折动过的文档和内容', () => {
    const s = collect({ worktree: wt, skipFetch: true });
    expect(s.changed).toEqual(['docs/a.md', 'docs/a.zh-CN.md']);
    expect(s.files.get('docs/a.md')).toBe(EN);
  });

  it('assets 路径相对 docs/（老脚本用 `docs/$ref` 拼）', () => {
    expect(collect({ worktree: wt, skipFetch: true }).assets).toEqual(new Set(['assets/real.png']));
  });

  it('读到 docs/.payload', () => {
    expect(collect({ worktree: wt, skipFetch: true }).payload).toEqual(['docs/p.md']);
  });

  it('从最新 main 切 → behind 0', () => {
    expect(collect({ worktree: wt, skipFetch: true }).base.behind).toBe(0);
  });

  it('本折没改 main 上已有的 → onMain 空', () => {
    expect(collect({ worktree: wt, skipFetch: true }).onMain.size).toBe(0);
  });

  it('接上 lint 全绿 —— 这个仓是照体例造的', () => {
    expect(lint(collect({ worktree: wt, skipFetch: true }))).toEqual([]);
  });
});

describe('对面那一半没被本折改动时也要探到', () => {
  // 只改中文版的情形：changed 里只有 .zh-CN.md，但双语对要知道 .md 在不在。
  it('只改一侧 → 另一侧仍被采进 files，不误报缺双语', () => {
    g(wt, 'checkout', '-qb', 'only-zh', 'main');
    writeFileSync(join(wt, 'docs', 'old.zh-CN.md'), '[English](old.md) · **中文**\n\n旧的，改了一句。\n');
    g(wt, 'add', '.');
    g(wt, 'commit', '-qm', 'only zh');
    const s = collect({ worktree: wt, skipFetch: true });
    expect(s.changed).toEqual(['docs/old.zh-CN.md']);
    expect(s.files.has('docs/old.md')).toBe(true);
    expect(lint(s).some((f) => f.rule === 1)).toBe(false);
    g(wt, 'checkout', '-q', 'feature');
  });
});

describe('已在 main 上的文档（规则 7）', () => {
  it('改了 main 上已有的 → onMain 里有它', () => {
    g(wt, 'checkout', '-qb', 'revise', 'main');
    writeFileSync(join(wt, 'docs', 'old.md'), '**English** · [中文](old.zh-CN.md)\n\nOld, revised.\n');
    g(wt, 'add', '.');
    g(wt, 'commit', '-qm', 'revise');
    const s = collect({ worktree: wt, skipFetch: true });
    expect(s.onMain.has('docs/old.md')).toBe(true);
    expect(lint(s).some((f) => f.rule === 7 && f.severity === 'warn')).toBe(true);
    g(wt, 'checkout', '-q', 'feature');
  });
});

describe('落后 main（规则 6）', () => {
  it('main 前进之后 behind > 0，且只是警告', () => {
    g(wt, 'checkout', '-q', 'main');
    writeFileSync(join(wt, 'docs', 'later.md'), 'x');
    g(wt, 'add', '.');
    g(wt, 'commit', '-qm', 'later');
    g(wt, 'push', '-q', 'origin', 'main');
    g(wt, 'checkout', '-q', 'feature');
    const s = collect({ worktree: wt, skipFetch: true });
    expect(s.base.behind).toBeGreaterThan(0);
    expect(lint(s).some((f) => f.rule === 6 && f.severity === 'warn')).toBe(true);
  });
});

describe('fetch 失败（规则 9）', () => {
  it('**origin 不可达 → fetchFailed=true**，不抛异常、不静默', () => {
    const broken = mkdtempSync(join(tmpdir(), 'zhupi-snap-broken-'));
    try {
      g(root, 'clone', '-q', origin, broken);
      g(broken, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
      const s = collect({ worktree: broken });
      expect(s.base.fetchFailed).toBe(true);
      expect(lint(s).some((f) => f.rule === 9)).toBe(true);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('skipFetch 时 fetchFailed 恒 false（巡检批量跑，外层只 fetch 一次）', () => {
    expect(collect({ worktree: wt, skipFetch: true }).base.fetchFailed).toBe(false);
  });
});

describe('不是 git 工作树', () => {
  it('抛 NotAGitWorktree，不是含糊的 git 报错', () => {
    const plain = mkdtempSync(join(tmpdir(), 'zhupi-plain-'));
    try {
      expect(() => collect({ worktree: plain })).toThrow(NotAGitWorktree);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('读提交过的内容，不读脏工作树', () => {
  // 这是与老脚本的一处**行为差异**（设计 §0：读分支树比读脏工作树更对）。
  // 正常流程里 open-folder.sh 在 commit+push 之后才跑，两者相同；
  // 但改完没提交就呈折时结论会不同，所以 dirtyDocs 要能报出来让 CLI 提醒。
  it('未提交的改动不进 snapshot', () => {
    writeFileSync(join(wt, 'docs', 'a.md'), '这是未提交的中文内容，会让规则 5 报错');
    try {
      expect(collect({ worktree: wt, skipFetch: true }).files.get('docs/a.md')).toBe(EN);
      expect(dirtyDocs(wt)).toContain('docs/a.md');
    } finally {
      g(wt, 'checkout', '--', 'docs/a.md');
    }
  });

  it('干净时 dirtyDocs 为空', () => {
    expect(dirtyDocs(wt)).toEqual([]);
  });
});

describe('巡检形态：按 ref 采别的分支', () => {
  it('传 ref 就能采那个分支，不用 checkout', () => {
    const s = collect({ worktree: wt, ref: 'revise', base: 'main', skipFetch: true });
    expect(s.changed).toEqual(['docs/old.md']);
  });
});
