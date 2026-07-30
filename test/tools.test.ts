import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleTool, parseIds } from '../src/tools.js';

// handleTool 那层原本零覆盖，而第一轮评审四条高危全在这层：
// seed 静默胜出 ids、字符串 id 静默 no-op、alreadyHandled 对没记进去的 id 说谎、
// 不存在的 id 照单落盘。这里只测**网络之前**就该拒的路径，所以不打 GitHub。

const boom = (name: string, args: Record<string, unknown>) => handleTool(name, args);

describe('parseIds：字符串 id 必须硬拒，不能静默变 no-op', () => {
  it('正常数组通过', () => expect(parseIds([1, 2])).toEqual([1, 2]));

  it('字符串 id → 报错并回显收到了什么', async () => {
    expect(() => parseIds(['5113864010'])).toThrow(/正整数.*5113864010/s);
  });

  it('挡掉 0 / 负数 / 浮点 / NaN / null / 布尔', () => {
    for (const bad of [[0], [-5], [1.5], [NaN], [null], [true], [{}], [[1]]]) {
      expect(() => parseIds(bad), JSON.stringify(bad)).toThrow(/正整数/);
    }
  });

  it('空数组和非数组都报错，且提示 seed 这条路', () => {
    for (const bad of [[], undefined, null, 'x', 5, {}]) {
      expect(() => parseIds(bad), JSON.stringify(bad)).toThrow(/要给 ids/);
    }
  });

  it('**一个非法元素就整个拒**，不是过滤后带着剩下的往下走', () => {
    expect(() => parseIds([1, '2', 3])).toThrow(/正整数/);
  });
});

describe('mark_handled 的入参闸门（都在网络调用之前）', () => {
  it('seed 与 ids 同时给 → 拒。v1 是 seed 静默胜出、整折被标掉', async () => {
    await expect(boom('mark_handled', { pr: 18, ids: [1], seed: true })).rejects.toThrow(/只能给一个/);
  });

  it('不给 pr → 拒', async () => {
    await expect(boom('mark_handled', { ids: [1] })).rejects.toThrow(/必须给 pr/);
  });

  it('pr 写成字符串 / 数组 / 布尔 → 拒', async () => {
    for (const bad of ['3', [3], true, 1.5, 0, -1, 1e21]) {
      await expect(boom('mark_handled', { pr: bad, ids: [1] }), JSON.stringify(bad)).rejects.toThrow(/pr 得是正整数/);
    }
  });

  it('既不给 ids 也不给 seed → 拒，且提示 seed', async () => {
    await expect(boom('mark_handled', { pr: 18 })).rejects.toThrow(/要给 ids.*seed/s);
  });

  it('字符串 id 在打 GitHub 之前就被拒（不是拉完数据才发现）', async () => {
    await expect(boom('mark_handled', { pr: 18, ids: ['1'] })).rejects.toThrow(/正整数/);
  });

  it('未知入参被拒，不静默忽略', async () => {
    await expect(boom('mark_handled', { pr: 18, ids: [1], force: true })).rejects.toThrow(/只认.*force/s);
  });
});

describe('其他工具的入参闸门', () => {
  it('read_comments 传 number 而不是 pr → 报错并给出正确写法', async () => {
    // MCP SDK 不按 inputSchema 校验，additionalProperties:false 形同虚设；
    // 而 number 是最自然的猜法（list_folders 返回里那个字段就叫 number）。
    await expect(boom('read_comments', { number: 17 })).rejects.toThrow(/\{ pr: 17 \}/);
  });

  it('list_folders 的 state 只认 open / merged，报错里回显 JSON 而不是 String()', async () => {
    await expect(boom('list_folders', { state: 'merged-ish' })).rejects.toThrow(/"merged-ish"/);
    // String(['open']) === 'open'，用 String() 会报「只能是 open，收到 open」，模型会死循环重试
    await expect(boom('list_folders', { state: ['open'] })).rejects.toThrow(/\["open"\]/);
  });

  it('不存在的工具名 → 一句能照着改的话', async () => {
    await expect(boom('mark_read', { pr: 1 })).rejects.toThrow(/没有叫 mark_read 的工具/);
  });
});

// ── 行为层（第二轮评审：这层原本 7 个变异存活，因为只有联网的 acceptance 护着）──
// 用注入的取数口离线测，`npm test` 就能跑。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from '../src/processed.js';

