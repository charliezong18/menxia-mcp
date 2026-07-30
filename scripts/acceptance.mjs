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
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

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

/** 拿错误文本而不是抛——「该被拒的输入真的被拒了」也是判据。 */
const callRaw = async (client, tool, args = {}) => {
  const res = await client.callTool({ name: tool, arguments: args });
  return { isError: res.isError === true, text: res.content?.[0]?.text ?? '' };
};

const main = async () => {
  // **必须显式传 env**：StdioClientTransport 默认只透一小部分安全变量，
  // 不传的话 server 会写到家目录的真实状态文件里——第一次跑就污染了我的真数据（实测）。
  const stateFile = join(tmpdir(), `zhupi-acceptance-${process.pid}.json`);
  rmSync(stateFile, { force: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'index.js')],
    stderr: 'pipe',
    env: { ...process.env, ZHUPI_STATE_FILE: stateFile },
  });
  const client = new Client({ name: 'zhupi-mcp-acceptance', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log('\n── R1 · 服务能挂上 ──');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check('tools/list 列出三个工具', names.join(',') === 'list_folders,mark_handled,read_comments', `实得 ${names.join(',')}`);
  check('每个工具都有 inputSchema', tools.every((t) => t.inputSchema?.type === 'object'));
  check('状态文件被隔离到临时路径（不碰真实数据）', stateFile.startsWith(tmpdir()), stateFile);

  console.log('\n── R3/R4 · read_comments(17)：inline 的 ground truth ──');
  const r17 = await call(client, 'read_comments', { pr: 17 });
  const f17 = r17.folders?.[0];
  check('返回恰好 1 折', r17.folders?.length === 1, `实得 ${r17.folders?.length}`);
  check('inline 恰好 2 条根批注', f17?.inline?.length === 2, `实得 ${f17?.inline?.length}`);
  check('每条各挂 1 条回话', f17?.inline?.every((t) => t.replies.length === 1),
    `实得 ${JSON.stringify(f17?.inline?.map((t) => t.replies.length))}`);
  check('全部已回', f17?.inline?.every((t) => t.answered === true));
  check('counts.needsReply = 0', f17?.counts?.needsReply === 0, `实得 ${f17?.counts?.needsReply}`);
  // 旧判据断言 unclear === 2 —— 那是把多报当成了期望行为。#17 那两条回话
  // 在逐条核过的存量表（LEGACY_OUR_REPLIES）里，现在是**确定**已回。
  check('#17 早就回完 → counts 干净', f17?.counts?.unclear === 0 && f17?.counts?.needsReply === 0,
    JSON.stringify(f17?.counts));
  check('干净是因为判定确定了，**不是因为数据被丢了**',
    f17?.inline?.length === 2 && f17.inline.every((t) => t.replies?.[0]?.ours === true),
    JSON.stringify(f17?.inline?.map((t) => [t.id, t.replies?.length, t.replies?.[0]?.ours])));
  check('attention 空 —— 没有需要人看一眼的东西了', (f17?.attention?.length ?? -1) === 0,
    JSON.stringify(f17?.attention?.map((a) => a.why)));
  check('行号回退到 original_line（非 null）', f17?.inline?.every((t) => typeof t.line === 'number'),
    `实得 ${JSON.stringify(f17?.inline?.map((t) => t.line))}`);
  check('标记为 outdated', f17?.inline?.every((t) => t.outdated === true));
  check('引文非空且不以 diff 标记开头',
    f17?.inline?.every((t) => t.quote.length > 0 && !/^[+-]/.test(t.quote)),
    `实得 ${JSON.stringify(f17?.inline?.map((t) => t.quote.slice(0, 20)))}`);

  console.log('\n── R4 · 总批的 answered 取自本地记录，不是推断（review#29）──');
  const r18 = await call(client, 'read_comments', { pr: 18 });
  const f18 = r18.folders?.[0];
  check('conversation 恰好 2 条', f18?.conversation?.length === 2, `实得 ${f18?.conversation?.length}`);
  check('answered 只有 handled / pending', f18?.conversation?.every((c) => ['handled', 'pending'].includes(c.answered)),
    JSON.stringify(f18?.conversation?.map((c) => c.answered)));
  check('两条都没记过 → 都 pending，且**不会互相清掉**（旧位置推断的漏报洞）',
    f18?.conversation?.every((c) => c.answered === 'pending'),
    JSON.stringify(f18?.conversation?.map((c) => c.answered)));
  check('counts.needsReply = 2（如实报，不靠位置猜）', f18?.counts?.needsReply === 2, `实得 ${f18?.counts?.needsReply}`);
  check('counts 里已无 hasFollowUp', !('hasFollowUp' in (f18?.counts ?? {})), JSON.stringify(f18?.counts));
  check('attention 两条都带正文预览', (f18?.attention?.length ?? 0) === 2 && f18.attention.every((a) => a.preview.length > 0),
    JSON.stringify(f18?.attention?.map((a) => a.preview.slice(0, 18))));

  console.log('\n── mark_handled：本地记录，不碰 GitHub ──');
  const before = await call(client, 'read_comments', { pr: 18 });
  const firstId = before.folders[0].conversation[0].id;
  const marked = await call(client, 'mark_handled', { pr: 18, ids: [firstId] });
  check('如实汇报新增了 1 条', marked.added?.length === 1 && marked.added[0] === firstId, JSON.stringify(marked));
  const after = await call(client, 'read_comments', { pr: 18 });
  check('那条变 handled', after.folders[0].conversation[0].answered === 'handled',
    JSON.stringify(after.folders[0].conversation.map((c) => c.answered)));
  check('needsReply 少 1', after.folders[0].counts.needsReply === 1, `实得 ${after.folders[0].counts.needsReply}`);
  check('attention 少 1 条', after.folders[0].attention.length === 1, `实得 ${after.folders[0].attention.length}`);
  const again = await call(client, 'mark_handled', { pr: 18, ids: [firstId] });
  check('重复标记如实报 0 新增（不谎报）',
    again.added?.length === 0 && again.alreadyHandled?.length === 1 && again.refreshed?.length === 0, JSON.stringify(again));

  console.log('\n── 第一轮评审那几条高危，实机验一遍 ──');
  const strErr = await callRaw(client, 'mark_handled', { pr: 18, ids: [String(firstId)] });
  check('字符串 id 硬拒，不是静默 no-op 返回成功', strErr.isError === true && /正整数/.test(strErr.text), strErr.text?.slice(0, 90));

  const bothErr = await callRaw(client, 'mark_handled', { pr: 18, ids: [firstId], seed: true });
  check('seed 与 ids 同时给 → 拒（v1 是 seed 静默胜出、整折被标掉）', bothErr.isError === true && /只能给一个/.test(bothErr.text), bothErr.text?.slice(0, 90));

  const ghostErr = await callRaw(client, 'mark_handled', { pr: 18, ids: [999999999] });
  check('不在这折里的 id → 拒，并告诉去哪拿 id', ghostErr.isError === true && /没有这些总批/.test(ghostErr.text), ghostErr.text?.slice(0, 90));

  const dry = await call(client, 'mark_handled', { pr: 9, seed: true });
  check('seed 不带 confirm 只预览，dryRun=true', dry.dryRun === true && dry.targets?.length > 0, JSON.stringify(dry).slice(0, 140));
  check('预览里带正文，看得清将要标掉什么', dry.targets?.every((t) => t.preview?.length > 0), JSON.stringify(dry.targets?.[0]));
  const after9 = await call(client, 'read_comments', { pr: 9 });
  check('**预览没有落盘** —— #9 那条真待办还在', after9.folders[0].counts.needsReply === dry.wouldMark, `${after9.folders[0].counts.needsReply} vs ${dry.wouldMark}`);

  const undone = await call(client, 'mark_handled', { pr: 18, ids: [firstId], undo: true });
  check('undo 撤得掉（唯一的写操作必须有回退）', undone.removed?.length === 1, JSON.stringify(undone));
  const back = await call(client, 'read_comments', { pr: 18 });
  check('撤销后回到 pending', back.folders[0].conversation[0].answered === 'pending', JSON.stringify(back.folders[0].conversation.map((c) => c.answered)));
  check('read_comments 带 handledIds + stateFile，能查「这条我处理没有」',
    Array.isArray(back.folders[0].handledIds) && typeof back.stateFile === 'string', JSON.stringify(back.folders[0].handledIds));

  console.log('\n── R2 · list_folders ──');
  const open = await call(client, 'list_folders');
  check('open 列表非空', open.folders?.length > 0, `实得 ${open.folders?.length}`);
  check('每折都带 counts 两字段',
    open.folders?.every((f) => !f.ok || ['needsReply', 'unclear'].every((k) => typeof f.counts?.[k] === 'number')),
    JSON.stringify(open.folders?.map((f) => f.counts)));
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

  console.log('\n── 立项理由：省 context（第三轮评审实测退化过，钉住）──');
  const oneFolder = JSON.stringify(await call(client, 'read_comments', { pr: 22 })).length;
  const allOpen = JSON.stringify(await call(client, 'read_comments', {})).length;
  const triage = JSON.stringify(await call(client, 'list_folders', {})).length;
  console.log(`  单折 #22 ${oneFolder} B · 全部 open ${allOpen} B · 只分诊 ${triage} B`);
  check('单折体积没膨胀（截断总批正文之后）', oneFolder < 9000, `${oneFolder} B`);
  check('只分诊比读全部小一个量级 —— 「哪些折在等我」应该很便宜', triage * 3 < allOpen, `${triage} vs ${allOpen}`);
  const long = (await call(client, 'read_comments', {})).folders
    .flatMap((f) => f.conversation ?? []).filter((c) => c.bodyTruncated);
  check('超长总批被截断并标 bodyTruncated + bodyLength',
    long.every((c) => c.body.length < 700 && typeof c.bodyLength === 'number'),
    JSON.stringify(long.map((c) => [c.id, c.body.length, c.bodyLength])));

  console.log('\n── 反向判据：不该显示的东西别显示 ──');
  // 上一版 26 条判据全是「有没有显示出来」，于是 68% 噪音全绿交付（第三轮评审）。
  const r22 = (await call(client, 'read_comments', { pr: 22 })).folders[0];
  check('#22 那 4 条早回完的串不该再挂在 unclear（约定生效前发的回话没前缀）',
    r22.counts.unclear === 0, `unclear=${r22.counts.unclear}：${JSON.stringify(r22.attention?.map((a) => a.preview.slice(0, 24)))}`);

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
  rmSync(stateFile, { force: true });
  console.log(`\n${failed === 0 ? '实机验收全部通过。' : `实机验收有 ${failed} 条未过。`}`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('实机验收跑不起来：', e?.message ?? e);
  process.exit(1);
});
