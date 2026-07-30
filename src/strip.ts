// 剥掉 markdown 里的代码跨度（fenced code block + inline code）。
//
// 为什么单列一个模块（需求 R4）：断图检查和语言方向检查**必须共用同一套剥离逻辑**。
//
// 病历（SPEC §5.1）：`zhupi-mcp/SPEC.zh-CN.md` 这份文档第一次呈折就被 lint 拦下，
// 报了两张「断图」—— 实际是正文里用来说明规则本身的字面量例子，写在 inline code 里。
// **一篇讲 lint 规则的文档过不了 lint。** 当时的绕法是改写措辞躲开，那是权宜。
//
// 这个 helper 错了会让两条规则**同时**误判，而且方向相反：
//   · 剥多了 → 断图漏报（真断图被当成代码里的例子）
//   · 剥少了 → 语言方向误报（代码里的中文注释被算进正文 CJK 占比）
// 两个方向都不容易靠观察发现，所以它自己要有一组边界用例。

/**
 * 把代码跨度替换成等量的空白，**保持字符数不变**。
 *
 * 为什么不是直接删掉：调用方（断图检查）要报「第几行」。删掉会让行号错位，
 * 而错位的行号比没有行号更糟 —— 它看着像个准确答案。
 */
export function stripCode(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  // 围栏用「首次出现的那种字符 + 长度」配对：``` 不能被 ~~~ 关掉，
  // 而 ```` 里面可以套 ```（CommonMark 的规则是「关闸围栏不短于开闸围栏」）。
  let fence: { char: string; len: number } | null = null;

  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (m) {
        fence = { char: m[1]![0]!, len: m[1]!.length };
        out.push(blank(line)); // 围栏行本身也剥掉——它可能带 info string（如 ```ts）
        continue;
      }
      out.push(stripInline(line));
    } else {
      // 只有同种字符、且不短于开闸的围栏才能关闸。
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len) fence = null;
      out.push(blank(line));
    }
  }
  // 围栏没关就一直剥到末尾——这是刻意的：反引号数不匹配时，
  // 宁可把剩下的正文当代码（断图漏报，良性）也不要把代码当正文
  // （语言方向误报 = 拦住一篇没问题的文档，而这个项目对「拦太死」的记载反应是绕过）。
  return out.join('\n');
}

const blank = (s: string): string => ' '.repeat(s.length);

/**
 * 剥单行里的 inline code。
 *
 * 按 CommonMark：开闸用 N 个连续反引号，必须由**同样 N 个**连续反引号闭合，
 * 所以 ``a ` b`` 里那个单反引号是正文的一部分。
 * 不跨行 —— inline code 可以跨行，但那种写法在这个仓的文档里没有，
 * 而支持它需要整篇扫描，会把「行号」这件事搞复杂。**这个取舍写在这里，别当 bug 修。**
 */
function stripInline(line: string): string {
  const chars = [...line];
  const out = [...line];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== '`') {
      i += 1;
      continue;
    }
    let n = 0;
    while (i + n < chars.length && chars[i + n] === '`') n += 1;
    // 找同样长度的闭合围栏（不能是更长的一段反引号的一部分）
    let j = i + n;
    let closed = -1;
    while (j < chars.length) {
      if (chars[j] === '`') {
        let k = 0;
        while (j + k < chars.length && chars[j + k] === '`') k += 1;
        if (k === n) {
          closed = j;
          break;
        }
        j += k;
      } else {
        j += 1;
      }
    }
    if (closed < 0) {
      // 没闭合：这段反引号是正文，跳过它继续找后面的
      i += n;
      continue;
    }
    for (let p = i; p < closed + n; p += 1) out[p] = ' ';
    i = closed + n;
  }
  return out.join('');
}
