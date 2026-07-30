import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanForMutations, scanForGlobalState, FS_WRITE_ALLOWED, GIT_WRITE_ALLOWED } from '../src/guard.js';

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

describe('R7 的本地写轴也要焊上（第一轮评审）', () => {
  // R7 之所以可信，靠的是一条**主动去找它**的测试。加本地写路径时没加这条，
  // 于是「往任意路径加一句 writeFileSync 能通过全部测试」。
  it('src/ 里不在白名单上的文件出现 fs 写就报', () => {
    const v = scanForMutations({ 'src/folders.ts': 'writeFileSync(p, x);' });
    expect(v.map((x) => x.why)).toContain('写文件只允许出现在 src/processed.ts / src/worktree.ts');
  });

  it('processed.ts 自己写是允许的', () => {
    expect(scanForMutations({ 'src/processed.ts': 'writeFileSync(p, x); renameSync(a, b);' })).toEqual([]);
  });

  it('各种写法都拦：append / stream / unlink / mkdir / rename', () => {
    for (const call of [
      'appendFileSync(p, x)', 'createWriteStream(p)', 'unlinkSync(p)',
      'mkdirSync(d)', 'renameSync(a, b)', 'rmSync(p)', 'await writeFile(p, x)',
    ]) {
      expect(scanForMutations({ 'src/index.ts': call }).length, call).toBeGreaterThan(0);
    }
  });

  it('scripts/ 不受这条管 —— 验收台清自己的临时文件是正当的', () => {
    expect(scanForMutations({ 'scripts/acceptance.mjs': 'rmSync(stateFile);' })).toEqual([]);
  });

  it('注释里提到 writeFileSync 不算违规', () => {
    expect(scanForMutations({ 'src/index.ts': '// 这里不能 writeFileSync(p, x)' })).toEqual([]);
  });
});

describe('fs 守卫要焊 import，不能只焊调用名（第二轮评审：三种绕法全穿）', () => {
  const cases: [string, string][] = [
    ['openSync + writeSync', "const fd = openSync(p, 'w'); writeSync(fd, s);"],
    ['取别名', 'const w = FS.writeFileSync; w(p, s);'],
    ['copyFileSync', 'copyFileSync(a, b);'],
    ['import fs 本身', "import { writeFileSync } from 'node:fs';"],
    ['require fs', "const fs = require('fs');"],
    ['import 不带 node: 前缀', "import fs from 'fs';"],
  ];
  for (const [name, code] of cases) {
    it(`拦得住：${name}`, () => {
      expect(scanForMutations({ 'src/folders.ts': code }).length, code).toBeGreaterThan(0);
    });
  }

  it('processed.ts 自己不受限', () => {
    for (const [, code] of cases) {
      expect(scanForMutations({ 'src/processed.ts': code }), code).toEqual([]);
    }
  });

  it('scripts/ 不受这条管 —— 验收台清自己的临时文件是正当的', () => {
    expect(scanForMutations({ 'scripts/acceptance.mjs': "import { rmSync } from 'node:fs'; rmSync(f);" })).toEqual([]);
  });
});

// —— Phase 3：白名单从「单值」放宽成「Set」——
//
// 放松是这个项目栽跟头最多的方向。放宽本身没问题，**没人看着它变长**才是问题：
// 往 Set 里随手加一个成员，上面那些测试一条都不会红 —— 因为它们测的是
// 「白名单外的文件被拦」，而加成员恰恰是把文件挪到白名单**内**。
// 所以这里钉的是**长度**：白名单变长必须同时改测试，也就是必须被人看见一次。
describe('白名单的长度被钉死（否则它会悄悄变长）', () => {
  it('fs 写白名单恰好两个成员，且就是这两个', () => {
    expect([...FS_WRITE_ALLOWED].sort()).toEqual(['src/processed.ts', 'src/worktree.ts']);
    expect(FS_WRITE_ALLOWED.size).toBe(2);
  });

  it('git 写白名单恰好一个成员 —— SPEC §4.2：唯一碰奏折仓的模块', () => {
    expect([...GIT_WRITE_ALLOWED]).toEqual(['src/worktree.ts']);
    expect(GIT_WRITE_ALLOWED.size).toBe(1);
  });
});

