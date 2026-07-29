// 唯一碰网络的模块。只导出 GET。
//
// 认证：借机器上已有的 gh 认证，不另管一份会过期的 PAT（requirements R5）。
// 懒取——server 在每个 Claude Code 会话都会起，启动时取会让「装上但没用到」的会话
// 也依赖 gh 可用。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/rest';
import { fail, type ZhupiError } from './errors.js';

const run = promisify(execFile);

let cachedToken: string | null = null;
let cachedClient: Octokit | null = null;

export async function authToken(force = false): Promise<string> {
  if (!force && cachedToken) return cachedToken;
  try {
    const { stdout } = await run('gh', ['auth', 'token'], { timeout: 10_000 });
    const t = stdout.trim();
    if (!t) fail({ kind: 'auth' });
    cachedToken = t;
    cachedClient = null;
    return t;
  } catch {
    return fail({ kind: 'auth' });
  }
}

async function client(force = false): Promise<Octokit> {
  if (!force && cachedClient) return cachedClient;
  cachedClient = new Octokit({ auth: await authToken(force) });
  return cachedClient;
}

/** 测试用：清掉进程内缓存。 */
export function resetAuthCache(): void {
  cachedToken = null;
  cachedClient = null;
}

const isNetworkish = (e: unknown): boolean => {
  const code = (e as { code?: string } | null)?.code ?? '';
  return ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code);
};

const statusOf = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;

export interface GetOptions {
  /** 404 时用来区分「仓读不到」和「折号不存在」 */
  notFound?: ZhupiError;
  /** 分页护栏：出现下一页即报错，不静默截断 */
  pageGuard?: ZhupiError;
}

/**
 * 唯一的网络出口。route 必须以 GET 开头——守卫测试会检查这一点。
 * 401 时清缓存重取一次（防的是「另一个 session 期间重新登录过」，
 * 不是 OAuth 刷新：gh auth token 读的是本地已存凭据，通常返回同一个 token）。
 */
export async function get<T = unknown>(
  route: string,
  params: Record<string, unknown> = {},
  opts: GetOptions = {},
): Promise<T> {
  if (!route.startsWith('GET ')) {
    return fail({ kind: 'badInput', what: `route 必须以 GET 开头：${route}` });
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const oc = await client(attempt > 0);
      const res = await oc.request(route, params);
      if (opts.pageGuard && /rel="next"/.test(String((res.headers as Record<string, unknown>).link ?? ''))) {
        return fail(opts.pageGuard);
      }
      return res.data as T;
    } catch (e) {
      if (statusOf(e) === 401 && attempt === 0) {
        resetAuthCache();
        continue;
      }
      if (isNetworkish(e)) return fail({ kind: 'network', reason: String((e as Error).message ?? e) });
      // 404 一律先抛成 notFound，由调用方决定是「仓读不到」还是「折号不存在」——
      // GitHub 对这两种（外加「无权限的私有仓」）返回的都是 404。
      if (statusOf(e) === 404) return fail(opts.notFound ?? { kind: 'notFound', repo: '', pr: 0 });
      if (statusOf(e) === 401 || statusOf(e) === 403) return fail({ kind: 'auth' });
      return fail({ kind: 'unknown', detail: String((e as Error).message ?? e) });
    }
  }
  return fail({ kind: 'auth' });
}

/** 仓存在且当前账号读得到吗——用于 404 消歧。 */
export async function repoReadable(owner: string, repo: string): Promise<boolean> {
  try {
    await get('GET /repos/{owner}/{repo}', { owner, repo });
    return true;
  } catch {
    return false;
  }
}
