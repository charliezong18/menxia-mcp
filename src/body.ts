// 五段 body 的组装、「回奏对」标记的焊入、以及建完折之后的回读自核。
//
// 为什么焊死而不是提醒：标记这一步以前是「开完 PR 再记得 append 一行」，
// **八折漏了三折**（#11 #16 #17）—— 全是漏执行，不是 bug。文档写了照样能跳过，
// 所以把它焊进创建动作本身（SPEC §3.1）。
//
// 这个文件**不 import fs**：body 是个字符串，直接交给 Octokit。
// 老脚本落临时文件只是因为 `gh pr create --body-file` 要一个路径 —— 换了 API
// 那个理由就没了，顺手进 fs 白名单等于白送一个写口。

import { get } from './github.js';
import type { RepoRef } from './config.js';

export interface FolderBody {
  /** merge 后交付到哪。 */
  destination: string;
  /** 渲染版链接等。不给就不出这一段（并警告）。 */
  directLink?: string;
  tldr: string;
  /** 待你拍板 —— 缺了他就不知道要拍什么。 */
  decisions: string;
  howto: string;
}

/** 段名与顺序与现有折逐字一致（对着 #34 #35 的真 body 核过）。 */
const SECTIONS: Array<[keyof FolderBody, string]> = [
  ['destination', '目的地'],
  ['directLink', '直达链'],
  ['tldr', 'TLDR'],
  ['decisions', '待你拍板'],
  ['howto', '怎么用'],
];

export const MARKER_RE = /<!--\s*happy-session:\s*([A-Za-z0-9_-]+)\s*-->/;

export interface BuiltBody {
  text: string;
  /**
   * 缺了哪几段。**这里只报事实，不组织成警告文案** ——
   * `lint.ts` 规则 8 已经在查同一件事（按标题匹配，与老脚本的 `grep -q` 对齐过）。
   * 两边都往 warnings 里塞一句的话，同一个缺段在工具输出里出现两次，
   * 读的人会以为有两个问题。呈折路径上以规则 8 为准，这个字段留给独立调用方。
   *
   * 缺段**只警告不拦** —— SPEC §5.3 #6：文档和脚本注释都写「拦」，是假的，照代码来。
   */
  missing: string[];
  /** 真正要播报的：标记没埋上。这一条 lint 查不了（它不知道有没有会话 id）。 */
  warnings: string[];
}

export function buildBody(b: FolderBody, sessionId: string | null): BuiltBody {
  const warnings: string[] = [];
  const missing: string[] = [];
  const parts: string[] = [];

  for (const [key, title] of SECTIONS) {
    const v = (b[key] ?? '').trim();
    if (!v) {
      missing.push(title);
      continue;
    }
    parts.push(`## ${title}\n\n${v}`);
  }

  let text = parts.join('\n\n');
  if (sessionId) {
    text += `\n\n<!-- happy-session: ${sessionId} -->\n`;
  } else {
    // 探不到就不埋，**绝不编**（SPEC §4.4）。按钮不出现而已；静默指错比没有更糟。
    warnings.push('拿不到 happy 会话 id，本折不埋「回奏对」标记 —— 朱批台上不会有回奏对按钮');
  }
  return { text, missing, warnings };
}

export interface MarkerCheck {
  ok: boolean;
  /** 回读本身失败了（网络等）。**这不等于标记没落上**，两者要分开报。 */
  unverified: boolean;
  message?: string;
}

/**
 * 回读自核：标记真的落进线上 body 了才算数。
 *
 * 为什么需要：`gh` 有过静默吞 body 的先例（老脚本 open-folder.sh:141 就在做这件事）。
 * 换成 Octokit 之后这条**没有失效** —— 会不会吞是服务端的事，不是客户端的事。
 *
 * **回读失败照样返回，不抛。** PR 已经建了，因为核不了就把整个调用判成失败，
 * 会让调用方以为折没建成而重开一折 —— 那比不核更糟（SPEC §3.1 图里的橙色分支）。
 */
export async function verifyMarker(repo: RepoRef, pr: number, sessionId: string | null): Promise<MarkerCheck> {
  if (!sessionId) return { ok: true, unverified: false };
  let body: string;
  try {
    const data = await get<{ body?: string | null }>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner: repo.owner, repo: repo.repo, pull_number: pr },
      { pageGuard: { kind: 'unknown', detail: '单折详情不该分页' }, notFound: { kind: 'notFound', repo: repo.slug, pr } },
    );
    body = data.body ?? '';
  } catch (e) {
    return {
      ok: false,
      unverified: true,
      message: `折已经建好了，但回读核不了标记：${String((e as Error)?.message ?? e)}。折是好的，标记待确认。`,
    };
  }
  const found = MARKER_RE.exec(body)?.[1];
  if (found === sessionId) return { ok: true, unverified: false };
  return {
    ok: false,
    unverified: false,
    message: found
      ? `body 里的会话 id 是 ${found}，不是本次的 ${sessionId} —— 回奏对按钮会把你送进别的会话。`
      : `标记没落进 #${pr} 的 body。补：gh pr edit ${pr} -R ${repo.slug} --body-file <(...)`,
  };
}
