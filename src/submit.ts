// 写入侧的编排：呈折 / 回话 / 巡检。
//
// 它自己不碰文件、不碰 git、不直接叫 Octokit —— 那三件事分别在
// worktree.ts / worktree.ts / github.ts。这里只负责把顺序排对，以及**把闸门放在
// 出错代价最高的那一步之前**。
//
// ── 一件必须写在最上面的事 ──
//
// 三个 PreToolUse hook（guard-pr-create / guard-reply-body / guard-closed-folder）
// 只挂在 **Claude Code 的 Bash 工具**上。MCP 工具调用**不经过它们**。
// 也就是说：老脚本那条路上的全部闸门，对这里一条都不生效。
// 凡是那些 hook 拦的事，这里必须自己拦一遍 —— 否则 Phase 3 的净效果是
// 「把呈折搬到了一条没有闸门的新路上」。已经落实的两条：
//   · 已钦此/已关的折不许回话（guard-closed-folder）→ replyComment 自查 state
//   · inline 回话首行盖 `**回话**`（guard-reply-body 硬约定③）→ 焊死，缺了自动补
// 还有一条不适用：guard-pr-create 拦的是「绕过闸门去建 PR」，而这里就是那个闸门本身。

import { reviewRepo, reviewPath, type RepoRef } from './config.js';
import { get, write } from './github.js';
import { fail, ZhupiFailure } from './errors.js';
import { buildBody, verifyMarker, MARKER_RE, SESSION_ID_RE, type FolderBody } from './body.js';
import { detectSessionId } from './session.js';
import { stageFolder, type Staged } from './worktree.js';
import { collect } from './snapshot.js';
import { hasHard, lint, type Finding } from './lint.js';

export const deskUrl = (pr: number): string => `https://charliezong18.github.io/zhupi/?pr=${pr}`;

/** `docs/<slug>.md` / `docs/<slug>.zh-CN.md` → `<slug>`。分支名与文件名同源，这是既有惯例。 */
export function slugOf(docPath: string): string {
  const base = docPath.slice(docPath.lastIndexOf('/') + 1);
  return base.replace(/\.zh-CN\.md$/i, '').replace(/\.md$/i, '');
}

const renderFindings = (fs: Finding[]): string =>
  fs.map((f) => `${f.severity === 'hard' ? '✗' : '⚠'} [规则 ${f.rule}] ${f.subject}：${f.message}`).join('\n');

export interface OpenFolderInput {
  title: string;
  body: FolderBody;
  docs: string[];
  assets?: string[];
  /** 覆盖用。不给则自行探测，探不到就不埋（绝不编）。 */
  sessionId?: string;
  /** 覆盖用。默认取第一篇文档的 slug。 */
  branch?: string;
}

export interface OpenFolderResult {
  pr: number;
  /** **主输出是这个。** github.com 的 PR 链接放在 prUrl，别当主输出 —— */
  desk: string;
  prUrl: string;
  branch: string;
  copied: string[];
  findings: Finding[];
  warnings: string[];
}

/**
 * 呈折。**agent 全程不碰 `~/Developer/review`。**
 *
 * 顺序：拼 body → 拿锁开 worktree → 拷 → commit → **lint 闸门** → push → 建 PR → 回读自核。
 * lint 在 push 之前，所以不合格时远端一片干净（SPEC §5.4 登记的刻意改进）。
 */
