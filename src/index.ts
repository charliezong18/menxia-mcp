#!/usr/bin/env node
// MCP server 装配。只做工具注册与入参校验，不含业务逻辑（design §1）。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { reviewRepo } from './config.js';
import { readAll, readFolder, summarize } from './folders.js';
import { ZhupiFailure, messageFor } from './errors.js';

const STATE_VALUES = ['open', 'merged'] as const;
type State = (typeof STATE_VALUES)[number];

const TOOLS = [
  {
    name: 'list_folders',
    description:
      '列出奏折仓里的折（PR），按最近活动倒序，带计数与「要看一眼」的正文预览。\n' +
      '· counts.needsReply —— 确定要回：他发的、一条回话都没有的 inline 批注\n' +
      '· counts.unclear —— **判不了**：agent 与用户共用同一个 GitHub 账号，API 分不出作者。' +
      '看 attention 里的 preview 自己判，别当成 0 就跳过\n' +
      '· counts.hasFollowUp —— 后面还有别的总批。**不代表已回**（他连发两条时第一条也在这）\n' +
      '· attention[] —— 每条待看的正文前 80 字 + 时间，够直接判断要不要处理\n' +
      '注意：agent 与用户共用同一个 GitHub 账号，所以「谁说的」只在他走朱批台时才确定。' +
      '他从 GitHub 网页/手机批注或回话时与 agent 同形，一律进 unclear + attention，**不要因为 needsReply=0 就说没事**。' +
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
      '· inline —— 还原好的批注串：根批注 + replies（每条带 fromDesk 标明是他说的还是我方回的），' +
      '含引文 quote、行号 line、是否 outdated\n' +
      '· conversation —— 会话区总批，answered 只有 inferred / unknown 两值，**永远不会是 true**；' +
      'fromDesk=true 的那些是 zhupi 因为锚不到行而并入总批的朱批，**确定是他写的**\n' +
      '· inline[].answered —— 只在 fromDesk=true 时有意义；fromDesk=false 表示这条根批注' +
      '不是从朱批台来的（可能是他从 GitHub 网页发的，也可能是 agent 自己发的），此时看 attention\n' +
      '· counts / attention —— 与 list_folders 同名同义',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'integer', minimum: 1, description: '折号。强烈建议传——不传等于全量拉取' },
      },
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

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

export async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
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
    return { repo: ref.slug, folders };
  }
  throw new ZhupiFailure({ kind: 'badInput', what: `没有叫 ${name} 的工具` });
}

async function main(): Promise<void> {
  const server = new Server(
    { name: 'zhupi-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return asText(await handleTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>));
    } catch (e) {
      // 错误也要面向模型可执行——返回一句能照着修的话，不是 stack trace（R6）。
      const text =
        e instanceof ZhupiFailure ? e.message : messageFor({ kind: 'unknown', detail: String((e as Error)?.message ?? e) });
      return { content: [{ type: 'text' as const, text }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}

// 无条件启动。
// v1 写的是 `import.meta.url === \`file://${process.argv[1]}\``——两边的编码规则不同
// （前者 percent-encoded 且已解析 symlink），路径带空格、带中文、或经 symlink 调用时必然不等，
// 于是 main() 不执行、进程零 handler 立刻 exit 0，客户端只看到「起来就断」且没有一个字的诊断。
// 评审用 symlink 实证过。这个文件本来就只有一个用途，没有被 import 的场景，无条件跑最稳。
main().catch((e: unknown) => {
  process.stderr.write(`zhupi-mcp 起不来：${String((e as Error)?.message ?? e)}\n`);
  process.exit(1);
});
