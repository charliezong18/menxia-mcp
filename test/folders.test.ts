import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZhupiFailure } from '../src/errors.js';

// folders.ts 在第一轮代码评审时是**零测试**，而 404 消歧与「一折坏不能拖垮全仓」
// 都是关键路径。这里用 mock 掉 github.ts 的方式补上。

const get = vi.fn();
const repoReadable = vi.fn();
vi.mock('../src/github.js', () => ({
  get: (...a: unknown[]) => get(...a),
  repoReadable: (...a: unknown[]) => repoReadable(...a),
}));

const { readFolder, readAll, summarize, isFolderError } = await import('../src/folders.js');
const REF = { owner: 'o', repo: 'r', slug: 'o/r' };

const pull = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n, title: `折 ${n}`, head: { ref: `b${n}`, sha: `sha${n}` }, merged_at: null, ...extra,
});

/** 按 route 派发的 mock。 */
function routeMock(handlers: Record<string, unknown | (() => unknown)>) {
  get.mockImplementation(async (route: string, params: Record<string, unknown>) => {
    for (const [frag, val] of Object.entries(handlers)) {
      if (route.includes(frag)) {
        const v = typeof val === 'function' ? (val as () => unknown)() : val;
        if (v instanceof Error) throw v;
        return typeof v === 'object' && v !== null && '__byPr' in v
          ? (v as Record<string, unknown>)[String(params.pull_number ?? params.issue_number)] ?? []
          : v;
      }
    }
    return [];
  });
}

beforeEach(() => {
  get.mockReset();
  repoReadable.mockReset();
});

describe('404 消歧（design §6）', () => {
  it('仓读得到 → 归为「折号不存在」，指向 list_folders', async () => {
    get.mockRejectedValue(new ZhupiFailure({ kind: 'notFound', repo: 'o/r', pr: 999 }));
    repoReadable.mockResolvedValue(true);
    await expect(readFolder(999, REF)).rejects.toThrow(/没有 #999/);
    await expect(readFolder(999, REF)).rejects.not.toThrow(/权限/);
  });

  it('仓读不到 → 归为「仓读不到」，提到权限与环境变量', async () => {
    get.mockRejectedValue(new ZhupiFailure({ kind: 'notFound', repo: 'o/r', pr: 999 }));
    repoReadable.mockResolvedValue(false);
    await expect(readFolder(999, REF)).rejects.toThrow(/读不到 o\/r/);
  });

  it('探仓这一步自己抛（网络断了）→ 原样抛出，不误报成权限问题', async () => {
    // v1 的 repoReadable 裸 catch 吞掉一切返回 false，网络抖动会被报成「确认仓名对、有权限」。
    get.mockRejectedValue(new ZhupiFailure({ kind: 'notFound', repo: 'o/r', pr: 5 }));
    repoReadable.mockRejectedValue(new ZhupiFailure({ kind: 'network', reason: 'ENOTFOUND' }));
    await expect(readFolder(5, REF)).rejects.toThrow(/连不上 github\.com/);
  });

  it('非 404 的错误不进消歧，原样冒泡', async () => {
    get.mockRejectedValue(new ZhupiFailure({ kind: 'auth', why: 'noGh' }));
    await expect(readFolder(1, REF)).rejects.toThrow(/装 GitHub CLI/);
    expect(repoReadable).not.toHaveBeenCalled();
  });
});

describe('一折坏不能拖垮全仓（评审的高危）', () => {
  it('一折的 comments 抛错 → 那折降级成 error 占位，其余照常返回', async () => {
    const pulls = [pull(1), pull(2), pull(3)];
    get.mockImplementation(async (route: string, params: Record<string, unknown>) => {
      if (route.endsWith('/pulls')) return pulls;
      if (String(params.pull_number ?? params.issue_number) === '2' && route.includes('/comments')) {
        throw new ZhupiFailure({ kind: 'tooManyComments', repo: 'o/r', pr: 2 });
      }
      return [];
    });
    const out = await readAll('open', REF);
    expect(out).toHaveLength(3);
    const broken = out.filter(isFolderError);
    expect(broken).toHaveLength(1);
    expect(broken[0]!.number).toBe(2);
    expect(broken[0]!.error).toMatch(/超过一页/);
    // 关键：另外两折仍然可用
    expect(out.filter((f) => !isFolderError(f))).toHaveLength(2);
  });

  it('坏折在 summarize 之后仍然可辨认', async () => {
    const bad = { number: 9, title: 't', headRefName: 'b', error: '炸了' };
    expect(isFolderError(summarize(bad))).toBe(true);
  });
});

describe('state=merged 的过滤（评审：#10 是打回关闭不是钦此）', () => {
  it('取 closed 之后按 merged_at 过滤', async () => {
    const closed = [pull(10, { merged_at: null }), pull(19, { merged_at: '2026-07-29T00:00:00Z' })];
    get.mockImplementation(async (route: string) => (route.endsWith('/pulls') ? closed : []));
    const out = await readAll('merged', REF);
    expect(out.map((f) => f.number)).toEqual([19]);
  });

  it('open 不做过滤', async () => {
    get.mockImplementation(async (route: string) => (route.endsWith('/pulls') ? [pull(1), pull(2)] : []));
    expect((await readAll('open', REF)).map((f) => f.number)).toEqual([1, 2]);
  });

  it('一条折都没有 → 空列表不报错', async () => {
    routeMock({ '/pulls': [] });
    expect(await readAll('open', REF)).toEqual([]);
  });
});

describe('每次取数都带页护栏（评审：v1 漏了 reviews，而它是作者判定的唯一来源）', () => {
  it('comments / reviews / issue-comments 三次调用全部传了 pageGuard', async () => {
    get.mockImplementation(async (route: string) => (route.endsWith('/pulls') ? [pull(1)] : []));
    await readAll('open', REF);
    const calls = get.mock.calls.filter(([r]) => /comments|reviews/.test(String(r)));
    expect(calls.length).toBe(3);
    for (const [route, , opts] of calls) {
      expect((opts as { pageGuard?: unknown })?.pageGuard, `${route} 没传 pageGuard`).toBeTruthy();
    }
  });
});
