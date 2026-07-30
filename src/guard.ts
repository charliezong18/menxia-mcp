// R7「绝对只读」的守卫。
//
// v1 的做法是扫源码找 POST/PATCH/PUT/DELETE 字面量——双 review 两边都判定它恒绿：
// Octokit 的具名写方法（issues.createComment / pulls.merge / .update）根本不含这些字符串，
// 而 `gh` 子进程的写调用同样绕过。所以 v2 改白名单。
//
// 「不发生什么」的要求，只能靠一条主动去找它的测试。

/** 允许出现 octokit.* 的唯一文件。**按完整相对路径匹配**——
 *  按 basename 匹配的话，把文件命名成 github.ts 丢进任意子目录即可全豁免（第二轮评审指出，
 *  与「别名让规则失效」是同一个坑的另一半）。 */
export const OCTOKIT_ALLOWED_FILE = 'src/github.ts';

/**
 * 唯一允许写文件的模块。
 *
 * R7 从「绝对只读」精确成「不写远端」之后，本地多出了一条写路径。
 * 第一轮评审指出：R7 之所以可信，靠的是一条**主动去找它**的测试；
 * 而新增写轴时没有那条测试，于是「往任意路径加一句 writeFileSync 能通过全部测试」。
 * 这条规则把写轴也焊上。
 */
export const FS_WRITE_ALLOWED_FILE = 'src/processed.ts';

// 注意分工：R7 的**执行机制**是 github.ts 里的运行时闸门（Octokit 实例封在闭包里 +
// hook 断言 method === 'GET' + 剔除会覆盖动词的 params）。第一轮代码评审用本地 server
// 实证了文本扫描做不到这件事——别名、模板 route、原生 fetch、node:https、git push
// 全部能绕过，而本项目自己的写法（oc.request(route, params)）本来就在盲区里。
// 所以本文件降级为**辅助 lint**：抓「不该出现在这里的网络出口」，作为第二道提示，
// 不作为唯一防线。

/** 扫描时跳过的文件：本文件自己含有全部模式串，扫它必然自伤。 */
export const SCAN_SKIP = new Set(['src/guard.ts']);

