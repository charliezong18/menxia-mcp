#!/usr/bin/env node
// 触发器：每跑 `npm test` 都打印当前连续一致次数。
//
// 为什么要有它（design §5）：退休条件是「连续 10 次零分歧」，而**记账没有触发器就等于
// 靠散文记得** —— 这个项目量过散文漏执行率 37.5%。
// 解析逻辑在 src/parity.ts（纯函数、有单测）——它支撑一个不可逆决定，不能只活在脚本里。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRE_AT, summarize } from '../dist/parity.js';

const file = join(dirname(dirname(fileURLToPath(import.meta.url))), 'PARITY.md');
let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  process.exit(0);
}

const s = summarize(text);
console.log(`\n── lint 对账（PARITY.md，共 ${s.rows.length} 条）──`);
if (s.rows.length === 0) {
  console.log(`   还没有记录。退休条件：连续 ${RETIRE_AT} 次呈折零分歧才能删 folder-lint.sh。`);
} else {
  console.log(`   连续一致 ${s.streak}/${RETIRE_AT}${s.canRetire ? ' —— **可以删 folder-lint.sh 了**（design D1）' : ''}`);
  if (s.disagreements > 0) console.log(`   ⚠ 历史上 ${s.disagreements} 次不一致 —— 跑 npm run differential 看差在哪`);
  if (s.skipped > 0) console.log(`   ⚠ ${s.skipped} 次 SKIP_LINT 跳过了体例检查（这些行中断连续计数）`);
  if (s.unknown.length > 0) {
    console.log(`   ⚠ ${s.unknown.length} 行结果文本不认识（台账被手工编辑过？）—— **连续计数不可信，不许据此退休**`);
    for (const r of s.unknown.slice(0, 3)) console.log(`     · ${r.at} ${r.result}`);
  }
}