export async function openFolder(input: OpenFolderInput, ref: RepoRef = reviewRepo()): Promise<OpenFolderResult> {
  if (!input.title?.trim()) return fail({ kind: 'badInput', what: 'title 不能空' });
  if (!Array.isArray(input.docs) || input.docs.length === 0) {
    return fail({ kind: 'badInput', what: 'docs 要给本机绝对路径，双语一对都要给' });
  }
  for (const d of input.docs) {
    if (typeof d !== 'string' || !d.startsWith('/')) {
      return fail({ kind: 'badInput', what: `docs 得是本机绝对路径，收到 ${JSON.stringify(d)}` });
    }
  }

  const sessionId = input.sessionId ?? detectSessionId();
  const branch = input.branch ?? slugOf(input.docs[0]!);
  // body 要在 lint 之前拼好 —— 规则里有查 body 的（五段缺项），它吃的是最终文本。
  const built = buildBody(input.body, sessionId);

  let findings: Finding[] = [];
  const staged = await stageFolder(
    { docs: input.docs, ...(input.assets ? { assets: input.assets } : {}), branch, message: input.title },
    async (s: Staged) => {
      findings = lint(collect({ worktree: s.worktree, ref: 'HEAD', base: 'origin/main', body: built.text, skipFetch: true }));
      if (hasHard(findings)) {
        // 这里抛 = 什么都不推。错误文本要能直接照着修（R6）。
        throw new ZhupiFailure({
          kind: 'badInput',
          what: `体例不合格，没有呈上去（远端零变化）：\n${renderFindings(findings.filter((f) => f.severity === 'hard'))}`,
        });
      }
    },
    { reviewPath: reviewPath() },
  );

  // 分支推上去了。**从这里往后失败都要说清「折的分支已经在远端了」** ——
  // 不说的话调用方会以为整件事没发生，然后换个 slug 重来，留下一条孤儿分支。
  let pr: { number: number; html_url: string };
  try {
    pr = await write<{ number: number; html_url: string }>('POST /repos/{owner}/{repo}/pulls', {
      owner: ref.owner,
      repo: ref.repo,
      title: input.title,
      head: branch,
      base: 'main',
      body: built.text,
      // **不带 draft。** 2026-07-26 起弃用：私有单人仓里 draft 挡不住任何人，
      // 却挡住「钦此」按钮要的 squash merge。
    });
  } catch (e) {
    return fail({
      kind: 'worktree',
      what: `分支 ${branch} 已经推上去了，但建折失败：${String((e as Error)?.message ?? e)}`,
      hint: `别换 slug 重来（会留孤儿分支）。网络好了补一句：gh pr create -R ${ref.slug} --head ${branch} --title ${JSON.stringify(input.title)} --body-file <(...)`,
    });
  }

  const warnings = [...built.warnings];
  if (staged.fetchFailed) warnings.push('fetch origin 失败 —— 分支基点可能落后于最新 main');
  const check = await verifyMarker(ref, pr.number, sessionId);
  if (!check.ok && check.message) warnings.push(check.message);

  return {
    pr: pr.number,
    desk: deskUrl(pr.number),
    prUrl: pr.html_url,
    branch,
    copied: staged.copied,
    findings,
    warnings,
  };
}

// ── 回话 ──

export const REPLY_PREFIX = '**回话**';

/**
 * 首行是块级构造吗（围栏 / 标题 / 列表 / 引用 / 表格 / 有序列表）。
 *
 * 第三轮跨系统评审 2026-07-30 抓到：zhupi 把 reply 正文整个过 markdown-it
 * （`cards.js:48` `renderMarkdown(r.body)`，`render.js:2` `markdownit({ html: false, … })`），
 * 所以 `**回话** ` + 一行围栏会被读成**行内 code span** —— 代码块整段糊成一段话。
 * 老守卫的做法是**拒绝**（让 agent 自己改写），方向是安全的；焊死的做法必须自己处理这一类。
 *
 * 老实说：现存 18 条回话里**首行是块级构造的有 0 条**，这条是预防不是在修已发生的事故。
 * 但焊死这个动作本身把「agent 自己改写」那一步拿掉了 —— 拿掉之后就得自己接住。
 */
