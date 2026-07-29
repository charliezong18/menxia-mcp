import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanForMutations, scanForGlobalState } from '../src/guard.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 递归扫，且不只扫 src —— 评审指出 v1 只看 src 顶层的 .ts：
// 开个子目录（src/lib/writer.ts）、写个 .mjs、或把写操作放进 scripts/，守卫连看都不看。
function readTree(rel: string, exts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try { entries = readdirSync(dir, { withFileTypes: true }) as never; } catch { return; }
    for (const e of entries as unknown as Array<{ name: string; isDirectory(): boolean }>) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
      else if (exts.some((x) => e.name.endsWith(x))) out[`${prefix}${e.name}`] = readFileSync(p, 'utf8');
    }
  };
  walk(join(root, rel), `${rel}/`);
  return out;
}

const readSrc = (): Record<string, string> => ({
  ...readTree('src', ['.ts', '.mts', '.js', '.mjs']),
  ...readTree('scripts', ['.mjs', '.js', '.ts']),
});

describe('R7 只读守卫：真源码', () => {
  it('src/ 里没有任何写操作', () => {
    const v = scanForMutations(readSrc());
    expect(v.map((x) => `${x.file}:${x.line} ${x.why} — ${x.text}`)).toEqual([]);
  });

  it('src/ 与 scripts/ 都真的被扫到了（防止扫了个空目录还报绿）', () => {
    const files = readSrc();
    expect(Object.keys(files).length).toBeGreaterThan(6);
    expect(files['src/github.ts']).toBeTruthy();
    expect(files['scripts/acceptance.mjs']).toBeTruthy();
  });

  it('递归扫得到子目录（v1 只看顶层）', () => {
    const nested = { 'src/lib/writer.ts': 'octokit.rest.pulls.merge(x)' };
    expect(scanForMutations(nested).length).toBeGreaterThan(0);
  });

  it('没有全局状态', () => {
    const v = scanForGlobalState(readSrc(), readFileSync(join(root, 'package.json'), 'utf8'));
    expect(v.map((x) => `${x.file} ${x.why}`)).toEqual([]);
  });
});

describe('R7 守卫自验：故意的坏源码必须变红', () => {
  // 双 review 的高危之一：v1 的守卫是扫 POST/PATCH/PUT/DELETE 字面量，
  // 而 Octokit 的具名写方法根本不含这些字符串 —— 那是个恒绿的守卫。
  // 下面每一条都是 v1 抓不到、v2 必须抓到的。

  it('抓得到 Octokit 具名写方法（不含任何 HTTP 动词字面量）', () => {
    const v = scanForMutations({ 'src/github.ts': 'await octokit.rest.issues.createComment({ body });' });
    expect(v.length).toBeGreaterThan(0);
  });

  it('抓得到 pulls.merge', () => {
    expect(scanForMutations({ 'src/github.ts': 'octokit.rest.pulls.merge(x)' }).length).toBeGreaterThan(0);
  });

  it('抓得到 gh 子进程的写调用', () => {
    const src = "execFile('gh', ['api', '-X' + ' POST', '/repos/x/y/issues/1/comments'])";
    expect(scanForMutations({ 'src/folders.ts': src.replace("'-X' + ' POST'", "'-X POST'") }).length).toBeGreaterThan(0);
  });

  it('抓得到 gh --method', () => {
    expect(scanForMutations({ 'src/x.ts': "run('gh', ['api', '--method', 'POST'])" }).length).toBeGreaterThan(0);
  });

  it('抓得到非 GET 的 octokit.request', () => {
    const v = scanForMutations({ 'src/github.ts': "octokit.request('POST /repos/{o}/{r}/issues')" });
    expect(v.some((x) => x.why.includes('GET'))).toBe(true);
  });

  it('抓得到 github.ts 之外出现的 octokit', () => {
    const v = scanForMutations({ 'src/folders.ts': 'octokit.request("GET /x")' });
    expect(v.some((x) => x.why.includes('github.ts'))).toBe(true);
  });

  it('合法的 GET 不误伤', () => {
    expect(scanForMutations({ 'src/github.ts': "const r = await octokit.request(route, params);" })).toEqual([]);
    expect(scanForMutations({ 'src/github.ts': "octokit.request('GET /repos/{o}/{r}/pulls')" })).toEqual([]);
  });

  it('注释里提到写操作不算违规', () => {
    expect(scanForMutations({ 'src/x.ts': '// 这里以后会用 octokit.rest.pulls.create' })).toEqual([]);
  });

  it('抓得到 package.json 的 bin 与 postinstall', () => {
    const v = scanForGlobalState({}, JSON.stringify({ bin: { x: 'y' }, scripts: { postinstall: 'z' } }));
    expect(v.map((x) => x.text).sort()).toEqual(['bin', 'postinstall']);
  });

  it('抓得到 npm link 与 /usr/local', () => {
    expect(scanForGlobalState({ 'src/x.ts': 'npm link' }, '{}').length).toBeGreaterThan(0);
    expect(scanForGlobalState({ 'src/x.ts': 'cp dist /usr/local/bin' }, '{}').length).toBeGreaterThan(0);
  });
});

describe('R7 守卫自验：参数被拆成数组元素的写法（第一版漏过）', () => {
  it("抓得到 ['-X', 'POST'] 这种拆开的写法", () => {
    expect(scanForMutations({ 'src/x.ts': "execFile('gh', ['api', '-X', 'POST', '/x'])" }).length).toBeGreaterThan(0);
  });

  it("抓得到 ['--method', 'DELETE']", () => {
    expect(scanForMutations({ 'src/x.ts': "run('gh', ['api', '--method', 'DELETE'])" }).length).toBeGreaterThan(0);
  });

  it('抓得到 gh api 带 -f（gh 在有字段参数时默认就是 POST，不写 -X 也是写）', () => {
    expect(scanForMutations({ 'src/x.ts': "run('gh', ['api', 'repos/x/y/issues/1/comments', '-f', 'body=hi'])" }).length).toBeGreaterThan(0);
  });

  it('抓得到 gh pr create / gh pr merge 这类子命令', () => {
    expect(scanForMutations({ 'src/x.ts': "run('gh pr create --title x')" }).length).toBeGreaterThan(0);
    expect(scanForMutations({ 'src/x.ts': "run('gh pr merge 1 --squash')" }).length).toBeGreaterThan(0);
  });

  it('读操作的 gh 调用不误伤', () => {
    expect(scanForMutations({ 'src/x.ts': "run('gh', ['auth', 'token'])" })).toEqual([]);
    expect(scanForMutations({ 'src/x.ts': "run('gh', ['pr', 'view', '18'])" })).toEqual([]);
  });
});
