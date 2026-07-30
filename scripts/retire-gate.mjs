#!/usr/bin/env node
// 「能不能删 folder-lint.sh」的闸门。
//
// ── 它替代了什么 ──
//
// 老判据（design D1，2026-07-30 上午 Charlie 拍板）：**连续 10 次呈折零分歧**。
// 同日三头都断了，每一条都独立成立：
//
//   ① 样本没有判别力 —— 88% 的折两边都零硬伤，凑满 10 次证明的是「两个都没炸」，
//      不是「难的地方判得一样」。（D10，#34 提过。）
//   ② 被当权威的那一方本身是坏的 —— `folder-lint.sh:58` 的 `${ZH}（` 是 bash
//      未绑定变量，`set -u` 下让子 shell 当场死掉，**整个脚本打印「体例合格」并 exit 0**。
//      「缺中文版」这一整类从闸门上线起就没拦住过。而 D1 明写「以老的为准」。
//   ③ 计数被冻死 —— Phase 3 的 `open_folder` 不跑老 bash lint，走 MCP 呈的折
//      一行都不记。停在 2/10 且不会再动。
//
// 新判据（2026-07-30 晚 Charlie 拍板）：**每条规则各一个必失败样本都过了就准删。**
//
// ── 为什么这个判据是可信的 ──
//
// 它测的是**新实现真的在拦**，而不是「两个实现碰巧都没说话」。
// 规则被删掉、被改坏、被降级成 warn —— 对应的样本立刻不再触发，闸门当场红。
// 也就是说这个闸门自带变异抗性：不需要另跑一遍变异战役来证明它有牙。
//
// `lint.ts` 是**纯函数**（吃 Snapshot 吐 findings，无 IO），所以样本全是内联的，
// 不建 git 仓、不打网络、跑完不到一秒。Phase 2 把它做成纯函数就是为了今天这件事。

import { lint } from '../dist/lint.js';

const EN_HEAD = (s) => `**English** · [中文](${s}.zh-CN.md)`;
const ZH_HEAD = (s) => `[English](${s}.md) · **中文**`;

/** 一个各方面都合格的折。每个样本从它出发只坏一处 —— 否则分不清是哪条规则在响。 */
function clean() {
  const slug = 'demo';
  return {
    files: new Map([
      [`docs/${slug}.md`, `${EN_HEAD(slug)}\n\n# Demo\n\nPlain English prose for the ratio rule.\n`],
      [`docs/${slug}.zh-CN.md`, `${ZH_HEAD(slug)}\n\n# 演示\n\n这是中文正文，用来满足语言方向那条规则。\n`],
    ]),
    changed: [`docs/${slug}.md`, `docs/${slug}.zh-CN.md`],
    assets: new Set(),
    payload: [],
    monolingual: [],
    onMain: new Set(),
    base: { behind: 0, fetchFailed: false },
    body: '## 目的地\nx\n\n## 直达链\nx\n\n## TLDR\nx\n\n## 待你拍板\nx\n\n## 怎么用\nx\n',
  };
}

/**
 * 九条规则，每条一个**必失败样本**。
 *
 * `severity` 写的是这条规则该报的严重度 —— 一并断言，因为「hard 悄悄降成 warn」
 * 是这个项目栽过的形状（呈折闸门放行了本该拦的东西，而测试只查「有没有 finding」）。
 */
const CASES = [
  {
    rule: 1,
    severity: 'hard',
    what: '双语对不齐（有英文版，没中文对子）',
    break: (s) => {
      s.files.delete('docs/demo.zh-CN.md');
      s.changed = ['docs/demo.md'];
    },
  },
  {
    rule: 2,
    severity: 'hard',
    what: '互链头点不到对面',
    break: (s) => {
      // 正文保持英文 —— 只坏互链头这一处。写成中文会把规则 5 也带响，
      // 那样就分不清是哪条在响了（第一次跑就踩到，闸门自己报的「样本不够纯」）。
      s.files.set('docs/demo.md', '# Demo\n\nNo interlink header on the first line.\n');
    },
  },
  {
    rule: 3,
    severity: 'hard',
    what: '.payload 登记的待发正文，中文版缺「不要从本页复制」横幅',
    break: (s) => {
      s.payload = ['docs/demo.md'];
      // 登记成 payload 之后英文版免互链头，但中文版必须带横幅 —— 这里故意不带
      s.files.set('docs/demo.md', '# Demo\n\nOutbound draft body.\n');
    },
  },
  {
    rule: 4,
    severity: 'hard',
    what: '断图（正文引用的图不在仓里）',
    break: (s) => {
      s.files.set('docs/demo.md', `${EN_HEAD('demo')}\n\n# Demo\n\n![shot](assets/shots/missing.png)\n`);
    },
  },
  {
    rule: 5,
    severity: 'warn',
    what: '语言方向反了（英文版里全是中文）',
    break: (s) => {
      s.files.set('docs/demo.md', `${EN_HEAD('demo')}\n\n# 演示\n\n这一篇放在英文槽里，但整篇都是中文，一个英文单词都没有。\n`);
    },
  },
  {
    rule: 6,
    severity: 'warn',
    what: '分支基点落后于 main',
    break: (s) => {
      s.base = { behind: 7, fetchFailed: false };
    },
  },
  {
    rule: 7,
    severity: 'warn',
    what: '改动了已经在 main 上的文档（可能从别的未合分支切的）',
    break: (s) => {
      s.onMain = new Set(['docs/demo.md']);
    },
  },
  {
    rule: 8,
    severity: 'warn',
    what: 'PR body 缺「待你拍板」段',
    break: (s) => {
      s.body = s.body.replace('## 待你拍板\nx\n\n', '');
    },
  },
  {
    rule: 9,
    severity: 'warn',
    what: 'git fetch 失败（后面所有关于 main 的结论都可能建在陈旧数据上）',
    break: (s) => {
      s.base = { behind: 0, fetchFailed: true };
    },
  },
];