const startsBlock = (line: string): boolean => /^(```|~~~|#{1,6}\s|[-*+]\s|>\s|\d+[.)]\s|\|)/.test(line);

/**
 * 首行盖 `**回话**`（硬约定③）。**默认同一行，别空行。**
 *
 * 朱批台自己已经给每条回话打了 `回话 · <login>` 标签（`cards.js:45-49`），reply 正文又走
 * markdown 渲染 —— 写成 `**回话**\n\n正文` 会渲染出独占一行的加粗「回话」，
 * 在他 300px 宽的批注栏里是三层重复（标签 / 前缀 / 判词）。
 *
 * 守卫（`guard-reply-body.sh`）对缺前缀的做法是**拒绝**；工具这一侧**焊死**（自动补）。
 * 理由是这个项目的既定哲学「文档写了照样能跳过，所以焊进动作本身」。
 *
 * 数据（2026-07-30 第三轮评审现数）：全仓 18 条回话，**6 条**带前缀 ——
 * 都是守卫上线（当天 10:54）之后发的；之前的 12 条一条都没有。
 * 也就是说散文治不住、闸门治得住，焊死是这条曲线的下一步。
 * （旧注释写的「12 条 0 条带前缀」是守卫上线前的快照，别再引用那个数。）
 */
export function withReplyPrefix(body: string): string {
  const text = body.replace(/^\s+/, '');
  if (text.startsWith(REPLY_PREFIX)) return text;
  // 首行是块级构造时前缀另起一段。**这时候独占一行是对的** ——
  // 「别空行」那条讲的是排版重复（300px 栏里三层「回话」），
  // 而这里的代价是把他要读的代码块毁掉，两害相权很清楚。
  if (startsBlock(text.split('\n')[0] ?? '')) return `${REPLY_PREFIX}\n\n${text}`;
  return `${REPLY_PREFIX} ${text}`;
}

export interface ReplyInput {
  pr: number;
  /** **必填。** 省掉它在老 SPEC 里是「发总批」，那条路已经关了 —— 见下。 */
  commentId: number;
  body: string;
}

export async function replyComment(input: ReplyInput, ref: RepoRef = reviewRepo()): Promise<unknown> {
  if (!input.body?.trim()) return fail({ kind: 'badInput', what: 'body 不能空' });

  // 已钦此/已关的折不许动（guard-closed-folder 的那条，MCP 侧自己拦一遍）。
  // 2026-07-29 #23 实测：他说「批完了」时折已 merged，agent 照常改稿推分支回话，
  // **命令全部成功而结果是零** —— 他看到的仍是旧版，反馈指向一个不存在的问题。
  const pr = await get<{ state: string; merged_at: string | null }>(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    { owner: ref.owner, repo: ref.repo, pull_number: input.pr },
    { pageGuard: { kind: 'unknown', detail: '单折详情不该分页' }, notFound: { kind: 'notFound', repo: ref.slug, pr: input.pr } },
  );
  if (pr.state !== 'open') {
    return fail({
      kind: 'badInput',
      what: `#${input.pr} 已经${pr.merged_at ? '钦此' : '关掉'}了，回话落在没人看的已关页面上`,
      hint: '要补内容一律另开一折（SKILL.md :101）。命令会「全部成功」而结果是零 —— 2026-07-29 #23 就是这么绕了一大圈。',
    });
  }

  // **回复的回复要归位到根。** 第三轮评审留了个 NEEDS VERIFICATION：
  // `comment_id` 传一条 reply 的 id 时 GitHub 会不会归一化到串首，仓里 18 条回话
  // 全都指向根，数据答不了。而万一它不归一化，zhupi 会把这条当**孤儿另起一张卡**
  // （`anchor.js:165` 找不到 in_reply_to_id 对应的根就 `roots.push(orphan)`）——
  // 也就是一条没有引文、飘在外面的批注。不去赌，自己先查一次：非根就换成根。
  let commentId = input.commentId;
  const c = await get<{ in_reply_to_id?: number | null }>(
    'GET /repos/{owner}/{repo}/pulls/comments/{comment_id}',
    { owner: ref.owner, repo: ref.repo, comment_id: input.commentId },
    { pageGuard: { kind: 'unknown', detail: '单条批注不该分页' }, notFound: { kind: 'notFound', repo: ref.slug, pr: input.pr } },
  );
  if (c.in_reply_to_id) commentId = c.in_reply_to_id;

  return write('POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies', {
    owner: ref.owner,
    repo: ref.repo,
    pull_number: input.pr,
    comment_id: commentId,
    body: withReplyPrefix(input.body),
  });
}

