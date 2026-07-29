#!/usr/bin/env node
// 实机验收（tasks T7）。走真的 MCP 客户端连真的 server，打真的 GitHub。
//
// 判据全部是**正向断言**：双 review 指出 v1 的判据（「#18 未回数为 0」「#19 返回空」）
// 能被一个把 comments 全丢掉的实现干干净净通过——那正是「交付一个看起来能跑其实不对
// 的东西」的标准路径。所以这里每一条都写死真数字，返回空必然变红。

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, why) => { failed += 1; console.log(`  ✗ ${name}\n      ${why}`); };

function check(name, cond, why = '') {
  cond ? ok(name) : bad(name, why);
}

const call = async (client, tool, args = {}) => {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) throw new Error(`${tool} 返回错误：${text}`);
  return JSON.parse(text);
};

const main = async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'index.js')],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'zhupi-mcp-acceptance', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log('\n── R1 · 服务能挂上 ──');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check('tools/list 列出两个工具', names.join(',') === 'list_folders,read_comments', `实得 ${names.join(',')}`);
  check('两个工具都有 inputSchema', tools.every((t) => t.inputSchema?.type === 'object'));

  console.log('\n── R3/R4 · read_comments(17)：inline 的 ground truth ──');
  const r17 = await call(client, 'read_comments', { pr: 17 });
  const f17 = r17.folders?.[0];
  check('返回恰好 1 折', r17.folders?.length === 1, `实得 ${r17.folders?.length}`);
  check('inline 恰好 2 条根批注', f17?.inline?.length === 2, `实得 ${f17?.inline?.length}`);
  check('每条各挂 1 条回话', f17?.inline?.every((t) => t.replies.length === 1),
    `实得 ${JSON.stringify(f17?.inline?.map((t) => t.replies.length))}`);
  check('全部已回', f17?.inline?.every((t) => t.answered === true));
  check('counts.needsReply = 0', f17?.counts?.needsReply === 0, `实得 ${f17?.counts?.needsReply}`);
  check('行号回退到 original_line（非 null）', f17?.inline?.every((t) => typeof t.line === 'number'),
    `实得 ${JSON.stringify(f17?.inline?.map((t) => t.line))}`);
  check('标记为 outdated', f17?.inline?.every((t) => t.outdated === true));
  check('引文非空且不以 diff 标记开头',
    f17?.inline?.every((t) => t.quote.length > 0 && !/^[+-]/.test(t.quote)),
    `实得 ${JSON.stringify(f17?.inline?.map((t) => t.quote.slice(0, 20)))}`);

  console.log('\n── R4 · read_comments(18)：总批三态 ──');
  const r18 = await call(client, 'read_comments', { pr: 18 });
  const f18 = r18.folders?.[0];
  check('conversation 恰好 2 条', f18?.conversation?.length === 2, `实得 ${f18?.conversation?.length}`);
  check('第一条 inferred', f18?.conversation?.[0]?.answered === 'inferred', `实得 ${f18?.conversation?.[0]?.answered}`);
  check('第二条 unknown', f18?.conversation?.[1]?.answered === 'unknown', `实得 ${f18?.conversation?.[1]?.answered}`);
  check('永不出现 true/false', f18?.conversation?.every((c) => c.answered === 'inferred' || c.answered === 'unknown'));
  check('counts.needsReply = 0（判不了的不谎报成待办）', f18?.counts?.needsReply === 0, `实得 ${f18?.counts?.needsReply}`);
  check('counts.unclear = 1', f18?.counts?.unclear === 1, `实得 ${f18?.counts?.unclear}`);
  check('attention 带正文预览，够一眼判断', (f18?.attention?.length ?? 0) > 0 && f18.attention[0].preview.length > 0,
    JSON.stringify(f18?.attention?.[0]));

  console.log('\n── R2 · list_folders ──');
  const open = await call(client, 'list_folders');
  check('open 列表非空', open.folders?.length > 0, `实得 ${open.folders?.length}`);
  check('每折都带 counts 三字段',
    open.folders?.every((f) => !f.ok || ['needsReply', 'unclear', 'hasFollowUp'].every((k) => typeof f.counts?.[k] === 'number')));
  check('每折都有判别字段 ok', open.folders?.every((f) => typeof f.ok === 'boolean'));
  check('按最近活动倒序（不是创建时间序）', (() => {
    const t = open.folders.filter((f) => f.ok).map((f) => f.updatedAt);
    return t.every((v, i) => i === 0 || t[i - 1] >= v);
  })(), JSON.stringify(open.folders?.map((f) => [f.number, f.updatedAt])));
  check('#9 那条真待办能被一眼看到（attention 带正文）', (() => {
    const f9 = open.folders.find((f) => f.number === 9);
    return f9?.attention?.some((a) => a.preview.includes('文档'));
  })(), JSON.stringify(open.folders?.find((f) => f.number === 9)?.attention));

  const merged = await call(client, 'list_folders', { state: 'merged' });
  check('merged 列表非空', merged.folders?.length > 0, `实得 ${merged.folders?.length}`);
  check('merged 不含 #10（那是打回关闭，不是钦此）',
    !merged.folders?.some((f) => f.number === 10),
    '#10 出现在 merged 里 —— 说明用了 state=closed 没按 merged_at 过滤');
  check('merged 含 #19/#20（真钦此过的）',
    [19, 20].every((n) => merged.folders?.some((f) => f.number === n)));

  console.log('\n── design §2 · 两个工具的 counts 必须逐字段一致 ──');
  const detail = await call(client, 'read_comments');
  for (const f of open.folders ?? []) {
    const d = detail.folders?.find((x) => x.number === f.number);
    // 先断言 counts 真的是对象——两边都坏时 undefined === undefined 会静默通过，
    // 那正好是最需要这条判据的场景（第二轮评审指出）。
    check(`#${f.number} counts 一致`,
      f.ok && d?.ok && typeof f.counts === 'object' && JSON.stringify(d.counts) === JSON.stringify(f.counts),
      `list=${JSON.stringify(f.counts)} read=${JSON.stringify(d?.counts)}`);
  }

  console.log('\n── R6 · 错误面向模型可执行 ──');
  const notFound = await client.callTool({ name: 'read_comments', arguments: { pr: 999999 } });
  const nfText = notFound.content?.[0]?.text ?? '';
  check('折号不存在 → 指向 list_folders 而不是叫人查权限',
    notFound.isError === true && nfText.includes('list_folders') && !nfText.includes('权限'), nfText);
  const badKey = await client.callTool({ name: 'read_comments', arguments: { number: 17 } });
  check('传错 key（number 而不是 pr）→ 报错并给出正确写法，不是静默全量拉取',
    badKey.isError === true && (badKey.content?.[0]?.text ?? '').includes('{ pr: 17 }'),
    badKey.content?.[0]?.text?.slice(0, 90));

  const badState = await client.callTool({ name: 'list_folders', arguments: { state: 'closed' } });
  check('非法 state → 一句话而不是异常',
    badState.isError === true && (badState.content?.[0]?.text ?? '').includes('入参不对'),
    badState.content?.[0]?.text);

  await client.close();
  console.log(`\n${failed === 0 ? '实机验收全部通过。' : `实机验收有 ${failed} 条未过。`}`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('实机验收跑不起来：', e?.message ?? e);
  process.exit(1);
});
