// 唯一碰网络的模块。
//
// R7「绝对只读」的执行机制在这里，不在文本扫描里。第一轮代码评审用本地 server 实证了
// 两件事，v1 的两道「闸门」都是假的：
//   ① octokit.request('GET /x', { method: 'POST' }) **真的会发 POST** ——
//      Octokit 的 endpoint merge 是 Object.assign({method,url}, options)，options 覆盖 method。
//      所以「route 必须以 GET 开头」这句话是错的安全感，决定动词的是 params。
//   ② 文本守卫扫的是字面量 `octokit.`，而本文件真实写法是 `oc.request(route, params)` ——
//      规则对本项目唯一的网络调用一次都没生效过。
// v2 的做法：Octokit 实例封在模块闭包里绝不外泄，并在 hook 里断言最终 method === 'GET'。
// 那是运行时的、绕不过去的闸门；文本扫描降级为辅助提示。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/rest';
import { fail, isFailure, type ZhupiError } from './errors.js';

const run = promisify(execFile);

let cachedToken: string | null = null;
let cachedClient: Octokit | null = null;

export async function authToken(force = false): Promise<string> {
  if (!force && cachedToken) return cachedToken;
  try {
    const { stdout } = await run('gh', ['auth', 'token'], { timeout: 10_000 });
    const t = stdout.trim();
    if (!t) return fail({ kind: 'auth', why: 'missing' });
    cachedToken = t;
    cachedClient = null;
    return t;
  } catch (e) {
    if (isFailure(e)) throw e;
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') return fail({ kind: 'auth', why: 'noGh' });
    if ((e as { killed?: boolean }).killed) return fail({ kind: 'auth', why: 'ghTimeout' });
    return fail({ kind: 'auth', why: 'missing' });
  }
}

/**
 * 运行时闸门：无论 route 怎么写、params 怎么塞，最终发出去的必须是 GET。
 * 导出是为了可测——测试会起一个本地 server 验证非 GET 真的发不出去。
 */
export function installReadOnlyGate(oc: Octokit): Octokit {
  oc.hook.wrap('request', async (request, options) => {
    const method = String(options.method ?? '').toUpperCase();
    if (method !== 'GET') {
      throw new Error(`zhupi-mcp 是只读的，拦下了一个 ${method} 请求：${String(options.url)}`);
    }
    return request(options);
  });
  return oc;
}

/** 实例绝不导出——外面拿不到它，就没法绕开上面那道 hook。 */
async function client(force = false): Promise<Octokit> {
  if (!force && cachedClient) return cachedClient;
  cachedClient = installReadOnlyGate(new Octokit({ auth: await authToken(force) }));
  return cachedClient;
}

export function resetAuthCache(): void {
  cachedToken = null;
  cachedClient = null;
}

/** 这些 key 会覆盖 Octokit 解析出来的动词与地址，一律不许调用方传。 */
const FORBIDDEN_PARAM_KEYS = ['method', 'url', 'baseUrl', 'request'] as const;

export function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if ((FORBIDDEN_PARAM_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// Octokit v21 走 fetch：网络失败被包成 RequestError(message, 500)，**不带 code 字段**。
// v1 查 e.code 恒为 false，network 这一支从来没被走到过（评审实证）。
const statusOf = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;

const NETWORKISH = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i;

function isNetworkish(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code ?? '';
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) return true;
  const msg = String((e as Error)?.message ?? '');
  return statusOf(e) === 500 && NETWORKISH.test(msg);
}

function isRateLimited(e: unknown): number | null {
  if (statusOf(e) !== 403 && statusOf(e) !== 429) return null;
  const h = ((e as { response?: { headers?: Record<string, string> } }).response?.headers ?? {}) as Record<string, string>;
  if (h['retry-after']) return Number(h['retry-after']) || 0;
  if (h['x-ratelimit-remaining'] === '0') {
    const reset = Number(h['x-ratelimit-reset']);
    return Number.isFinite(reset) ? Math.max(0, Math.round(reset - Date.now() / 1000)) : 0;
  }
  return null;
}

export interface GetOptions {
  /** 404 时归为什么。不给则默认「仓读不到」——未知上下文时那才是安全默认。 */
  notFound?: ZhupiError;
  /** 分页护栏。必填：v1 漏传了 reviews 那一次，而 reviews 是作者判定的唯一数据源。 */
  pageGuard: ZhupiError;
}

export async function get<T = unknown>(
  route: string,
  params: Record<string, unknown>,
  opts: GetOptions,
): Promise<T> {
  if (!route.startsWith('GET ')) {
    return fail({ kind: 'badInput', what: `route 必须以 GET 开头：${route}` });
  }
  const safe = sanitizeParams(params);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const oc = await client(attempt > 0);
      const res = await oc.request(route, safe);
      const link = String((res.headers as Record<string, unknown>).link ?? '');
      if (/rel="next"/.test(link)) return fail(opts.pageGuard);
      return res.data as T;
    } catch (e) {
      // 自己抛的分类错误直接放行——v1 在这里把它重新包成「没预料到的问题」，
      // 结果全新装机最常见的失败路径（gh 没装/没登录）返回的是一句废话（评审实证）。
      if (isFailure(e)) throw e;
      if (statusOf(e) === 401 && attempt === 0) {
        resetAuthCache();
        continue;
      }
      if (isNetworkish(e)) return fail({ kind: 'network', reason: String((e as Error).message ?? e) });
      const retry = isRateLimited(e);
      if (retry !== null) return fail({ kind: 'rateLimit', retryAfterSec: retry || undefined });
      if (statusOf(e) === 404) return fail(opts.notFound ?? { kind: 'repo', repo: '' });
      if (statusOf(e) === 401) return fail({ kind: 'auth', why: 'expired' });
      if (statusOf(e) === 403) return fail({ kind: 'auth', why: 'expired' });
      return fail({ kind: 'unknown', detail: String((e as Error).message ?? e) });
    }
  }
  return fail({ kind: 'auth', why: 'expired' });
}

/**
 * 仓存在且当前账号读得到吗——只用于 404 消歧。
 * **只吞 notFound/repo 两类**：v1 裸 catch 吞掉一切，网络抖动会被报成「权限问题」，
 * 正是 design §6 要防的「把人指反」，只是方向换了一个（评审实证）。
 */
export async function repoReadable(owner: string, repo: string): Promise<boolean> {
  try {
    await get('GET /repos/{owner}/{repo}', { owner, repo }, {
      pageGuard: { kind: 'unknown', detail: 'repo probe 不该分页' },
      notFound: { kind: 'repo', repo: `${owner}/${repo}` },
    });
    return true;
  } catch (e) {
    if (isFailure(e) && (e.info.kind === 'repo' || e.info.kind === 'notFound')) return false;
    throw e;
  }
}