describe('Phase 3 新豁免：正向放行，反向仍拦', () => {
  it('worktree.ts 可以 import fs、可以 mkdtemp/copyFile/openSync', () => {
    expect(scanForMutations({
      'src/worktree.ts': [
        "import { copyFileSync, mkdtempSync, openSync, rmSync } from 'node:fs';",
        'const dir = mkdtempSync(prefix);',
        'copyFileSync(src, dst);',
        "const fd = openSync(lock, 'w');",
      ].join('\n'),
    })).toEqual([]);
  });

  it('worktree.ts 可以跑 git 写命令', () => {
    expect(scanForMutations({
      'src/worktree.ts': [
        "await run('git', ['worktree', 'add', dir, '-b', slug, 'origin/main']);",
        "await run('git', ['commit', '-m', msg]);",
        "await run('git', ['push', '-u', 'origin', slug]);",
      ].join('\n'),
    })).toEqual([]);
  });

  // 反向：同样的代码换个文件名必须被拦。不测这一条的话，
  // 「豁免是按文件给的」这句话就没有任何东西在保证。
  it('同样的代码放在别的 src/ 文件里 —— 全部被拦', () => {
    const fsCode = "import { copyFileSync } from 'node:fs';\ncopyFileSync(a, b);";
    const gitCode = "await run('git', ['push', '-u', 'origin', slug]);";
    for (const f of ['src/tools.ts', 'src/body.ts', 'src/worktrees.ts', 'src/sub/worktree.ts']) {
      expect(scanForMutations({ [f]: fsCode }).length, `fs @ ${f}`).toBeGreaterThan(0);
      expect(scanForMutations({ [f]: gitCode }).length, `git @ ${f}`).toBeGreaterThan(0);
    }
  });

  // `src/sub/worktree.ts` 那一条是刻意放进去的：白名单按**完整相对路径**匹配。
  // 按 basename 匹配的话，把文件塞进任意子目录即可全豁免 —— 第二轮评审在
  // OCTOKIT_ALLOWED_FILE 上抓过同一个坑，这里不重犯。
  it('子目录同名文件不享受豁免（按完整路径匹配，不按 basename）', () => {
    expect(FS_WRITE_ALLOWED.has('src/sub/worktree.ts')).toBe(false);
    expect(scanForMutations({ 'src/sub/worktree.ts': "import fs from 'node:fs';" }).length).toBeGreaterThan(0);
  });

  it('mkdtempSync / openSync 也在拦截名单里（原来一个字都没提）', () => {
    for (const call of ['mkdtempSync(p)', "openSync(p, 'w')"]) {
      expect(scanForMutations({ 'src/tools.ts': call }).length, call).toBeGreaterThan(0);
    }
  });
});

describe('fs 守卫不能被换个写法绕过（Phase 2 设计评审实测）', () => {
  // `node:fs/promises` 原本整条穿过去。这是守卫自己犯了它要防的那个病：
  // 「顺手换个写法」正是漏执行最自然的形态。
  const bypass = [
    "import { readFile } from 'node:fs/promises';",
    "import fs from 'fs/promises';",
    "const { readFile } = require('node:fs/promises');",
    "const fsp = require('fs/promises');",
    'import { readFileSync } from "node:fs";',
    "import * as FS from 'fs';",
  ];
  for (const code of bypass) {
    it(`拦得住：${code.slice(0, 42)}`, () => {
      expect(scanForMutations({ 'src/snapshot.ts': code }).length, code).toBeGreaterThan(0);
    });
  }

  it('processed.ts 自己不受限', () => {
    for (const code of bypass) expect(scanForMutations({ 'src/processed.ts': code }), code).toEqual([]);
  });

  it('不误伤：名字里带 fs 的别的模块', () => {
    for (const code of ["import x from 'fsevents';", "import y from './fs-helper.js';", "import z from 'node:os';"]) {
      expect(scanForMutations({ 'src/snapshot.ts': code }), code).toEqual([]);
    }
  });
});

describe('git 写操作的作用域（2026-07-30 收窄，把边界钉住）', () => {
  // 收窄是有代价的动作：guard 是这个项目对「静默失效」的唯一防线，
  // 放宽一次很难收回。所以边界必须有测试写下来，不能只靠注释。
  it('src/ 里的 git 写操作照拦', () => {
    for (const code of ["git('push')", 'execFileSync("git", ["commit"])', 'git push origin main']) {
      expect(
        scanForMutations({ 'src/snapshot.ts': code }).some((v) => v.why.startsWith('git 写操作')),
        code,
      ).toBe(true);
    }
  });

  it('src/ 里的 git **读**操作不拦（snapshot.ts 靠它采料）', () => {
    for (const code of ["git(cwd, ['show', ref])", "git(cwd, ['diff', '--name-only'])", "git(cwd, ['fetch', '-q'])"]) {
      expect(scanForMutations({ 'src/snapshot.ts': code }), code).toEqual([]);
    }
  });

  it('scripts/ 造一次性样本仓不拦 —— 那些仓在 mkdtemp 里、跑完就删', () => {
    expect(scanForMutations({ 'scripts/lint-differential.mjs': "sh('git', ['commit', '-qm', 'x'], wt);" })).toEqual([]);
  });

  it('**收窄只到 scripts/**，别的目录不享受', () => {
    expect(scanForMutations({ 'src/tools.ts': "sh('git', ['push'])" }).length).toBeGreaterThan(0);
  });
});
