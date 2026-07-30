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
let cachedWriteClient: Octokit | null = null;

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

// —— 写入侧（Phase 3）——
//
// R7 从「绝对只读」精确成「不写远端」是 Phase 1 的事；Phase 3 第一次真往远端写。
// **只读闸门不拆**：读实例照旧一个非 GET 都发不出去。写走一个**独立实例**，
// 挂一道更严的闸 —— 白名单里逐字对得上的 route 模板才放行，其余（含 GET）一律拒。
//
// 为什么比对 route **模板**而不是展开后的 URL：hook 拿到的 options.url 就是模板
// （实测 `POST /repos/{owner}/{repo}/pulls`，占位符还没展开），而模板是我们自己代码里的
// 字面量常量，调用方塞不进去。展开后的 URL 反而带真实参数，比对要写正则，
// 而正则是这个项目反复栽跟头的地方。
//
// 逐字匹配顺带挡住一个真实的逃逸：Octokit 的 `{+param}` **不做 URL 编码**
// （实测 `{+repo}` 传 `r/pulls/1/merge` 会原样拼进路径，逃到 merge 端点；
// 普通 `{repo}` 会编码成 `r%2Fpulls%2F1%2Fmerge`）。`{+repo}` 的模板与白名单里的
// `{repo}` 逐字不等 → 直接被拒。这是 fail-closed 的方向。
export const WRITE_ALLOWED: readonly string[] = [
  'POST /repos/{owner}/{repo}/pulls',
  'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
  'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
];

/**
 * 写实例的闸门：白名单外一律拒，**GET 也拒**。
 *
 * 拒 GET 是刻意的：读有 get()，它带分页护栏和 404 消歧。让写实例也能读，
 * 等于开出第二条没有护栏的读路径 —— 而「同一件事两个实现」正是这个项目反复反对的。
 *
 * 导出是为了可测：测试会起本地 server 验证白名单外的东西真的发不出去。
 */
export function installWriteGate(oc: Octokit, allow: readonly string[] = WRITE_ALLOWED): Octokit {
  const set = new Set(allow);
  oc.hook.wrap('request', async (request, options) => {
    const method = String(options.method ?? '').toUpperCase();
    const url = String(options.url ?? '');
    if (!set.has(`${method} ${url}`)) {
      throw new Error(`zhupi-mcp 的写入白名单里没有这一条，拦下了：${method} ${url}`);
    }
    return request(options);
  });
  return oc;
}

/**
 * 测试接缝。第二轮评审的唯一高危是「get() 零覆盖」—— 六条关键行为只活在那个函数里，
 * 而测试把它整个 mock 掉了。没有这个接缝，get()/write() 只能对着真 github.com 测，
 * 也就是压根测不了；写入侧再重复一遍那个错误，代价比读侧高得多。
 * 与 snapshot.ts 的 ZHUPI_GIT_MAXBUFFER 同一个理由：不开接缝的测试是恒绿的。
 */
const baseUrlOpt = (): { baseUrl?: string } => {
  const b = process.env.ZHUPI_GITHUB_BASEURL;
  return b ? { baseUrl: b } : {};
};

/** 实例绝不导出——外面拿不到它，就没法绕开上面那道 hook。 */
async function client(force = false): Promise<Octokit> {
  if (!force && cachedClient) return cachedClient;
  cachedClient = installReadOnlyGate(new Octokit({ auth: await authToken(force), ...baseUrlOpt() }));
  return cachedClient;
}

/** 写实例与读实例**分开缓存**：混用一个实例就只能挂一道闸，两边必然有一边被放松。 */
async function writeClient(force = false): Promise<Octokit> {
  if (!force && cachedWriteClient) return cachedWriteClient;
  cachedWriteClient = installWriteGate(new Octokit({ auth: await authToken(force), ...baseUrlOpt() }));
  return cachedWriteClient;
}

export function resetAuthCache(): void {
  cachedToken = null;
  cachedClient = null;
  cachedWriteClient = null;
}

/** 这些 key 会覆盖 Octokit 解析出来的动词与地址，一律不许调用方传。 */
// headers 也剔掉：X-HTTP-Method-Override: DELETE 会原样上线（第三轮评审在本地 server 收到了）。
// api.github.com 据信不认这个头，但我们不用自定义 header，剔掉零成本。
const FORBIDDEN_PARAM_KEYS = ['method', 'url', 'baseUrl', 'request', 'headers'] as const;

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

