#!/usr/bin/env node
// 命令行渲染器：findings → ✓/✗/⚠ 文本 + 退出码 0/1。
//
// **原本是给 `open-folder.sh` 用的**（2026-07-30 Phase 4 起那个脚本已退休，
// 存档在 `retired/`）。留着它是因为它现在是**人**手查体例的入口：
//   node dist/lint-cli.js <工作树> [--ref origin/<分支>]
// agent 那一侧走 `lint_folder`，两个口共用 `lint.ts` 同一个纯核（需求 R7）。
//
// 为什么不让 shell 直接调 MCP（设计 §0）：shell **能**调 stdio MCP（3 个 printf 就行，
// v1 说不能是错的），但一道闸门不该跑两套协议，也不该在 shell 里渲染 JSON。
// 这是渲染器，不是第三个平级入口 —— 规则一条都不在这里。
// 纯部分（归一化 / 渲染 / 入参解析）在 `lint-render.ts` —— 这个文件末尾是 process.exit，
// 一被 import 就退出，所以逻辑不能留在这儿（Phase 1 在 index.ts 上栽过同一下）。
//
//   lint-cli.js [worktree] [--ref <ref>] [--base <ref>] [--body-file <f>] [--json] [--parity]
//
// 退出码：0 = 合体例（可能有警告），1 = 有硬伤，2 = 跑不起来（不是工作树等）。
// **2 与 1 要分开**：调用方拿 1 当「修完再来」，而 2 是「这个工具本身有问题」，
// 两者混在一起会让环境故障看起来像体例问题。

import { execFileSync } from 'node:child_process';
import { lint, hasHard, type Finding } from './lint.js';
import { collect, dirtyDocs, NotAGitWorktree } from './snapshot.js';
import { normalize, parseArgs, render, type Args } from './lint-render.js';

function main(): number {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${String((e as Error).message)}\n`);
    return 2;
  }

  let body: string | undefined;
  if (args.bodyFile !== undefined) {
    // 不 import fs（guard.ts 焊死了）—— 用 cat 子进程读。
    try {
      body = execFileSync('cat', [args.bodyFile], { encoding: 'utf8' });
    } catch {
      process.stderr.write(`读不到 body 文件：${args.bodyFile}\n`);
      return 2;
    }
  }

  let findings: Finding[];
  try {
    findings = lint(
      collect({
        worktree: args.worktree,
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
        ...(args.base !== undefined ? { base: args.base } : {}),
        ...(body !== undefined ? { body } : {}),
      }),
    );
  } catch (e) {
    process.stderr.write(`${e instanceof NotAGitWorktree ? e.message : `lint 跑不起来：${String((e as Error).message)}`}\n`);
    return 2;
  }

  if (args.parity) {
    // 对账只吐归一化后的集合，一行一条 —— 让调用方能直接 diff。
    process.stdout.write(`${normalize(findings).join('\n')}\n`);
    return hasHard(findings) ? 1 : 0;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ findings, ok: !hasHard(findings) }, null, 2)}\n`);
    return hasHard(findings) ? 1 : 0;
  }

  // 提醒未提交的改动：snapshot 读的是提交过的内容，老脚本读工作树。
  // 正常流程里两者相同（commit+push 之后才呈折），不同的时候必须说出来，
  // 否则「我改了它却没看见」会被当成 lint 坏了。
  const dirty = dirtyDocs(args.worktree);
  if (dirty.length > 0) {
    process.stdout.write(`  ⚠ docs 下有未提交的改动，本次检查的是**已提交**的内容：${dirty.join(' ')}\n`);
  }
  process.stdout.write(`${render(findings)}\n`);
  return hasHard(findings) ? 1 : 0;
}

process.exit(main());
