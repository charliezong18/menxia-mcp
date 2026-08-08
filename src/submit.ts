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
//   · 已画可/已关的折不许回话（guard-closed-folder）→ replyComment 自查 state
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
import { readAll, isFolderError } from './folders.js';
import { buildRelMarker, labelColor, labelDesc, labelsFor, trackAudit, unknownQian, type TrackFolderState, type TrackInput } from './track.js';

// 2026-07-31 仓与 Pages 由 menxia 改名 menxia。旧址 /zhupi/ 现在是一个只做转发的壳仓，
// 原样带走 query 与 hash，所以历史折 body 里的 directLink 仍然点得开。新折一律发新址。
export const deskUrl = (pr: number): string => `https://charliezong18.github.io/menxia/?pr=${pr}`;

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
  /**
   * 这一折是**单语读物**（只有一种语言，不需要译本），免体例规则 1 的双语对。
   * 会往 `docs/.monolingual` 追加本折的文档路径，随折 merge 进 main。
   */
  monolingual?: boolean;
  /**
   * 折务追踪（#61；签 = #116）：proj/kind/wait/签 四类 label + 折间关系标记。
   * 到这里的已经是 tools 层校验过的 —— 缺省不拦，只出 warning（新折别裸奔）。
   */
  track?: TrackInput;
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
  const built = buildBody(input.body, sessionId, input.track ? buildRelMarker(input.track) : null);

  let findings: Finding[] = [];
  const staged = await stageFolder(
    {
      docs: input.docs,
      ...(input.assets ? { assets: input.assets } : {}),
      ...(input.monolingual ? { monolingual: true } : {}),
      branch,
      message: input.title,
    },
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
      // 却挡住「画可」按钮要的 squash merge。
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
  if (input.track) {
    warnings.push(...(await applyTrackLabels(ref, pr.number, labelsFor(input.track), input.track.qian)));
  } else {
    warnings.push('本折没带 track（proj/kind/wait）—— 门下分组会把它落到「未标注」，词表与规矩见 review #61');
  }
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

/**
 * 贴折务追踪的 label（#61；签 = review #116）。**折已经建好才走到这里**，所以任何失败都只能是
 * warning —— 贴不上 ≠ 折没呈上，把两件事说成一件会引人重开一折（与 verifyMarker 同一个理由）。
 *
 * 两步：
 *   1. 补建缺的 label —— 按词表定色（track.ts 单点）。**尽力而为**：这步失败的代价
 *      只是颜色落默认灰（下一步会自动建缺的，2026-07-31 对真仓实测），所以吞掉不报。
 *   2. 一次性贴上 —— 这步才是硬的，失败要报出补救命令。
 *
 * 顺带：签是开放集，**新签**（既不在初始七签、也不是仓里已有的 `签:*` label）照建照贴，
 * 但出一条 warning —— 与 track 缺失只警告不阻断同一个哲学。判据吃的是这里已经拉到的
 * 现有 label 清单；清单拉不到就退化成只对种子七签放行。
 */
async function applyTrackLabels(ref: RepoRef, prNumber: number, labels: string[], qian: string[] = []): Promise<string[]> {
  const warnings: string[] = [];
  let existingNames: string[] = [];
  try {
    const existing = await get<Array<{ name: string }>>(
      'GET /repos/{owner}/{repo}/labels',
      { owner: ref.owner, repo: ref.repo, per_page: 100 },
      { pageGuard: { kind: 'unknown', detail: 'label 超过 100 个 —— 词表不该长这么大，先去清理' } },
    );
    existingNames = existing.map((l) => l.name);
    const have = new Set(existingNames);
    for (const name of labels.filter((n) => !have.has(n))) {
      try {
        await write('POST /repos/{owner}/{repo}/labels', {
          owner: ref.owner,
          repo: ref.repo,
          name,
          color: labelColor(name),
          description: labelDesc(name),
        });
      } catch {
        // 与人并发建同名 label / 网络抖动 —— 都由第 2 步兜底，这里只影响颜色。
      }
    }
  } catch {
    // 读不到现有 label 清单：直接靠第 2 步的自动建；新签判据退化成只认种子七签。
  }
  for (const q of unknownQian(qian, existingNames)) {
    warnings.push(`新签「${q}」不在现有签集 —— 确认不是想打别的签（照建照贴了）`);
  }
  try {
    await write('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      labels,
    });
    return warnings;
  } catch (e) {
    const cmd = labels.map((l) => `--add-label ${JSON.stringify(l)}`).join(' ');
    warnings.push(`track 的 label 没贴上（折本身已建好）：${String((e as Error)?.message ?? e)}。补：gh pr edit ${prNumber} -R ${ref.slug} ${cmd}`);
    return warnings;
  }
}

// ── 回话 ──

export const REPLY_PREFIX = '**回话**';

