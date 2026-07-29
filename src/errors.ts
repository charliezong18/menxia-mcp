// 失败 → 一句人和模型都读得懂、且能照着修的话（requirements R6）。
//
// 吃的是判别式联合而不是裸 Error：分类必须发生在知道上下文的地方（github.ts），
// 不能靠这里去猜一个 Error 对象是什么意思。双 review 指出 v1 把分类这一半留白了，
// 结果就是 404 一律被归成「仓读不到」，而折号敲错的人会被指去查权限——正好反向。

export type ZhupiError =
  | { kind: 'auth'; detail?: string }
  | { kind: 'repo'; repo: string; detail?: string }
  | { kind: 'notFound'; repo: string; pr: number }
  | { kind: 'network'; reason: string }
  | { kind: 'badInput'; what: string }
  | { kind: 'tooMany'; repo: string; pr: number }
  | { kind: 'unknown'; detail: string };

// token 绝不能进错误文本。detail 往往来自上游异常，可能夹带凭据。
const TOKEN_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\b[0-9a-f]{40}\b/g, // 旧式 40 位 hex token
  /Bearer\s+\S+/gi,
  /authorization["'\s:=]+\S+/gi,
];

export function redact(s: string): string {
  return TOKEN_PATTERNS.reduce((acc, re) => acc.replace(re, '[已脱敏]'), s);
}

// 只取第一行且截断：stack trace 不进用户可见文本。
function brief(detail: string | undefined, max = 160): string {
  if (!detail) return '';
  const line = redact(String(detail)).split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function messageFor(e: ZhupiError): string {
  switch (e.kind) {
    case 'auth':
      return '拿不到 GitHub 认证。跑 `gh auth login` 后重试。';
    case 'repo':
      return `读不到 ${e.repo}。确认仓名对、且当前 gh 账号有权限。`;
    case 'notFound':
      return `${e.repo} 里没有 #${e.pr}。用 list_folders 看现有折号。`;
    case 'network': {
      const why = brief(e.reason);
      return `连不上 github.com${why ? `：${why}` : ''}。网络恢复后重试。`;
    }
    case 'badInput':
      return `入参不对：${brief(e.what)}`;
    case 'tooMany':
      return `${e.repo} #${e.pr} 的批注超过一页（100 条），本阶段不做分页。` +
        '宁可明着失败也不静默少数——截断会把回话与根批注分到两页，回话变孤儿，凭空多出未回。';
    case 'unknown':
      return `出了点没预料到的问题：${brief(e.detail)}`;
  }
}

export class ZhupiFailure extends Error {
  readonly info: ZhupiError;
  constructor(info: ZhupiError) {
    super(messageFor(info));
    this.name = 'ZhupiFailure';
    this.info = info;
  }
}

export const fail = (info: ZhupiError): never => {
  throw new ZhupiFailure(info);
};
