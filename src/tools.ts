// 工具注册与入参校验。**不含业务逻辑，也不起 server**（design §1）。
//
// 为什么从 index.ts 里拆出来：index.ts 的 main() 是无条件跑的
// （入口判断在 symlink / 带空格路径下会静默 exit 0，实证过），
// 于是测试一 import 它就真起一个 stdio server，在测试进程里挂 stdin listener。
// 第一轮评审指出这层零覆盖 —— 而四条高危全在这层，必须能单测。

import { reviewRepo } from './config.js';
import { conversationEntries, readAll, readFolder, summarize } from './folders.js';
import { commit, commitUnmark, storePath, type Entry } from './processed.js';
import { ZhupiFailure } from './errors.js';

const STATE_VALUES = ['open', 'merged'] as const;
type State = (typeof STATE_VALUES)[number];

export const TOOLS = [
  {
    name: 'list_folders',
    description:
      '列出奏折仓里的折（PR），按最近活动倒序，带计数与「要看一眼」的正文预览。\n' +
      '· counts.needsReply —— 要处理：他发的没有回话的 inline 批注，加上没记过已处理的总批。' +
      '**注意总批那一半会多报**：共用同一个 GitHub 账号，agent 自己历史上发的总批也会算进来（看 attention 的 preview 就能分辨）\n' +
      '· counts.unclear —— **判不了**：inline 串里最后一条没盖 `**回话**` 前缀，那句是我方回的还是他从网页追的分不出。' +
      '看 attention 里的 preview 自己判，别当成 0 就跳过\n' +
      '· attention[] —— 每条待看的正文前 80 字 + 时间，够直接判断要不要处理\n' +
      '总批的已处理状态记在本地（agent 私有），处理完请调 mark_handled 记一笔，否则它会一直挂着。' +
      '坏折返回 { ok: false, error }，没有 counts。',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: [...STATE_VALUES], description: '默认 open；merged = 已钦此的折' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_comments',
    description:
      '把一折的批注读成结构化 JSON。**要读某一折就传 pr**——不传会扫全部 open 折，体积大一个量级。\n' +
      '· inline —— 还原好的批注串：根批注 + replies，含引文 quote、行号 line、是否 outdated。' +
      '每条 reply 带两个标记：`ours=true` **确定**是我方回的（盖了 `**回话**` 前缀）；' +
      '`fromDesk=true` **确定**是他从朱批台说的。**两个都 false 表示判不了**' +
      '（他从 GitHub 网页在串里回话，与 agent 回话在 API 里完全同形）\n' +
      '· conversation —— 会话区总批。`answered` 是 handled / pending 两值，**取自本地已处理记录，不是推断**；' +
      'fromDesk=true 的是 zhupi 因为锚不到行而并入总批的朱批\n' +
      '· inline[].answered —— 只在 fromDesk=true 时有意义；fromDesk=false 表示这条根批注' +
      '不是从朱批台来的（可能是他从 GitHub 网页发的，也可能是 agent 自己发的），此时看 attention。' +
      '`orphan=true` 表示它回复的根批注不在结果里（根被删），一律按未回处理\n' +
      '· handledIds —— 该折已记过已处理的总批 id（本地记录），配 stateFile 一起给出，' +
      '好让人能查「这条我处理没有」\n' +
      '· counts / attention —— 与 list_folders 同名同义',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'integer', minimum: 1, description: '折号。强烈建议传——不传等于全量拉取' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mark_handled',
    description:
      '把某折的总批标记成「已处理」。**写的是 agent 本地记录，不碰 GitHub。**\n' +
      '为什么要有它：agent 与用户共用同一个 GitHub 账号，任何写进 GitHub 的标记都会退化成靠约定；' +
      '而「这条我处理过了」只有 agent 知道，放本地就与账号共用无关了。\n' +
      '什么时候调：读完总批、改完文档、在聊天里回过他之后，把处理过的 conversation id 记一笔。' +
      '**不记它就会一直挂在 needsReply 里。**\n' +
      '**记的是 id + 当时的修改时间**，所以他之后原地编辑那条总批，它会自动重新变 pending。\n' +
      '`ids` 从 `read_comments(pr).conversation[].id` 来。\n' +
      '`seed: true` = 清历史积压。**两步**：先不带 confirm 调一次，它只返回「将要标掉什么」' +
      '（含正文预览，`fromDesk: true` 的是**他的朱批**，标掉等于让他的话消失）；看清楚了再带 `confirm: true` 落盘。\n' +
      '`undo: true` + `ids` = 撤销标记（标错了用这个）。',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'integer', minimum: 1, description: '折号' },
        ids: { type: 'array', items: { type: 'integer' }, description: '要标记的 conversation id，与 seed 互斥' },
        seed: { type: 'boolean', description: '清积压：不带 confirm 时只预览，不写' },
        confirm: { type: 'integer', description: 'seed 的第二步：填上一次 dry-run 报的 wouldMark 条数' },
        undo: { type: 'boolean', description: '撤销 ids 的标记' },
      },
      required: ['pr'],
      additionalProperties: false,
    },
  },
] as const;

