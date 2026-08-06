#!/usr/bin/env node
// MCP server 入口：只做装配与启动。工具定义在 tools.ts。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, handleTool } from './tools.js';
import { ZhupiFailure, messageFor } from './errors.js';

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

async function main(): Promise<void> {
  const server = new Server(
    { name: 'menxia-mcp', version: '0.1.0' },
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
  process.stderr.write(`menxia-mcp 起不来：${String((e as Error)?.message ?? e)}\n`);
  process.exit(1);
});
