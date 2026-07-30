// PARITY.md 的解析。纯函数，不碰 IO。
//
// **它已经不再决定任何事了。**「连续 10 次呈折零分歧就删掉 folder-lint.sh」这条判据
// 2026-07-30 晚被换掉（三头都断：样本没判别力 / 被当权威的老脚本本身有假通过 bug /
// 呈折搬进 MCP 之后计数冻死）。新判据在 `scripts/retire-gate.mjs`。
//
// 所以 `canRetire` 和 `RETIRE_AT` 一并删了 —— 一个叫 canRetire 的字段在它不再决定
// 退休之后还留着，正是这个项目反复反对的「又造一个会漂的副本」：
// 下一个人读到它会以为那还是判据。
//
// 留下来的部分仍有用：台账是历史记录，而「结果文本不认识 → 台账被手工编辑过」
// 这条完整性检查值得继续跑。
//
// 第一轮评审在上一版（内联在 print-parity.mjs 里）抓到：
// 判据是「第 4 格含『一致』且不含『不一致』」，于是 `SKIP_LINT 跳过（其余与上次一致）`
// 这种行会被**计入连续数** —— 唯一绝对不该计数的行型，是最容易被计进去的。
// 现在改成对 parity_row 真正会写的几个字面量做**全等匹配**，其余一律
// 「不认识 → 中断连续并报警」。

/** open-folder.sh 的 parity_row 只会写这几种结果，逐字对齐。 */
export const AGREE = '退出码一致';
export const DISAGREE = '**不一致**';
/** 这些是「不计入连续，也不算分歧」—— 环境故障与人为跳过，不是规则差异。 */
export const NEUTRAL = ['新 lint 未成功（不计入）', '新 lint 未构建（不计入）', '呈折中止（不计入）'];
export const SKIPPED = 'SKIP_LINT 跳过';

export interface Row {
  at: string;
  folder: string;
  old: string;
  neu: string;
  result: string;
}

export interface Summary {
  rows: Row[];
  /** 从最近一行往前数的连续「退出码一致」。中性行**中断**它 —— 见 why。 */
  streak: number;
  disagreements: number;
  skipped: number;
  /** 结果文本不在已知集合里的行。台账被手工编辑过就会出现，必须报出来。 */
  unknown: Row[];
}

export function parseRows(text: string): Row[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}/.test(l))
    .map((l) => {
      const c = l.split('|').slice(1, -1).map((x) => x.trim());
      return { at: c[0] ?? '', folder: c[1] ?? '', old: c[2] ?? '', neu: c[3] ?? '', result: c[4] ?? '' };
    });
}

export function summarize(text: string): Summary {
  const rows = parseRows(text);
  const unknown = rows.filter((r) => r.result !== AGREE && r.result !== DISAGREE && r.result !== SKIPPED && !NEUTRAL.includes(r.result));

  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    // **只有逐字等于 AGREE 才算。** 中性行和 SKIP_LINT 都中断连续 ——
    // 中断的方向是保守的：宁可少数几次，也不要在闸门被关过的窗口里做不可逆决定。
    if (rows[i]!.result === AGREE) streak += 1;
    else break;
  }

  return {
    rows,
    streak,
    disagreements: rows.filter((r) => r.result === DISAGREE).length,
    skipped: rows.filter((r) => r.result === SKIPPED).length,
    unknown,
  };
}