/**
 * 手工挡未知入参。
 * MCP SDK **不按 inputSchema 校验**，`additionalProperties: false` 形同虚设：
 * 第二轮评审实测 `read_comments {number: 17}` 不报错、静默走「不传 pr」分支拉回全部 9 折。
 * 而 `number` 是最自然的猜法——list_folders 返回里那个字段就叫 number。
 */
function rejectUnknownKeys(tool: string, args: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return;
  const hint = extra.includes('number') && allowed.includes('pr') ? '；折号请写成 { pr: 17 }' : '';
  throw new ZhupiFailure({
    kind: 'badInput',
    what: `${tool} 只认 ${allowed.join(' / ')} 这些入参，收到 ${extra.join(' / ')}${hint}`,
  });
}

function parseState(raw: unknown): State {
  if (raw === undefined || raw === null) return 'open';
  if (typeof raw === 'string' && (STATE_VALUES as readonly string[]).includes(raw)) return raw as State;
  // 用 JSON.stringify 不用 String()：String(['open']) === 'open'，
  // 报错会变成「state 只能是 open 或 merged，收到 open」，模型读到会以为 open 被拒然后死循环重试。
  throw new ZhupiFailure({
    kind: 'badInput',
    what: `state 只能是 ${STATE_VALUES.join(' 或 ')}，收到 ${JSON.stringify(raw)}`,
  });
}

function parsePr(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  // 严格判类型：v1 用 Number() 强转，实测 "3" / [3] / true 全被接受（分别 → 3、3、1），
  // 与 inputSchema 声明的 type:integer 矛盾。
  // 上界也要卡：Number.isInteger(1e21) 为真，而 String(1e21) === '1e+21'，
  // GitHub 按 to_i 解析成 1 —— 不报错，**返回另一折**（第三轮评审实证）。
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 1_000_000) {
    throw new ZhupiFailure({ kind: 'badInput', what: `pr 得是正整数，收到 ${JSON.stringify(raw)}` });
  }
  return raw;
}

/**
 * ids 逐个严格校验。
 * v1 是 `filter(typeof x === 'number')` —— 字符串 id 让整个调用变成**静默 no-op
 * 并返回成功**（实测），而 GitHub comment id 是 10 位整数，模型写成字符串是高频写法。
 */
export function parseIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ZhupiFailure({ kind: 'badInput', what: 'mark_handled 要给 ids（或 seed: true 清积压）' });
  }
  const bad = raw.filter((x) => typeof x !== 'number' || !Number.isInteger(x) || x < 1);
  if (bad.length > 0) {
    throw new ZhupiFailure({ kind: 'badInput', what: `ids 得是正整数，收到 ${JSON.stringify(bad)}` });
  }
  return raw as number[];
}

