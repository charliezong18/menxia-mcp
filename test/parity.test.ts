import { describe, it, expect } from 'vitest';
import { AGREE, DISAGREE, NEUTRAL, RETIRE_AT, SKIPPED, parseRows, summarize } from '../src/parity.js';

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
    expect(s.canRetire).toBe(false);
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

describe('退休判据', () => {
  it(`满 ${RETIRE_AT} 且无未知行 → 可退休`, () => {
    expect(summarize(table(...Array(RETIRE_AT).fill(AGREE))).canRetire).toBe(true);
  });

  it(`差一次 → 不可退休`, () => {
    expect(summarize(table(...Array(RETIRE_AT - 1).fill(AGREE))).canRetire).toBe(false);
  });

  it('**台账里有不认识的结果文本 → 一律不许退休**（被手工编辑过，计数不可信）', () => {
    const rows = [...Array(RETIRE_AT).fill(AGREE)];
    const s = summarize(`${table(...rows)}\n${row('看起来没问题')}`);
    expect(s.unknown).toHaveLength(1);
    expect(s.canRetire).toBe(false);
  });
});

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
