import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, parseArgs, render } from '../src/lint-render.js';
import { handleTool } from '../src/tools.js';
import { lint, type Finding } from '../src/lint.js';
import { collect } from '../src/snapshot.js';

// T5/T6 的判据：**两个口对同一折给出同一结论** —— findings 逐字段相等，
// 不是「都说合格」（那种断言在两边都坏掉时也是绿的）。

let root: string, wt: string;
const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'zhupi-cli-'));
  const origin = join(root, 'o.git');
  wt = join(root, 'wt');
  g(root, 'init', '--bare', '-q', origin);
  g(root, 'clone', '-q', origin, wt);
  g(wt, 'config', 'user.email', 't@t');
  g(wt, 'config', 'user.name', 'T');
  g(wt, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(wt, 'docs'), { recursive: true });
  writeFileSync(join(wt, 'docs', 'seed.md'), 'seed\n');
  g(wt, 'add', '.');
  g(wt, 'commit', '-qm', 'main');
  g(wt, 'branch', '-M', 'main');
  g(wt, 'push', '-q', '-u', 'origin', 'main');
  // 一折：故意缺中文版（硬伤）+ 断图（硬伤）
  g(wt, 'checkout', '-qb', 'bad');
  writeFileSync(join(wt, 'docs', 'x.md'), '**English** · [中文](x.zh-CN.md)\n\n![p](assets/gone.png)\n');
  g(wt, 'add', '.');
  g(wt, 'commit', '-qm', 'bad folder');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('两个口共用一个核', () => {
  it('**MCP 工具与直接调核的 findings 逐字段相等**', async () => {
    const direct = lint(collect({ worktree: wt, skipFetch: true }));
    const viaTool = (await handleTool('lint_folder', { worktree: wt })) as { findings: Finding[]; ok: boolean };
    expect(viaTool.findings).toEqual(direct);
    expect(viaTool.ok).toBe(false); // 有硬伤
  });

  it('CLI 的归一化输出与同一批 findings 一致', () => {
    const direct = lint(collect({ worktree: wt, skipFetch: true }));
    // 有硬伤时 CLI 退出码是 1，execFileSync 会抛 —— stdout 在异常对象里拿。
    let stdout: string;
    try {
      stdout = execFileSync(process.execPath, [join(process.cwd(), 'dist', 'lint-cli.js'), wt, '--parity'], { encoding: 'utf8' });
    } catch (e) {
      stdout = (e as { stdout?: string }).stdout ?? '';
    }
    const out = stdout.trim().split('\n').filter(Boolean);
    expect(out).toEqual(normalize(direct));
  });
});

describe('CLI 退出码', () => {
  const run = (args: string[]): { code: number; out: string; err: string } => {
    try {
      const out = execFileSync(process.execPath, [join(process.cwd(), 'dist', 'lint-cli.js'), ...args], { encoding: 'utf8' });
      return { code: 0, out, err: '' };
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { code: x.status ?? -1, out: x.stdout ?? '', err: x.stderr ?? '' };
    }
  };

  it('有硬伤 → 1', () => {
    const r = run([wt]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗');
  });

  it('合体例 → 0', () => {
    g(wt, 'checkout', '-qb', 'good', 'main');
    writeFileSync(join(wt, 'docs', 'y.md'), '**English** · [中文](y.zh-CN.md)\n\nAll English prose here.\n');
    writeFileSync(join(wt, 'docs', 'y.zh-CN.md'), '[English](y.md) · **中文**\n\n这里全是中文正文。\n');
    g(wt, 'add', '.');
    g(wt, 'commit', '-qm', 'good folder');
    const r = run([wt]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('体例合格');
    g(wt, 'checkout', '-q', 'bad');
  });

  it('**不是工作树 → 2，不是 1**。环境故障不能看起来像体例问题', () => {
    const plain = mkdtempSync(join(tmpdir(), 'zhupi-plain-cli-'));
    try {
      const r = run([plain]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('不是 git 工作树');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('不认识的参数 → 2', () => {
    expect(run([wt, '--nope']).code).toBe(2);
  });

  it('多给一个工作树 → 2（不静默取第一个）', () => {
    expect(run([wt, wt]).code).toBe(2);
  });
});

describe('parseArgs', () => {
  it('默认当前目录、非 json、非 parity', () => {
    expect(parseArgs([])).toEqual({ worktree: '.', json: false, parity: false });
  });

  it('位置参数 + 各个 flag', () => {
    expect(parseArgs(['/w', '--ref', 'origin/x', '--base', 'main', '--json'])).toEqual({
      worktree: '/w', ref: 'origin/x', base: 'main', json: true, parity: false,
    });
  });

  it('未知 flag 抛错，不静默忽略', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/不认识的参数/);
  });
});

describe('render', () => {
  const f = (over: Partial<Finding>): Finding => ({ rule: 1, severity: 'hard', subject: 's', message: 'm', ...over });

  it('警告排在硬伤前面 —— 硬伤是要照着修的，放最后不用往上翻', () => {
    const out = render([f({ severity: 'hard', message: '硬' }), f({ severity: 'warn', message: '软' })]);
    expect(out.indexOf('软')).toBeLessThan(out.indexOf('硬'));
  });

  it('只有警告 → 仍然说合格', () => {
    expect(render([f({ severity: 'warn' })])).toContain('体例合格');
  });

  it('零 finding → 合格', () => expect(render([])).toContain('体例合格'));
});

describe('normalize（对账用）', () => {
  const f = (rule: number, subject: string): Finding => ({ rule, severity: 'hard', subject, message: '随便' });

  it('比到 subject 粒度 —— 只比条数会变成又一个恒绿测试', () => {
    expect(normalize([f(4, 'assets/a.png')])).toEqual(['4:hard:assets/a.png']);
  });

  it('message 不参与对账（措辞改了不算行为变了）', () => {
    expect(normalize([{ rule: 1, severity: 'hard', subject: 'a', message: '甲' }]))
      .toEqual(normalize([{ rule: 1, severity: 'hard', subject: 'a', message: '乙' }]));
  });

  it('去重且排序，顺序不影响对账', () => {
    expect(normalize([f(4, 'b'), f(1, 'a'), f(4, 'b')])).toEqual(['1:hard:a', '4:hard:b']);
  });
});

describe('lint_folder 入参闸门', () => {
  it('未知入参被拒', async () => {
    await expect(handleTool('lint_folder', { path: '/w' })).rejects.toThrow(/只认/);
  });

  it('worktree 不是字符串 → 拒', async () => {
    await expect(handleTool('lint_folder', { worktree: 3 })).rejects.toThrow(/得是字符串/);
  });

  it('不是工作树 → 一句能照着改的话', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'zhupi-plain-tool-'));
    try {
      await expect(handleTool('lint_folder', { worktree: plain })).rejects.toThrow(/不是 git 工作树/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('巡检形态：传 ref 查别的分支，不用 checkout', async () => {
    const r = (await handleTool('lint_folder', { worktree: wt, ref: 'good', base: 'main' })) as { ok: boolean };
    expect(r.ok).toBe(true);
  });
});
