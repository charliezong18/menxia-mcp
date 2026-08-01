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

// **两条都照 zhupi 的源码抄，不是照我的想象。**（第三轮跨系统评审 2026-07-30）
//
// zhupi `src/link.js:83-88` 是先松后严两步：
//   const marked = /<!--\s*happy-session:\s*([^\s>]+)\s*-->/i.exec(text);
//   return SESSION_ID.test(raw) ? `${HAPPY_BASE}/session/${raw}` : null;
//   const SESSION_ID = /^[a-z0-9]{16,40}$/i;   // 锚定：`http://evil/...` 之类不得当成裸 id
//
// 上一版这里是 `/<!--\s*happy-session:\s*([A-Za-z0-9_-]+)\s*-->/` —— 两个方向都不对：
// 提取比 zhupi 严（吃不到它故意放行的整条 URL 那条通道），**校验比 zhupi 松**
// （允许 `_`、`-` 和任意长度）。后者才是真问题：`sessionId` 是可覆盖入参，
// 传一个带连字符的 UUID 进来，`verifyMarker` 会报 ok、`open_folder` 一个警告都不出，
// 而门下上那个「回奏对」按钮**静默不出现** —— 正是这个文件开头声称在防的那件事。
export const MARKER_RE = /<!--\s*happy-session:\s*([^\s>]+)\s*-->/i;
/** zhupi 认不认这个 id。逐字抄自 `link.js:80`。 */
export const SESSION_ID_RE = /^[a-z0-9]{16,40}$/i;

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

export function buildBody(b: FolderBody, sessionId: string | null, relMarker?: string | null): BuiltBody {
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
  // 折务追踪的关系标记（#61）：与 happy-session 同族，机器可读、读者不可见。
  // 排在 happy-session 之前 —— 两个正则都全文扫，顺序只为肉眼读 diff 时稳定。
  if (relMarker) text += `\n\n${relMarker}`;
  if (sessionId && !SESSION_ID_RE.test(sessionId)) {
    // **埋一个 zhupi 认不出来的 id ≠ 不埋。** 埋了它，按钮照样不出现，
    // 但这边什么都不报 —— 静默指错。宁可不埋并且说出来。
    warnings.push(
      `会话 id ${JSON.stringify(sessionId)} 不符合门下的格式（16–40 位字母数字，见 zhupi link.js:80），` +
      '本折不埋「回奏对」标记 —— 埋了按钮也不会出现，而且没人会发现',
    );
  } else if (sessionId) {
    text += `\n\n<!-- happy-session: ${sessionId} -->\n`;
  } else {
    // 探不到就不埋，**绝不编**（SPEC §4.4）。按钮不出现而已；静默指错比没有更糟。
    warnings.push('拿不到 happy 会话 id，本折不埋「回奏对」标记 —— 门下上不会有回奏对按钮');
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
  // **没埋标记时也要回读一次。**
  //
  // 第二轮评审（2026-07-30）指出上一版的洞：`sessionId` 为空就直接 return ok，
  // 理由是「我没埋，所以没什么可核的」。但 body 的五段是**调用方写的文本** ——
  // 从旧折模板复制粘贴时很容易把一行 `<!-- happy-session: … -->` 一起带进来。
  // 那时候折上就有一个我没埋、指向别处的标记，而这边一个字都不说。
  // 这正是本文件开头写的「静默指错比没有更糟」，只是方向反了：
  // 我防住了「自己编一个」，没防住「别人的混进来」。
  const expect = sessionId && SESSION_ID_RE.test(sessionId) ? sessionId : null;
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
  const found = MARKER_RE.exec(body)?.[1] ?? null;
  if (found === expect) return { ok: true, unverified: false };
  if (expect === null) {
    return {
      ok: false,
      unverified: false,
      message:
        `本折没埋「回奏对」标记，但 #${pr} 的 body 里有一个 ${JSON.stringify(found)} —— ` +
        '多半是从旧折的模板复制粘贴带进来的。它会把「回奏对」按钮指到别的会话去，删掉它。',
    };
  }
  return {
    ok: false,
    unverified: false,
    message: found
      ? `body 里的会话 id 是 ${found}，不是本次的 ${expect} —— 回奏对按钮会把你送进别的会话。`
      : `标记没落进 #${pr} 的 body。补：gh pr edit ${pr} -R ${repo.slug} --body-file <(...)`,
  };
}
