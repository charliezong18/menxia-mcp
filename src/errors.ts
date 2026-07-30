// 失败 → 一句人和模型都读得懂、且能照着修的话（requirements R6）。
//
// 吃判别式联合而不是裸 Error：分类必须发生在知道上下文的地方（github.ts / folders.ts），
// 不能靠这里去猜一个 Error 对象是什么意思。

export type ZhupiError =
  | { kind: 'auth'; why?: 'missing' | 'expired' | 'noGh' | 'ghTimeout' }
  | { kind: 'rateLimit'; retryAfterSec?: number }
  | { kind: 'repo'; repo: string }
  | { kind: 'notFound'; repo: string; pr: number }
  | { kind: 'network'; reason: string }
  | { kind: 'badInput'; what: string }
  | { kind: 'tooManyComments'; repo: string; pr: number }
  | { kind: 'tooManyFolders'; repo: string }
  | { kind: 'locked'; waitedMs: number; heldBy?: number }
  | { kind: 'worktree'; what: string; hint?: string }
  | { kind: 'unknown'; detail: string };

// —— 脱敏 ——
// 教训（第一轮代码评审）：v1 只在 brief() 里脱敏，而 repo/notFound 这些模板是裸插值；
// 正则还大小写敏感，且 `authorization\s*\S+` 只吃掉 scheme 那个词、吃不到后面的秘密。
// 所以 v2 把脱敏挪到**唯一出口**：messageFor 返回前整体过一遍。
const TOKEN_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/gi,
  /github_pat_[A-Za-z0-9_]{20,}/gi,
  /\b[0-9a-f]{40}\b/gi,
  // authorization 头：**吃到行尾**。只吃一个 \S+ 的话，
  // "Authorization: Basic <base64>" 只会吃掉 "Basic"，秘密原样留着（自测抓到）。
  /\b(proxy-)?authorization\b\s*[:=]\s*.*/gi,
  // 裸的 scheme + 凭据
  /\b(bearer|basic|token)\s+\S+/gi,
];

export function redact(s: string): string {
  return TOKEN_PATTERNS.reduce((acc, re) => acc.replace(re, '[已脱敏]'), s);
}

/** 只取第一行且截断：stack trace 不进用户可见文本。 */
function brief(detail: string | undefined, max = 160): string {
  if (!detail) return '';
  const line = String(detail).split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function raw(e: ZhupiError): string {
  switch (e.kind) {
    case 'auth':
      switch (e.why) {
        case 'noGh':
          return '找不到 `gh` 命令。先装 GitHub CLI（brew install gh），再 `gh auth login`。';
        case 'ghTimeout':
          return '`gh auth token` 十秒没响应。检查 gh 是否卡住（`gh auth status`）后重试。';
        case 'expired':
          return 'GitHub 认证被拒。跑 `gh auth login` 重新登录后重试。';
        default:
          return '拿不到 GitHub 认证。跑 `gh auth login` 后重试。';
      }
    case 'rateLimit':
      return `被 GitHub 限流了${e.retryAfterSec ? `，约 ${e.retryAfterSec} 秒后恢复` : ''}。` +
        '等一会儿再试——这不是认证问题，重新登录没用。';
    case 'repo':
      return `读不到 ${e.repo}。确认仓名对（环境变量 ZHUPI_REVIEW_REPO）、且当前 gh 账号有权限。`;
    case 'notFound':
      return `${e.repo} 里没有 #${e.pr}。用 list_folders 看现有折号。`;
    case 'network': {
      const why = brief(e.reason);
      return `连不上 github.com${why ? `：${why}` : ''}。网络恢复后重试。`;
    }
    case 'badInput':
      return `入参不对：${brief(e.what)}`;
    case 'tooManyComments':
      return `${e.repo} #${e.pr} 的批注超过一页（100 条），本阶段不做分页。` +
        '宁可明着失败也不静默少数——截断会把回话与根批注分到两页，回话变孤儿，凭空多出未回。';
    case 'tooManyFolders':
      return `${e.repo} 的折超过一页（100 个），本阶段不做分页。宁可明着失败也不静默少数。`;
    case 'locked':
      // 明着说「另一个会话在呈折」，别让调用方以为是自己写错了。
      // 挂死才是最糟的形态：SPEC §4.2 要的就是「知道是在排队」而不是「不知道发生了什么」。
      return `等了 ${Math.round(e.waitedMs / 1000)} 秒还没拿到奏折仓的锁` +
        `${e.heldBy ? `（被进程 ${e.heldBy} 占着）` : ''}。多半是另一个会话正在呈折，` +
        '等它完事再试。锁在 ~/.zhupi-mcp/review.lock，确认没有别的会话在跑的话可以删掉它。';
    case 'worktree':
      return `呈折没能建起来：${brief(e.what)}${e.hint ? `\n${e.hint}` : ''}`;
    case 'unknown':
      return `出了点没预料到的问题：${brief(e.detail)}`;
  }
}

/**
 * 唯一出口。所有对外文本都从这里出去，脱敏在这里统一做一次。
 * 兜底 `?? ''`：raw() 的 switch 若漏了某个 kind（新增分支时很容易），
 * 返回 undefined 会让 redact 直接崩——把「少一句话」放大成「工具挂掉」。
 * 编译期有穷尽性检查，这一层防的是运行时收到意外 kind。
 */
export const messageFor = (e: ZhupiError): string =>
  redact(raw(e) ?? `出了点没预料到的问题（未知错误类型 ${String((e as { kind?: string }).kind)}）`);

export class ZhupiFailure extends Error {
  readonly info: ZhupiError;
  constructor(info: ZhupiError) {
    super(messageFor(info));
    this.name = 'ZhupiFailure';
    this.info = info;
  }
}

export const isFailure = (e: unknown): e is ZhupiFailure => e instanceof ZhupiFailure;

export const fail = (info: ZhupiError): never => {
  throw new ZhupiFailure(info);
};