// ── 巡检 ──

export interface AuditRow {
  pr: number;
  title: string;
  branch: string;
  problems: string[];
  findings: Finding[];
  /** 体例检查跑没跑起来。跑不起来 ≠ 合格。 */
  lintRan: boolean;
}

/**
 * 存量巡检。**纯只读。**
 *
 * 老脚本有 `--fix`，这里没有，两件事各有各的理由：
 *   · 补「回奏对」标记 —— 老脚本 `audit-folders.sh:38` 补的是**当前会话**的 id。
 *     那不是呈这折的那个会话，是编一个，与 §4.4「绝不编，静默指错比没有更糟」矛盾。
 *     指错的后果是「回奏对」按钮把 Charlie 送进一个不相干的会话，比按钮不出现糟得多。
 *   · draft 转正 —— REST 的 PATCH 不接受 draft 字段，只能走 GraphQL；
 *     把 `POST /graphql` 放进写白名单等于开放全部 mutation。报一句命令让人自己跑。
 *
 * 体例那部分调 Phase 2 的核（R7：同一折两边判定必须一致）。
 */
export async function auditFolders(ref: RepoRef = reviewRepo()): Promise<{ repo: string; folders: AuditRow[] }> {
  const list = await get<Array<{ number: number; title: string; body: string | null; draft: boolean; head: { ref: string } }>>(
    'GET /repos/{owner}/{repo}/pulls',
    { owner: ref.owner, repo: ref.repo, state: 'open', per_page: 100 },
    { pageGuard: { kind: 'tooManyFolders', repo: ref.slug } },
  );

  const worktree = reviewPath();
  // 批量跑时只在最外层 fetch 一次 —— 每折各 fetch 一次是几十次网络往返。
  let fetched = false;
  const rows: AuditRow[] = [];

  for (const p of [...list].sort((a, b) => a.number - b.number)) {
    const problems: string[] = [];
    // **查值，不是查前缀。** 老脚本 `audit-folders.sh:32` 是 `grep -q 'happy-session:'`，
    // 于是 `<!-- happy-session: -->` 和一个格式不对的 id 都算「合体例」，
    // 而朱批台上那个按钮根本不会出现（zhupi `link.js:88` 过不了 SESSION_ID 就返回 null）。
    // 巡检存在的全部意义是查出这类漏执行，报个假绿等于没跑（第三轮评审）。
    const marked = MARKER_RE.exec(p.body ?? '')?.[1];
    if (!marked) {
      problems.push('缺「回奏对」标记 —— 不补：只能补成当前会话的 id，那是编一个（§4.4）');
    } else if (!/^https:\/\//i.test(marked) && !SESSION_ID_RE.test(marked)) {
      problems.push(`「回奏对」标记里的 ${JSON.stringify(marked)} 朱批台认不出来（要 16–40 位字母数字），按钮不会出现`);
    }
    if (p.draft) problems.push(`还是 draft（挡住钦此的 squash merge）—— 跑 gh pr ready ${p.number} -R ${ref.slug}`);

    let findings: Finding[] = [];
    let lintRan = true;
    try {
      findings = lint(collect({ worktree, ref: `origin/${p.head.ref}`, base: 'origin/main', skipFetch: fetched }));
      fetched = true;
    } catch (e) {
      lintRan = false;
      problems.push(`体例检查没跑起来：${String((e as Error)?.message ?? e)}`);
    }
    if (hasHard(findings)) problems.push('体例有硬伤（见 findings）');

    rows.push({ pr: p.number, title: p.title, branch: p.head.ref, problems, findings, lintRan });
  }

  return { repo: ref.slug, folders: rows };
}
