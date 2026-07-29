#!/usr/bin/env node
// MILESTONES 的触发器。
//
// MILESTONES 自己写着：「这份文件现在没有触发器，是已知欠账；等 Phase 1 落代码时
// 触发器随之装上——测试脚本打印本表的状态行，每跑一次都被迫看见。」
// 这就是那笔账。zhupi 的台账曾经停摆 7 个 commit，复盘结论是「病根不是忘了，
// 是记账没有触发器」。所以状态从文件里解析，不硬编码——硬编码等于又造一个会漂的副本。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const md = readFileSync(join(root, 'MILESTONES.zh-CN.md'), 'utf8');
  const rows = md
    .split('\n')
    .filter((l) => /^\|\s*\*\*\d/.test(l))
    .map((l) => l.split('|').map((c) => c.trim()).filter(Boolean))
    .filter((c) => c.length >= 3);

  if (rows.length === 0) {
    console.log('\n⚠️  MILESTONES 里没解析到阶段行——表格结构变了，触发器已失效，去修它。');
    process.exit(0);
  }

  console.log('\n── MILESTONES ──');
  for (const [phase, , status] of rows) {
    const done = /✅/.test(phase) || /✅/.test(status ?? '');
    console.log(`  ${done ? '✅' : '⬜'} ${phase.replace(/\*\*/g, '')}  ${status ?? ''}`);
  }
  const pending = rows.filter(([p, , s]) => !/✅/.test(p) && !/✅/.test(s ?? '')).length;
  console.log(`  —— ${rows.length - pending}/${rows.length} 阶段完成。「未开始」原样没动 = 没核实过，不是确实准确。\n`);
} catch (e) {
  console.log(`\n⚠️  读不到 MILESTONES：${e.message}\n`);
}