// undici（v21 底层）的措辞与 node:http 时代不同：连接中途被断是 "other side closed"，
// 真正的 UND_ERR_SOCKET 藏在 cause 链第二层。评审用真 socket reset 打穿过 v2 的判定。
const NETWORKISH =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|fetch failed|socket hang up|other side closed|terminated|network/i;
const NET_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'];

/** 沿 cause 链往下找，不只看一层。 */
function chain(e: unknown, depth = 4): unknown[] {
  const out: unknown[] = [];
  let cur = e;
  for (let i = 0; i < depth && cur != null; i += 1) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

function isNetworkish(e: unknown): boolean {
  for (const link of chain(e)) {
    const code = String((link as { code?: string } | null)?.code ?? '');
    if (NET_CODES.includes(code)) return true;
    if (NETWORKISH.test(String((link as Error)?.message ?? ''))) return true;
  }
  return false;
}

function isRateLimited(e: unknown): number | null {
  if (statusOf(e) !== 403 && statusOf(e) !== 429) return null;
  const h = ((e as { response?: { headers?: Record<string, string> } }).response?.headers ?? {}) as Record<string, string>;
  if (h['retry-after']) return Number(h['retry-after']) || 0;
  if (h['x-ratelimit-remaining'] === '0') {
    const reset = Number(h['x-ratelimit-reset']);
    return Number.isFinite(reset) ? Math.max(0, Math.round(reset - Date.now() / 1000)) : 0;
  }
  // secondary rate limit：403，x-ratelimit-remaining 非 0，**唯一信号在 body message**。
  // 不看它就会落到「403 → 认证失效 → 去 gh auth login」，而重登对限流毫无帮助（评审实证）。
  const msg = `${String((e as Error)?.message ?? '')} ${String(
    (e as { response?: { data?: { message?: string } } }).response?.data?.message ?? '',
  )}`;
  if (/secondary rate limit|abuse detection|rate limit/i.test(msg)) return 0;
  return null;
}

/**
 * 异常 → 分类。**抽成纯函数是为了可测**：
 * 第二轮评审的唯一高危是「get() 零覆盖」——六条关键行为只活在那个函数里，
 * 而它被测试整个 mock 掉。评审用探针在里面现场打穿了两条声称已修的分类
 * （socket reset 报「没预料到」、secondary rate limit 报「去登录」）。
 * 没测的必然结果。
 */
export function classify(e: unknown, opts: { notFound?: ZhupiError } = {}): ZhupiError {
  if (isNetworkish(e)) return { kind: 'network', reason: String((e as Error).message ?? e) };
  const retry = isRateLimited(e);
  if (retry !== null) return { kind: 'rateLimit', retryAfterSec: retry || undefined };
  const st = statusOf(e);
  if (st === 404) return opts.notFound ?? { kind: 'repo', repo: '' };
  if (st === 401 || st === 403) return { kind: 'auth', why: 'expired' };
  return { kind: 'unknown', detail: String((e as Error).message ?? e) };
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
      return fail(classify(e, { notFound: opts.notFound }));
    }
  }
  return fail({ kind: 'auth', why: 'expired' });
}

export interface WriteOptions {
  /** 404 时归为什么。不给则默认「仓读不到」。 */
  notFound?: ZhupiError;
}

/**
 * 写远端。**只有 WRITE_ALLOWED 里的三条路由走得通。**
 *
 * 两道闸门都要过：这里的字面量检查（给一句能照着修的话）+ hook 里的实例级检查
 * （绕不过去的那道）。前者可以被改坏，后者不行 —— 所以后者才是执行机制，
 * 前者只是把错误信息说人话。
 *
 * **只重试 401，不重试网络错误。** 401 是服务端明确拒绝、没有副作用，重试安全；
 * 而网络中断时请求可能已经到了 GitHub —— 重试一个 POST /pulls 就是开出第二折。
 * get() 那边重试网络错误是无害的，这一侧不是，别照抄。
 */
export async function write<T = unknown>(
  route: string,
  params: Record<string, unknown>,
  opts: WriteOptions = {},
): Promise<T> {
  if (!WRITE_ALLOWED.includes(route)) {
    return fail({ kind: 'badInput', what: `route 不在写入白名单里：${route}` });
  }
  const safe = sanitizeParams(params);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const oc = await writeClient(attempt > 0);
      const res = await oc.request(route, safe);
      return res.data as T;
    } catch (e) {
      if (isFailure(e)) throw e;
      if (statusOf(e) === 401 && attempt === 0) {
        resetAuthCache();
        continue;
      }
      return fail(classify(e, { notFound: opts.notFound }));
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
