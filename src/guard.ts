// R7「绝对只读」的守卫。
//
// v1 的做法是扫源码找 POST/PATCH/PUT/DELETE 字面量——双 review 两边都判定它恒绿：
// Octokit 的具名写方法（issues.createComment / pulls.merge / .update）根本不含这些字符串，
// 而 `gh` 子进程的写调用同样绕过。所以 v2 改白名单。
//
// 「不发生什么」的要求，只能靠一条主动去找它的测试。

/** 允许出现 octokit.* 的唯一文件。 */
export const OCTOKIT_ALLOWED_FILE = 'github.ts';

/** 扫描时跳过的文件：本文件自己含有全部模式串，扫它必然自伤。 */
export const SCAN_SKIP = new Set(['guard.ts']);

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
    const base = file.split('/').pop() ?? file;
    if (SCAN_SKIP.has(base)) continue;
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

      // ③ octokit.request 的 route 必须以 GET 开头
      const req = /\boctokit\s*\.\s*request\s*\(\s*[`'"]([A-Z]+)\s/.exec(code);
      if (req && req[1] !== 'GET') {
        out.push({ file, line, text: text.trim(), why: `route 必须以 GET 开头，实为 ${req[1]}` });
      }

      // ④ gh 子进程的写调用
      for (const [re, why] of GH_WRITE_PATTERNS) {
        if (re.test(code)) out.push({ file, line, text: text.trim(), why });
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
    const base = file.split('/').pop() ?? file;
    if (SCAN_SKIP.has(base)) continue;
    src.split('\n').forEach((text, i) => {
      const code = text.replace(/\/\/.*$/, '');
      if (/npm\s+link|\/usr\/local/.test(code)) {
        out.push({ file, line: i + 1, text: text.trim(), why: '全局单指针操作' });
      }
    });
  }
  return out;
}
