#!/usr/bin/env node
// 触发器：每跑 `npm test` 都把台账现状打出来。
//
// **这张表已经不决定退休了**（2026-07-30 晚换判据，见 PARITY.md 顶部与
// `scripts/retire-gate.mjs`）。留着打印是因为它仍是历史记录，而且
// 「结果文本不认识 = 台账被手工编辑过」这条完整性检查值得继续跑。
//
// 记账要有触发器这条道理不变：这个项目量过散文漏执行率 37.5%。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../dist/parity.js';

const file = join(dirname(dirname(fileURLToPath(import.meta.url))), 'PARITY.md');
let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  process.exit(0);
}

const s = summarize(text);
console.log(`\n── lint 对账（PARITY.md，共 ${s.rows.length} 条 · 已停用，留作史料）──`);
if (s.rows.length === 0) {
  console.log('   还没有记录。');
} else {
  console.log(`   连续一致 ${s.streak}（**不再是退休判据** —— 那条 2026-07-30 换了，见下面的退休闸门）`);
  if (s.disagreements > 0) console.log(`   ⚠ 历史上 ${s.disagreements} 次不一致 —— 跑 npm run differential 看差在哪`);
  if (s.skipped > 0) console.log(`   ⚠ ${s.skipped} 次 SKIP_LINT 跳过了体例检查（这些行中断连续计数）`);
  if (s.unknown.length > 0) {
    console.log(`   ⚠ ${s.unknown.length} 行结果文本不认识（台账被手工编辑过？）—— **连续计数不可信，不许据此退休**`);
    for (const r of s.unknown.slice(0, 3)) console.log(`     · ${r.at} ${r.result}`);
  }
}