/**
 * 可注入的取数口。
 * 第二轮评审发现 tools 层有 7 个变异存活（seed 跳过 confirm 直接写、undo 分支失效、
 * 不给 handledIds、把 refreshed 说成早就记过……），因为这层的**行为**只被
 * `npm run acceptance` 护着，而它要联网 + 真仓，不在 `npm test` 里。
 */
export type ToolDeps = { entries: typeof conversationEntries };
const REAL_DEPS: ToolDeps = { entries: conversationEntries };

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps = REAL_DEPS,
): Promise<unknown> {
  const ref = reviewRepo();
  if (name === 'list_folders') {
    rejectUnknownKeys('list_folders', args, ['state']);
    const state = parseState(args.state);
    return { repo: ref.slug, state, folders: (await readAll(state, ref)).map(summarize) };
  }
  if (name === 'read_comments') {
    rejectUnknownKeys('read_comments', args, ['pr']);
    const pr = parsePr(args.pr);
    const folders = pr === undefined ? await readAll('open', ref) : [await readFolder(pr, ref)];
    return {
      repo: ref.slug,
      stateFile: storePath(),
      // handledIds **从 conversation 推**，不再单独读一遍状态文件。
      // 第二轮评审抓到：裸 Object.keys(store[pr]) 绕过了「他改过就重新 pending」这条判据，
      // 于是同一个响应里同一条 id 既 handled 又 pending —— 而工具描述正教人用
      // handledIds 回答「这条我处理没有」，刚堵掉的漏报从这个新字段原路回来。
      // 顺带也消掉了单次调用内两次读状态文件的 TOCTOU。
      folders: folders.map((f) =>
        f.ok ? { ...f, handledIds: f.conversation.filter((c) => c.answered === 'handled').map((c) => c.id) } : f,
      ),
    };
  }
  if (name === 'mark_handled') {
    rejectUnknownKeys('mark_handled', args, ['pr', 'ids', 'seed', 'confirm', 'undo']);
    const pr = parsePr(args.pr);
    if (pr === undefined) throw new ZhupiFailure({ kind: 'badInput', what: 'mark_handled 必须给 pr' });
    // seed 与 ids 必须互斥。v1 是 seed 静默胜出、ids 被丢掉——两个 agent 各自独立抓到：
    // 模型图稳当两个都传，结果是**整折被标掉**，而描述里一个字没提。
    // seed / ids / undo 三者的组合必须逐个挡掉。
    // 上一版只挡了 seed vs ids，第二轮评审立刻用 `{seed:true, undo:true}` 穿过去：
    // 调用方要的是**撤销**，结果整折被标掉，响应里一个字没提 undo 被丢了。
    if (args.seed === true && args.ids !== undefined) {
      throw new ZhupiFailure({ kind: 'badInput', what: 'seed 与 ids 只能给一个：seed 是整折清积压，ids 是标指定几条' });
    }
    if (args.confirm !== undefined && typeof args.confirm !== 'number') {
      throw new ZhupiFailure({
        kind: 'badInput',
        what: `confirm 要填 dry-run 报的 wouldMark 条数（整数），不是 ${JSON.stringify(args.confirm)}`,
      });
    }
    if (args.seed === true && args.undo === true) {
      throw new ZhupiFailure({ kind: 'badInput', what: 'seed 与 undo 是反方向的，不能一起给。撤销请用 { pr, ids, undo: true }' });
    }
    if (args.confirm !== undefined && args.seed !== true) {
      throw new ZhupiFailure({ kind: 'badInput', what: 'confirm 只跟 seed 一起用（seed 的第二步）' });
    }
    // 纯入参校验**全部**放在任何网络调用之前：一是打错了不该先花一轮 API，
    // 二是这层能被单测覆盖——第一轮评审四条高危全在这层，而当时它一条测试都没有。
    const ids = args.seed === true ? [] : parseIds(args.ids);

    // undo 只动本地记录，不需要知道折里现在有什么 —— 上一版白拉一次全折。
    if (args.undo === true) {
      const { removed } = commitUnmark(pr, ids);
      return { repo: ref.slug, pr, removed, notRecorded: ids.filter((i) => !removed.includes(i)), stateFile: storePath() };
    }

    const all = await deps.entries(pr, ref);
    const byId = new Map(all.map((e) => [e.id, e]));

    if (args.seed === true) {
      const targets = all.filter((e) => e.answered === 'pending');
      if (args.confirm === undefined) {
        // **只预览，不写。** seed 是全系统唯一不可逆又不可见的操作，而它吞掉的可能是
        // 他的朱批本身（zhupi 锚不到行会把批注并入总批）——评审在 #9 上实测过一次。
        return {
          repo: ref.slug,
          pr,
          dryRun: true,
          wouldMark: targets.length,
          targets,
          // **默认就警告。** 上一版只在 `fromDesk` 为真时警告，而第三轮评审实测
          // 那条路径（zhupi 锚不到行降级并入总批）在生产里 **0/16 折触发过** ——
          // 于是唯一的护栏是死的，而他 99% 的总批都是 fromDesk:false，拿到的是让人放心的那句。
          hint:
            `⚠️ 这些总批的作者 API 分不出来（共用账号）。逐条看 preview 再决定 —— ` +
            `标掉的东西在所有工具输出里都消失，且他不可能发现。` +
            (targets.some((t) => t.fromDesk) ? '**其中带 fromDesk 的确定是他的朱批**（zhupi 降级并入），尤其别标。' : '') +
            `确认要标就调 { pr: ${pr}, seed: true, confirm: ${targets.length} }。`,
        };
      }
      // **confirm 必须报出 dry-run 看到的条数。**
      // 上一版描述写着「两步」，代码却没挡 `{seed:true, confirm:true}` 同一次调用——
      // 第三轮评审一次调用吞掉了他在 #2 上的 4 条真话（「能不能加点前端的设计渲染图啊」…）。
      // 两步必须是闸门，不能是自愿。数字对不上就说明没看过预览，或者预览之后又有新话。
      if (args.confirm !== targets.length) {
        throw new ZhupiFailure({
          kind: 'badInput',
          what:
            `seed 的第二步要写 confirm: ${targets.length}（不是 true）—— 那是刚才 dry-run 报的 wouldMark。` +
            `收到 ${JSON.stringify(args.confirm)}。没跑过 dry-run 就先跑一次，逐条看 preview 再说：` +
            `标掉的东西看不见也追不回，里面很可能有他的真话。`,
        });
      }
      const { added, refreshed } = commit(pr, targets);
      return { repo: ref.slug, pr, seeded: true, added, refreshed, stateFile: storePath() };
    }

    // 不在这折里的 id 直接拒。默认接受会静默污染状态文件，且**没有任何提示**——
    // 打错折号、把 inline comment id 当总批 id 传，都会「成功」（实测）。
    const unknown = ids.filter((i) => !byId.has(i));
    if (unknown.length > 0) {
      throw new ZhupiFailure({
        kind: 'badInput',
        what: `#${pr} 里没有这些总批：${unknown.join(' / ')}。id 取自 read_comments(${pr}).conversation[].id`,
      });
    }
    const entries: Entry[] = ids.map((i) => byId.get(i)!);
    const { added, refreshed } = commit(pr, entries);
    // 三分：新记的 / 他改过之后重新确认的 / 本来就记过。加起来必须等于 ids.length，
    // 不然就是在对没记进去的 id 报「已处理」（v1 的 alreadyHandled 就是这么说谎的）。
    // 用**去重后**的 ids 算，否则 `[a,a,b]` 会把 a 回显两次、三者之和 ≠ ids 条数
    // （F12 只在 mark 里去了重，这条输出轴上重现了同一个多报）。
    const already = [...new Set(ids)].filter((i) => !added.includes(i) && !refreshed.includes(i));
    return { repo: ref.slug, pr, added, refreshed, alreadyHandled: already, stateFile: storePath() };
  }
  throw new ZhupiFailure({ kind: 'badInput', what: `没有叫 ${name} 的工具` });
}