describe('mark_handled 的行为（离线，注入取数口）', () => {
  const HIS = { id: 100, updatedAt: '2026-07-29T10:00:00Z', preview: '文档是不是有点旧了。', fromDesk: true, answered: 'pending' };
  const MINE = { id: 200, updatedAt: '2026-07-29T11:00:00Z', preview: '## v2 已呈 —— 逐条回', fromDesk: false, answered: 'pending' };
  let dir: string, prev: string | undefined;
  let calls: number;
  const deps = { entries: async () => { calls += 1; return [HIS, MINE] as never; } };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhupi-tools-'));
    prev = process.env.ZHUPI_STATE_FILE;
    process.env.ZHUPI_STATE_FILE = join(dir, 'p.json');
    calls = 0;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ZHUPI_STATE_FILE; else process.env.ZHUPI_STATE_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  const T = (args: Record<string, unknown>) => handleTool('mark_handled', args, deps) as Promise<any>;
  const stored = () => load(process.env.ZHUPI_STATE_FILE!).store['9'] ?? {};

  it('标一条 → 落盘，added 如实', async () => {
    expect((await T({ pr: 9, ids: [100] })).added).toEqual([100]);
    expect(Object.keys(stored())).toEqual(['100']);
  });

  it('重复标 → alreadyHandled，added 空', async () => {
    await T({ pr: 9, ids: [100] });
    const r = await T({ pr: 9, ids: [100] });
    expect([r.added, r.refreshed, r.alreadyHandled]).toEqual([[], [], [100]]);
  });

  it('**refreshed 不能被说成 alreadyHandled** —— 那是「他改过我又确认了」', async () => {
    await T({ pr: 9, ids: [100] });
    const r = await handleTool('mark_handled', { pr: 9, ids: [100] },
      { entries: async () => [{ ...HIS, updatedAt: '2026-07-29T20:00:00Z' }] as never }) as any;
    expect(r.refreshed).toEqual([100]);
    expect(r.alreadyHandled).toEqual([]);
  });

  it('**added + refreshed + alreadyHandled 恒等于去重后的 ids**', async () => {
    for (const ids of [[100], [100, 200], [100, 100, 200]]) {
      const r = await T({ pr: 9, ids });
      const sum = r.added.length + r.refreshed.length + r.alreadyHandled.length;
      expect(sum, JSON.stringify(ids)).toBe(new Set(ids).size);
      // 同一条 id 不许在输出里出现两次
      expect(r.alreadyHandled.length, JSON.stringify(ids)).toBe(new Set(r.alreadyHandled).size);
    }
  });

  it('seed 不带 confirm：**一个字节都不写**', async () => {
    const r = await T({ pr: 9, seed: true });
    expect(r.dryRun).toBe(true);
    expect(r.wouldMark).toBe(2);
    expect(load(process.env.ZHUPI_STATE_FILE!).store).toEqual({});
  });

  it('seed 预览里带正文，且**他的朱批要有警告**（标掉等于让他的话消失）', async () => {
    const r = await T({ pr: 9, seed: true });
    expect(r.targets.map((t: any) => t.preview)).toContain('文档是不是有点旧了。');
    expect(r.hint).toMatch(/他的朱批/);
  });

  it('**没有 fromDesk 时也要警告** —— 那条路径生产里 0/16 折触发过，只在它为真时警告等于没护栏', async () => {
    const r = await handleTool('mark_handled', { pr: 9, seed: true },
      { entries: async () => [MINE] as never }) as any;
    expect(r.hint).toMatch(/⚠️/);
    expect(r.hint).toMatch(/作者 API 分不出来/);
    expect(r.hint).toMatch(/confirm: 1/);
  });

  it('**confirm 必须报出 dry-run 看到的条数**，写 true 不算', async () => {
    // 第三轮评审用 `{seed:true, confirm:true}` 一次调用吞掉了他在 #2 上的 4 条真话。
    // 「两步」必须是闸门，不能是自愿。
    await expect(T({ pr: 9, seed: true, confirm: true })).rejects.toThrow(/整数/);
    expect(load(process.env.ZHUPI_STATE_FILE!).store).toEqual({});
  });

  it('confirm 条数不对 → 拒（说明没看过预览，或预览之后又有新话）', async () => {
    await expect(T({ pr: 9, seed: true, confirm: 1 })).rejects.toThrow(/confirm: 2/);
    await expect(T({ pr: 9, seed: true, confirm: 5 })).rejects.toThrow(/confirm: 2/);
    expect(load(process.env.ZHUPI_STATE_FILE!).store).toEqual({});
  });

  it('confirm 条数对上 → 才落盘', async () => {
    const dry = await T({ pr: 9, seed: true });
    const r = await T({ pr: 9, seed: true, confirm: dry.wouldMark });
    expect(r.seeded).toBe(true);
    expect(Object.keys(stored()).sort()).toEqual(['100', '200']);
  });

  it('dry-run 之后又来了新总批 → 旧的 confirm 数字失效，不会顺手把新话标掉', async () => {
    const dry = await T({ pr: 9, seed: true });   // wouldMark = 2
    const withNew = { entries: async () => [HIS, MINE, { ...HIS, id: 300, preview: '你把第 3 点搞错了' }] as never };
    await expect(handleTool('mark_handled', { pr: 9, seed: true, confirm: dry.wouldMark }, withNew))
      .rejects.toThrow(/confirm: 3/);
  });

  it('**seed + undo → 拒**。上一版会照 seed 走，把整折标掉', async () => {
    await expect(T({ pr: 9, seed: true, undo: true })).rejects.toThrow(/反方向/);
    expect(load(process.env.ZHUPI_STATE_FILE!).store).toEqual({});
  });

  it('confirm 不跟 seed 一起给 → 拒（免得以为「加了 confirm 就稳」）', async () => {
    await expect(T({ pr: 9, ids: [100], confirm: 1 })).rejects.toThrow(/只跟 seed/);
  });

  it('undo 撤得掉，且**不白花一次网络**', async () => {
    await T({ pr: 9, ids: [100] });
    const before = calls;
    const r = await T({ pr: 9, ids: [100], undo: true });
    expect(r.removed).toEqual([100]);
    expect(calls).toBe(before);
    expect(Object.keys(stored())).toEqual([]);
  });

  it('undo 没记过的 → 如实报 notRecorded，不假装成功', async () => {
    const r = await T({ pr: 9, ids: [100], undo: true });
    expect([r.removed, r.notRecorded]).toEqual([[], [100]]);
  });

  it('不属于这折的 id → 拒，并告诉去哪拿 id', async () => {
    await expect(T({ pr: 9, ids: [999] })).rejects.toThrow(/没有这些总批.*conversation\[\]\.id/s);
    expect(load(process.env.ZHUPI_STATE_FILE!).store).toEqual({});
  });

  it('**入参非法时一次网络都不打**（fail-fast，不是拉完才发现）', async () => {
    for (const bad of [{ pr: 9, ids: ['x'] }, { pr: 9, ids: [] }, { pr: 9, ids: [1], seed: true }, { pr: 0, ids: [1] }]) {
      await expect(T(bad), JSON.stringify(bad)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
});
