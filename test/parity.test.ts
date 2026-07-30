import { describe, it, expect } from 'vitest';
import { AGREE, DISAGREE, NEUTRAL, SKIPPED, parseRows, summarize } from '../src/parity.js';

// 这个解析器支撑一个**不可逆决定**：连续 10 次零分歧就删掉 folder-lint.sh。
// 第一轮评审在上一版（逻辑内联在 print-parity.mjs 里、零测试）抓到两个错结论。

const row = (result: string, at = '2026-07-30T08:00Z', folder = '#40') => `| ${at} | ${folder} | 0 | 0 | ${result} |`;
const table = (...results: string[]) => ['| 时间 | 折 | 旧 | 新 | 结果 |', '|---|---|---|---|---|', ...results.map((r) => row(r))].join('\n');

describe('连续计数', () => {
  it('全一致 → 数满', () => {
    expect(summarize(table(...Array(10).fill(AGREE))).streak).toBe(10);
  });

  it('从最近往前数，早期的不一致不影响', () => {
    expect(summarize(table(DISAGREE, AGREE, AGREE)).streak).toBe(2);
  });

  it('**SKIP_LINT 行中断连续** —— 唯一绝不该计数的行型，上一版最容易被计进去', () => {
    expect(summarize(table(...Array(9).fill(AGREE), SKIPPED)).streak).toBe(0);
  });

  it('**带备注的 SKIP_LINT 行也中断** —— 上一版靠子串「一致」判，会把它算成一致', () => {
    const s = summarize(table(...Array(9).fill(AGREE), 'SKIP_LINT 跳过（其余与上次一致）'));
    expect(s.streak).toBe(0);
    expect(s.unknown).toHaveLength(1);
  });

  it('「**不一致**」里含「一致」子串，绝不能被当成一致', () => {
    expect(summarize(table(AGREE, DISAGREE)).streak).toBe(0);
  });

  it('中性行（环境故障 / 呈折中止）中断连续，但不算分歧', () => {
    for (const n of NEUTRAL) {
      const s = summarize(table(...Array(9).fill(AGREE), n));
      expect(s.streak, n).toBe(0);
      expect(s.disagreements, n).toBe(0);
      expect(s.unknown, n).toEqual([]);
    }
  });
});

// ── 「退休判据」那一组整组删了（2026-07-30 晚）──
//
// 它测的是 `canRetire` / `RETIRE_AT`，而那条判据（连续 10 次呈折零分歧）已经作废：
// ① 样本没判别力（88% 的折两边都零硬伤）② 被当权威的老脚本本身有假通过 bug
// ③ 呈折搬进 MCP 之后计数冻死。新判据在 `scripts/retire-gate.mjs`，
// 用「每条规则一个必失败样本」，九条逐条做过变异全部变红。
//
// **删掉而不是留着改绿**：一组仍在断言「满 10 次就能删闸门」的测试，
// 会让下一个人以为那还是判据 —— 那正是这个项目反复反对的「会漂的副本」。
// 「未知行让台账不可信」这条守卫没丢，它并进了上面那组（第 23 条用例）。

describe('解析健壮性', () => {
  it('空表 / 只有表头 → 零行零连续', () => {
    expect(summarize('').rows).toEqual([]);
    expect(summarize('| 时间 | 折 | 旧 | 新 | 结果 |\n|---|---|---|---|---|').streak).toBe(0);
  });

  it('CRLF 换行也认', () => {
    expect(summarize(table(AGREE, AGREE).replace(/\n/g, '\r\n')).streak).toBe(2);
  });

  it('散文行（说明文字、分隔线）不被当数据', () => {
    const text = `# 台账\n\n退休条件：连续 10 次…\n\n${table(AGREE)}`;
    expect(summarize(text).rows).toHaveLength(1);
  });

  it('折号和时间被解出来 —— 事后要能辨认是哪一折', () => {
    const [r] = parseRows(row(AGREE, '2026-08-01T09:30Z', '#42'));
    expect([r.at, r.folder, r.result]).toEqual(['2026-08-01T09:30Z', '#42', AGREE]);
  });

  it('列数不足的残行不崩', () => {
    expect(() => summarize('| 2026-07-30T08:00Z |')).not.toThrow();
  });
});
