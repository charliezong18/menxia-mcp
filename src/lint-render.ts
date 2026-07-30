// CLI 的纯部分：归一化、渲染、入参解析。**不起进程、不 process.exit。**
//
// 为什么跟入口分开：`lint-cli.ts` 末尾是 `process.exit(main())`，
// 测试一 import 它就整个退出（实测 "process.exit unexpectedly called with 1"）。
// Phase 1 在 `index.ts` 上栽过同一下，办法也一样：入口只装配，逻辑单列可测。

import type { Finding } from './lint.js';

/** 归一化成 `rule:severity:subject`，供 --parity 与老脚本对账。 */
export const normalize = (fs: Finding[]): string[] =>
  [...new Set(fs.map((f) => `${f.rule}:${f.severity}:${f.subject}`))].sort();

export function render(fs: Finding[]): string {
  const out: string[] = [];
  const hard = fs.filter((f) => f.severity === 'hard');
  const warn = fs.filter((f) => f.severity === 'warn');
  for (const f of warn) out.push(`  ⚠ ${f.message}`);
  for (const f of hard) out.push(`  ✗ ${f.message}`);
  if (hard.length === 0) out.push('  ✓ 体例合格。');
  else out.push('', '体例不合格 —— 按上面的 ✗ 修完再呈。');
  return out.join('\n');
}

export interface Args {
  worktree: string;
  ref?: string;
  base?: string;
  bodyFile?: string;
  json: boolean;
  parity: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { worktree: '.', json: false, parity: false };
  let seenPositional = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--json') out.json = true;
    else if (a === '--parity') out.parity = true;
    else if (a === '--ref') out.ref = argv[(i += 1)];
    else if (a === '--base') out.base = argv[(i += 1)];
    else if (a === '--body-file') out.bodyFile = argv[(i += 1)];
    else if (a.startsWith('--')) throw new Error(`不认识的参数：${a}`);
    else if (!seenPositional) {
      out.worktree = a;
      seenPositional = true;
    } else throw new Error(`多余的参数：${a}（工作树只能给一个）`);
  }
  return out;
}