/**
 * 首行（连带第二行）会不会让 `**回话** ` 前缀毁掉块级渲染。
 *
 * 第三轮跨系统评审 2026-07-30 抓到：menxia 把 reply 正文整个过 markdown-it
 * （`cards.js:48` `renderMarkdown(r.body)`，`render.js:2` `markdownit({ html: false, … })`），
 * 所以 `**回话** ` + 一行围栏会被读成**行内 code span** —— 代码块整段糊成一段话。
 * 老守卫的做法是**拒绝**（让 agent 自己改写），方向是安全的；焊死的做法必须自己处理这一类。
 *
 * 三类首行会被前缀毁掉，走独占一段：
 *   1. 首行**自身**就是块级起手（围栏 / 标题 / 列表 / 引用 / 表格 / 有序列表）。
 *      CommonMark 容块级起手带 0–3 空格缩进（4 起才是 ② 的代码块），判定也得容 ——
 *      只剥空行之后若锚死列 0，`  > 引文` 这类会漏进同一行路径（Fable 复审抓的回归）。
 *   2. 首行缩进 ≥4 空格或 Tab —— 那是缩进代码块；`**回话** ` 顶掉缩进，代码块塌成普通句。
 *   3. **setext 标题**：首行是普通文字、**第二行**是 `===` / `---` 下划线 —— 前缀焊在首行上，
 *      整行连同 `**回话**` 被渲成 H1/H2。这一类**必须看第二行**才认得出，单看首行会漏。
 *
 * 老实说：现存 18 条回话里**首行是块级构造的有 0 条**，这条是预防不是在修已发生的事故。
 * 但焊死这个动作本身把「agent 自己改写」那一步拿掉了 —— 拿掉之后就得自己接住。
 */
