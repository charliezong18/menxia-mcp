#!/usr/bin/env node
// 触发器：每跑 `npm test` 都打印当前连续一致次数。
//
// 为什么要有它（design §5）：退休条件是「连续 10 次零分歧」，而**记账没有触发器就等于
// 靠散文记得** —— 这个项目量过散文漏执行率 37.5%。
// 状态从 PARITY.md 解析，**不硬编码** —— 硬编码等于又造一个会漂的副本
// （print-milestones.mjs 的注释就是为这条立的）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(dirname(fileURLToPath(import.meta.url))), 'PARITY.md');
let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  process.exit(0); // 还没建就别吵
}

const rows = text.split('\n')
  .filter((l) => /^\|\s*\d{4}-/.test(l))
  .map((l) => l.split('|').map((c) => c.trim()).filter(Boolean));

if (rows.length === 0) {
  console.log('\n── lint 对账 ── 还没有记录。退休条件：连续 10 次呈折零分歧才能删 folder-lint.sh。');
  process.exit(0);
}

let streak = 0;
for (let i = rows.length - 1; i >= 0; i -= 1) {
  const result = rows[i][3] ?? '';
  if (result.includes('一致') && !result.includes('不一致')) streak += 1;
  else break;
}
const skips = rows.filter((r) => (r[3] ?? '').includes('SKIP_LINT')).length;
const disagreements = rows.filter((r) => (r[3] ?? '').includes('不一致')).length;

console.log(`\n── lint 对账（PARITY.md，共 ${rows.length} 条）──`);
console.log(`   连续一致 ${streak}/10${streak >= 10 ? ' —— **可以删 folder-lint.sh 了**（design D1）' : ''}`);
if (disagreements > 0) console.log(`   ⚠ 历史上 ${disagreements} 次不一致 —— 跑 npm run differential 看差在哪`);
if (skips > 0) console.log(`   ⚠ ${skips} 次 SKIP_LINT 跳过了体例检查`);