// gh 子进程的写调用。必须容忍参数被拆成数组元素的写法——
// execFile('gh', ['api', '-X', 'POST', …]) 里根本不存在 "-X POST" 这个连续子串。
// 自验用例抓到过这个漏洞（第一版只匹配带空格的连写形式）。
const VERB = 'POST|PUT|PATCH|DELETE';
const GH_WRITE_PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(`-X['"\\s,\\]]*\\s*['"]?(${VERB})\\b`, 'i'), 'gh -X 写方法'],
  [new RegExp(`--method['"\\s,\\]]*\\s*['"]?(${VERB})\\b`, 'i'), 'gh --method 写方法'],
  // gh api 带 -f/-F/--field/--raw-field 时**默认就是 POST**，不写 -X 也是写操作
  [/\bgh\b[\s\S]*?['"](-f|-F|--field|--raw-field)['"]/, 'gh api 带字段参数（隐式 POST）'],
  [/\bgh\b\s+(pr|issue|release|repo)\s+(create|edit|merge|close|comment|delete)/, 'gh 子命令写操作'],
];

export interface Violation {
  file: string;
  line: number;
  text: string;
  why: string;
}

/**
 * 纯函数：吃「文件名 → 源码」的映射，吐违规清单。
 * 不碰文件系统，方便用内联假源码自验。
 */
export function scanForMutations(files: Record<string, string>): Violation[] {
  const out: Violation[] = [];
  for (const [file, src] of Object.entries(files)) {
    const base = file;
    if (SCAN_SKIP.has(file)) continue;
    src.split('\n').forEach((text, i) => {
      const line = i + 1;
      const code = text.replace(/\/\/.*$/, '');

      // ① octokit.* 只允许出现在 github.ts
      if (/\boctokit\s*\./.test(code) && base !== OCTOKIT_ALLOWED_FILE) {
        out.push({ file, line, text: text.trim(), why: `octokit.* 只允许出现在 ${OCTOKIT_ALLOWED_FILE}` });
      }

      // ② 即便在 github.ts 里，也只允许 octokit.request(...)，不许具名方法
      if (base === OCTOKIT_ALLOWED_FILE && /\boctokit\s*\./.test(code) && !/\boctokit\s*\.\s*request\b/.test(code)) {
        out.push({ file, line, text: text.trim(), why: '只允许 octokit.request()，具名方法可能是写操作' });
      }

      // ②′ **fs 只允许 processed.ts import**（R7 精确成「不写远端」之后的本地写轴）。
      //
      // 焊 import 而不是焊调用名：第二轮评审证明按名字匹配拦不住
      // `openSync(p,'w')+writeSync`、`const w = FS.writeFileSync`、`copyFileSync` —— 三种全穿。
      // 而「谁能拿到 fs」是收口的，绕不过去。
      // 只管 src/：这条规则约束的是**跑起来的 server**；scripts/ 是本地验收台，
      // 它清自己的临时文件是正当的，把它也拦了只会逼人加例外，规则反而变松。
      if (
        base.startsWith('src/') &&
        base !== FS_WRITE_ALLOWED_FILE &&
        // `(\/promises)?` 是 2026-07-30 补的：Phase 2 设计阶段评审实测
        // `import { readFile } from 'node:fs/promises'` **整条穿过去** ——
        // 而那正是「换个写法顺手绕过守卫」最自然的形态。守卫自己犯了它要防的病。
        /(from\s*['"]node:fs(\/promises)?['"]|require\s*\(\s*['"](node:)?fs(\/promises)?['"]\s*\)|from\s*['"]fs(\/promises)?['"])/.test(code)
      ) {
        out.push({ file, line, text: text.trim(), why: `只有 ${FS_WRITE_ALLOWED_FILE} 能 import fs` });
      }

      // ②″ 再补一张网：即便 fs 是当参数传进来的，写操作的名字也拦一遍。
      // **连「提及」都拦**（不要求后面跟括号）——`const w = FS.writeFileSync` 这种
      // 取别名的写法后面没有括号，要求括号就漏了。注释已在上面剥掉，不会误报。
      if (
        base.startsWith('src/') &&
        base !== FS_WRITE_ALLOWED_FILE &&
        /\b(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|copyFileSync|cpSync|truncateSync|writeSync|rmSync|unlinkSync|renameSync|mkdirSync)\b/.test(code)
      ) {
        out.push({ file, line, text: text.trim(), why: `写文件只允许出现在 ${FS_WRITE_ALLOWED_FILE}` });
      }

      // ③ octokit.request 的 route 必须以 GET 开头
      const req = /\boctokit\s*\.\s*request\s*\(\s*[`'"]([A-Z]+)\s/.exec(code);
      if (req && req[1] !== 'GET') {
        out.push({ file, line, text: text.trim(), why: `route 必须以 GET 开头，实为 ${req[1]}` });
      }

      // ④ gh 子进程的写调用
      for (const [re, why] of GH_WRITE_PATTERNS) {
        if (re.test(code)) out.push({ file, line, text: text.trim(), why });
      }

      // ⑤ 网络出口白名单：fetch / node:https / http 请求只许出现在 github.ts。
      //    评审指出 v1 完全没把 fetch 放进雷达——绕开 Octokit 直接打 API 一路畅通。
      if (base !== OCTOKIT_ALLOWED_FILE && /\b(fetch|https?\.request|axios|undici)\s*\(/.test(code)) {
        out.push({ file, line, text: text.trim(), why: `网络出口只允许出现在 ${OCTOKIT_ALLOWED_FILE}` });
      }

      // ⑥ git 写操作。**只管 src/** —— 与 fs 那条同一个理由（②′）：
      // 这条规则约束的是**跑起来的 server**，而 `scripts/` 是本地验收台，
      // 它在 /tmp 造一次性样本仓（differential 每条规则一个必失败用例）是正当的。
      // 把它也拦了只会逼人加例外，规则反而变松。
      //
      // 2026-07-30 收窄。收窄前 `scripts/lint-differential.mjs` 造样本仓时被拦，
      // 而那些仓在 mkdtemp 出来的临时目录里、跑完就删，碰不到奏折仓。
      if (
        base.startsWith('src/') &&
        /\bgit\b[\s\S]*?['"](push|commit|merge|tag)['"]|git\s+(push|commit|merge)\b/.test(code)
      ) {
        out.push({ file, line, text: text.trim(), why: 'git 写操作' });
      }
    });
  }
  return out;
}

/** R1 顺带的守卫：不产生任何全局状态。 */
export function scanForGlobalState(files: Record<string, string>, pkgJson: string): Violation[] {
  const out: Violation[] = [];
  const pkg = JSON.parse(pkgJson) as Record<string, unknown>;
  if ('bin' in pkg) out.push({ file: 'package.json', line: 0, text: 'bin', why: 'bin 会往 PATH 里装全局指针' });
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  for (const hook of ['postinstall', 'preinstall', 'prepare']) {
    if (scripts[hook]) out.push({ file: 'package.json', line: 0, text: hook, why: `${hook} 会在装包时自动跑` });
  }
  for (const [file, src] of Object.entries(files)) {
    if (SCAN_SKIP.has(file)) continue;
    src.split('\n').forEach((text, i) => {
      const code = text.replace(/\/\/.*$/, '');
      if (/npm\s+link|\/usr\/local/.test(code)) {
        out.push({ file, line: i + 1, text: text.trim(), why: '全局单指针操作' });
      }
    });
  }
  return out;
}
