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
      '列出奏折仓里的折（PR），带每折的批注计数。counts.unanswered = 他发的、我方还没回话的 inline 批注数；' +
      'counts.unknown = 最后一条总批（无法判定是他的新意见还是我方回话）；counts.inferred = 推测已回的总批。',
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
      '把一折（或全部 open 折）的批注读成结构化 JSON。inline 是还原好的批注串（根批注 + 我方回话），' +
      '带引文、行号、是否已回；conversation 是会话区总批。answered 已由服务端算好，不需要再自己推。',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'integer', minimum: 1, description: '折号；不给则扫全部 open 折' },
      },
      additionalProperties: false,
    },
  },
] as const;

function parseState(raw: unknown): State {
  if (raw === undefined || raw === null) return 'open';
  if (typeof raw === 'string' && (STATE_VALUES as readonly string[]).includes(raw)) return raw as State;
  throw new ZhupiFailure({ kind: 'badInput', what: `state 只能是 ${STATE_VALUES.join(' 或 ')}，收到 ${String(raw)}` });
}

function parsePr(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ZhupiFailure({ kind: 'badInput', what: `pr 得是正整数，收到 ${String(raw)}` });
  }
  return n;
}

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

export async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const ref = reviewRepo();
  if (name === 'list_folders') {
    const state = parseState(args.state);
    return { repo: ref.slug, state, folders: (await readAll(state, ref)).map(summarize) };
  }
  if (name === 'read_comments') {
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

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    process.stderr.write(`zhupi-mcp 起不来：${String((e as Error)?.message ?? e)}\n`);
    process.exit(1);
  });
}