const startsBlock = (first: string, second: string): boolean =>
  /^ {0,3}(```|~~~|#{1,6}\s|[-*+]\s|>\s|\d+[.)]\s|\|)/.test(first) // ① 围栏/标题/列表/引用/表格/有序（容 0–3 空格缩进）
  || /^( {4}|\t)/.test(first)                                      // ② 缩进代码块（≥4 空格 / Tab）
  || (first.trim() !== '' && /^ {0,3}(=+|-+)\s*$/.test(second));   // ③ setext：下一行是 === / ---

/**
 * 首行盖 `**回话**`（硬约定③）。**默认同一行，别空行。**
 *
 * 门下自己已经给每条回话打了 `回话 · <login>` 标签（`cards.js:45-49`），reply 正文又走
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
  // **只剥前导空行，不剥首个内容行的缩进。** 上一版一句 `^\s+` 把两者一起吃了 ——
  // 于是缩进代码块的前导 4 空格被顺手抹掉，代码块在判定之前就已经塌成散文，
  // 「另起一段」也救不回来。分两步：先去掉整行空行，块级判定对着**留着缩进**的文本做；
  // 只有确认走同一行（普通散文）时，才把首行那点无意义缩进（<4 空格）也去掉。
  const dedented = body.replace(/^(?:[ \t]*\r?\n)+/, '');
  const trimmed = dedented.replace(/^[ \t]+/, '');
  if (trimmed.startsWith(REPLY_PREFIX)) return trimmed;
  // 首行是块级构造时前缀另起一段。**这时候独占一行是对的** ——
  // 「别空行」那条讲的是排版重复（300px 栏里三层「回话」），
  // 而这里的代价是把他要读的代码块毁掉，两害相权很清楚。
  // setext 要看第二行、缩进代码块要看首行缩进，都得对着没剥缩进的 dedented 判。
  const lines = dedented.split('\n');
  if (startsBlock(lines[0] ?? '', lines[1] ?? '')) return `${REPLY_PREFIX}\n\n${dedented}`;
  return `${REPLY_PREFIX} ${trimmed}`;
}

export interface ReplyInput {
  pr: number;
  /** **必填。** 省掉它在老 SPEC 里是「发判」，那条路已经关了 —— 见下。 */
  commentId: number;
  body: string;
}

export async function replyComment(input: ReplyInput, ref: RepoRef = reviewRepo()): Promise<unknown> {
  if (!input.body?.trim()) return fail({ kind: 'badInput', what: 'body 不能空' });

  // 已画可/已关的折不许动（guard-closed-folder 的那条，MCP 侧自己拦一遍）。
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
      what: `#${input.pr} 已经${pr.merged_at ? '画可' : '关掉'}了，回话落在没人看的已关页面上`,
      hint: '要补内容一律另开一折（SKILL.md :101）。命令会「全部成功」而结果是零 —— 2026-07-29 #23 就是这么绕了一大圈。',
    });
  }

  // **回复的回复要归位到根。** 第三轮评审留了个 NEEDS VERIFICATION：
  // `comment_id` 传一条 reply 的 id 时 GitHub 会不会归一化到串首，仓里 18 条回话
  // 全都指向根，数据答不了。而万一它不归一化，menxia 会把这条当**孤儿另起一张卡**
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
  /**
   * 折务四检（#61 §3.4 + 涂归追加的「可画可候选」）：僵尸候选 / 已解锁 / wait 漂移 / 可画可。
   * 与 problems 分开 —— 「依赖已解锁」不是毛病，混在一起会把好消息读成坏消息。
   */
  trackNotes: string[];
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
  type RawListed = {
    number: number;
    title: string;
    body: string | null;
    draft: boolean;
    head: { ref: string };
    labels: Array<{ name: string }>;
    merged_at: string | null;
  };
  const list = await get<RawListed[]>(
    'GET /repos/{owner}/{repo}/pulls',
    { owner: ref.owner, repo: ref.repo, state: 'open', per_page: 100 },
    { pageGuard: { kind: 'tooManyFolders', repo: ref.slug } },
  );

  // 折务四检（#61）要的另外两份材料：
  //   · 近期已画可折的 body —— 谁声明 supersedes 了还开着的折（僵尸候选），
  //     谁的画可解了 open 折的 needs。closed 里没 merge 的（打回）不算画可，照 folders.ts 同规过滤。
  //   · open 折的 counts / engaged —— wait 漂移与可画可候选。走 readAll 那条**唯一**的计数路径，
  //     不另算一遍（「列折说 3 条未回、巡检说 2 条」这种分叉正是 design §2 反对的）。
  // 两份都拿不到时四检降级跳过 —— 巡检的其余部分照跑，比整个 audit 挂掉有用。
  let mergedStates: TrackFolderState[] = [];
  let countsByPr = new Map<number, { counts: { needsReply: number; unclear: number }; engaged: boolean }>();
  let trackDown: string | null = null;
  try {
    const closed = await get<RawListed[]>(
      'GET /repos/{owner}/{repo}/pulls',
      { owner: ref.owner, repo: ref.repo, state: 'closed', per_page: 100 },
      { pageGuard: { kind: 'tooManyFolders', repo: ref.slug } },
    );
    mergedStates = closed
      .filter((p) => p.merged_at != null)
      // labels 兜空：真 API 恒有这个字段，但测试夹具/降级代理未必给 —— 四检少一维好过整个巡检炸掉。
      .map((p) => ({ number: p.number, labels: (p.labels ?? []).map((l) => l.name), body: p.body }));
    const details = await readAll('open', ref);
    countsByPr = new Map(
      details
        .flatMap((d) => (isFolderError(d) ? [] : [d]))
        .map((d) => [
          d.number,
          {
            counts: d.counts,
            // engaged 只认**确证**是他的话（fromDesk）—— 共用账号下别的判据都会多报。
            engaged: d.inline.some((t) => t.fromDesk === true) || d.conversation.some((c) => c.fromDesk === true),
          },
        ]),
    );
  } catch (e) {
    trackDown = `折务四检没跑起来（其余巡检照常）：${String((e as Error)?.message ?? e)}`;
  }
  const openStates: TrackFolderState[] = list.map((p) => ({
    number: p.number,
    labels: (p.labels ?? []).map((l) => l.name),
    body: p.body,
    ...(countsByPr.has(p.number)
      ? { counts: countsByPr.get(p.number)!.counts, engaged: countsByPr.get(p.number)!.engaged }
      : {}),
  }));
  const notes = trackDown === null ? trackAudit(openStates, mergedStates, ref.slug) : new Map<number, string[]>();

  const worktree = reviewPath();
  // 批量跑时只在最外层 fetch 一次 —— 每折各 fetch 一次是几十次网络往返。
  let fetched = false;
  const rows: AuditRow[] = [];

  for (const p of [...list].sort((a, b) => a.number - b.number)) {
    const problems: string[] = [];
    // **查值，不是查前缀。** 老脚本 `audit-folders.sh:32` 是 `grep -q 'happy-session:'`，
    // 于是 `<!-- happy-session: -->` 和一个格式不对的 id 都算「合体例」，
    // 而门下上那个按钮根本不会出现（menxia `link.js:88` 过不了 SESSION_ID 就返回 null）。
    // 巡检存在的全部意义是查出这类漏执行，报个假绿等于没跑（第三轮评审）。
    const marked = MARKER_RE.exec(p.body ?? '')?.[1];
    if (!marked) {
      problems.push('缺「回奏对」标记 —— 不补：只能补成当前会话的 id，那是编一个（§4.4）');
    } else if (!/^https:\/\//i.test(marked) && !SESSION_ID_RE.test(marked)) {
      problems.push(`「回奏对」标记里的 ${JSON.stringify(marked)} 门下认不出来（要 16–40 位字母数字），按钮不会出现`);
    }
    if (p.draft) problems.push(`还是 draft（挡住画可的 squash merge）—— 跑 gh pr ready ${p.number} -R ${ref.slug}`);

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

    const trackNotes = [...(notes.get(p.number) ?? [])];
    if (trackDown !== null) trackNotes.push(trackDown);
    rows.push({ pr: p.number, title: p.title, branch: p.head.ref, problems, findings, lintRan, trackNotes });
  }

  return { repo: ref.slug, folders: rows };
}