/** 单语读物豁免（D9）。它不是「一条规则」，是规则 1 的例外，单独钉一次。 */
const EXEMPTIONS = [
  {
    name: '.monolingual 登记的单语读物免双语对（D9）',
    build: () => {
      const s = clean();
      s.files.delete('docs/demo.zh-CN.md');
      s.changed = ['docs/demo.md'];
      // 登记项是相对仓根的整行路径，不是 slug —— 照抄 `.payload` 的机制（lint.ts:190）。
      // 第一次跑这个闸门时我这里写的是 'demo'，闸门当场判红：抓到的是我自己的样本错。
      s.monolingual = ['docs/demo.md'];
      return s;
    },
    expectNoRule: 1,
  },
];

let bad = 0;
const rows = [];

// ① 干净样本：一条硬伤都不该有。这一条先跑 —— 它要是红了，下面所有「必失败」都不可信
//    （分不清是规则在响还是底样本本来就脏）。
const baseline = lint(clean());
const baseHard = baseline.filter((f) => f.severity === 'hard');
if (baseHard.length > 0) {
  console.error('✗ 干净样本本身就有硬伤，下面的结论全部作废：');
  for (const f of baseHard) console.error(`    [规则 ${f.rule}] ${f.subject}：${f.message}`);
  process.exit(2);
}

// ② 每条规则的必失败样本
for (const c of CASES) {
  const snap = clean();
  c.break(snap);
  const got = lint(snap).filter((f) => f.rule === c.rule);
  const hit = got.length > 0;
  const sev = hit && got.every((f) => f.severity === c.severity);
  // 只坏一处，所以其余规则不该被带响 —— 带响说明样本不干净，结论就不能只归给这条规则
  const others = [...new Set(lint(snap).filter((f) => f.rule !== c.rule).map((f) => f.rule))];
  const ok = hit && sev;
  if (!ok) bad += 1;
  rows.push({
    rule: c.rule,
    ok,
    sev: hit ? [...new Set(got.map((f) => f.severity))].join('/') : '—',
    want: c.severity,
    what: c.what,
    others,
  });
}

// ③ 例外也要钉：例外失效 = 规则 1 把 22 章中文读物全拦死（#31 的形状）
for (const e of EXEMPTIONS) {
  const got = lint(e.build()).filter((f) => f.rule === e.expectNoRule);
  const ok = got.length === 0;
  if (!ok) bad += 1;
  rows.push({ rule: `${e.expectNoRule}′`, ok, sev: '—', want: '不该报', what: e.name, others: [] });
}

console.log('\n── 退休闸门：每条规则一个必失败样本 ──');
console.log('   判据（2026-07-30 Charlie 拍板，取代 D1「连续 10 次」）：');
console.log('   九条规则各自的必失败样本都真的被新实现拦下，才准删 folder-lint.sh\n');
for (const r of rows) {
  const mark = r.ok ? '✓' : '✗';
  const sev = r.ok ? r.want : `实为 ${r.sev}，应为 ${r.want}`;
  const noise = r.others.length ? `  （顺带响了规则 ${r.others.join('/')}，样本不够纯）` : '';
  console.log(`   ${mark} 规则 ${String(r.rule).padEnd(3)} ${String(sev).padEnd(10)} ${r.what}${noise}`);
}

if (bad === 0) {
  console.log(`\n   ${rows.length}/${rows.length} 全过 —— **可以删 folder-lint.sh**（Phase 4）\n`);
} else {
  console.log(`\n   ${rows.length - bad}/${rows.length} 过，${bad} 条没过 —— **不许删 folder-lint.sh**\n`);
}
process.exit(bad === 0 ? 0 : 1);
