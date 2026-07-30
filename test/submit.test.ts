import { describe, it, expect } from 'vitest';
import { slugOf, withReplyPrefix, deskUrl, REPLY_PREFIX } from '../src/submit.js';
import { assetTarget } from '../src/worktree.js';
import { handleTool, TOOLS } from '../src/tools.js';

// 这一层第二轮评审存活过 7 个变异，原因是它的**行为**只被 `npm run acceptance` 护着，
// 而那个要联网 + 真仓，不在 `npm test` 里。写入侧三个工具不重复那个洞：
// 纯函数与入参校验全部在这儿钉住，它们跑在任何网络调用之前。

describe('slugOf：分支名与文件名同源', () => {
  it('剥 .md 与 .zh-CN.md', () => {
    expect(slugOf('/x/y/phase-3-tasks.md')).toBe('phase-3-tasks');
    expect(slugOf('/x/y/phase-3-tasks.zh-CN.md')).toBe('phase-3-tasks');
  });

  it('中文名照样处理（#31 那折 22 篇是中文名）', () => {
    expect(slugOf('/x/官制-第一章.zh-CN.md')).toBe('官制-第一章');
  });

  // `.zh-CN.md` 必须先剥。先剥 `.md` 的话会剩下 `x.zh-CN`，
  // 两半文档得到两个不同的分支名 —— 而它们必须进同一折。
  it('两半文档得到同一个 slug', () => {
    expect(slugOf('/a/foo.md')).toBe(slugOf('/b/foo.zh-CN.md'));
  });
});

describe('回话前缀焊死（硬约定③）', () => {
  it('没盖就补上，且**同一行**', () => {
    const out = withReplyPrefix('采纳，已改。');
    expect(out).toBe(`${REPLY_PREFIX} 采纳，已改。`);
    expect(out.split('\n')[0]).toContain('采纳');
  });

  it('已经盖了就不重复补', () => {
    expect(withReplyPrefix('**回话** 采纳')).toBe('**回话** 采纳');
  });

  // 朱批台自己已有 `回话 · <login>` 标签，reply 正文又走 markdown 渲染 ——
  // `**回话**\n\n正文` 会渲染出独占一行的加粗「回话」，在他 300px 宽的批注栏里是三层重复。
  it('绝不产生独占一行的「回话」', () => {
    expect(withReplyPrefix('正文')).not.toMatch(/^\*\*回话\*\*\s*\n/);
    expect(withReplyPrefix('\n\n  正文')).toBe(`${REPLY_PREFIX} 正文`);
  });

  it('多行正文只动第一行', () => {
    expect(withReplyPrefix('采纳。\n\n具体是……')).toBe(`${REPLY_PREFIX} 采纳。\n\n具体是……`);
  });
});

describe('主输出是朱批台深链，不是 PR 链接', () => {
  it('deskUrl 指向朱批台', () => {
    expect(deskUrl(36)).toBe('https://charliezong18.github.io/zhupi/?pr=36');
  });

  it('工具描述里明写别拿 PR 链接当主输出（2026-07-27 踩过）', () => {
    const d = TOOLS.find((t) => t.name === 'open_folder')!.description;
    expect(d).toContain('朱批台深链');
    expect(d).toContain('别当主输出');
  });
});

describe('open_folder 入参校验（跑在任何网络/文件动作之前）', () => {
  const ok = {
    title: '读物：x',
    body: { destination: 'a', tldr: 'b', decisions: 'c', howto: 'd' },
    docs: ['/tmp/x.md'],
  };

  it('未知入参直接拒', async () => {
    await expect(handleTool('open_folder', { ...ok, files: ['/tmp/x.md'] })).rejects.toThrow(/只认/);
  });

  // 拼错一个 body 键的后果是**那一段静默消失**，而缺段只警告不拦 ——
  // 于是折照样呈上去、他照样看不到「待你拍板」。所以 body 的键也要挡。
  it('body 的键拼错也拒（缺段只警告不拦，静默消失最糟）', async () => {
    await expect(handleTool('open_folder', { ...ok, body: { ...ok.body, decision: 'c' } }))
      .rejects.toThrow(/只认/);
  });

  it('docs 不是绝对路径 —— 拒', async () => {
    await expect(handleTool('open_folder', { ...ok, docs: ['docs/x.md'] })).rejects.toThrow(/绝对路径/);
  });

  it('docs 空数组 / 不是数组 —— 拒', async () => {
    await expect(handleTool('open_folder', { ...ok, docs: [] })).rejects.toThrow(/docs/);
    await expect(handleTool('open_folder', { ...ok, docs: '/tmp/x.md' })).rejects.toThrow(/字符串数组/);
  });

  it('body 不是对象 —— 拒，并说清该长什么样', async () => {
    await expect(handleTool('open_folder', { ...ok, body: 'TLDR: x' })).rejects.toThrow(/destination/);
  });

  it('title 空 —— 拒', async () => {
    await expect(handleTool('open_folder', { ...ok, title: '   ' })).rejects.toThrow(/title/);
  });
});

describe('reply_comment：总批那条路已经关了（C3）', () => {
  it('省掉 commentId —— 拒，且告诉他小结该去哪说', async () => {
    const e = await handleTool('reply_comment', { pr: 1, body: 'x' }).catch((err: unknown) => err);
    const msg = String((e as Error).message);
    expect(msg).toContain('commentId');
    expect(msg).toContain('聊天里说'); // 替代动作要说清，否则模型会换个写法重试
  });

  it('body 空 —— 拒', async () => {
    await expect(handleTool('reply_comment', { pr: 1, commentId: 2, body: '  ' })).rejects.toThrow(/body/);
  });

  it('未知入参 —— 拒', async () => {
    await expect(handleTool('reply_comment', { pr: 1, commentId: 2, body: 'x', prefix: false }))
      .rejects.toThrow(/只认/);
  });

  it('工具面上没有「发总批」这个能力（不是靠描述劝阻，是根本没有）', () => {
    const schema = TOOLS.find((t) => t.name === 'reply_comment')!.inputSchema;
    expect(schema.required).toContain('commentId');
    expect(JSON.stringify(TOOLS)).not.toContain('issues/{issue_number}/comments');
  });
});

describe('audit_folders：纯只读', () => {
  it('不收任何入参', async () => {
    await expect(handleTool('audit_folders', { fix: true })).rejects.toThrow(/只认/);
  });

  it('工具面上没有 fix —— 补标记会编一个会话 id，draft 转正 REST 不支持', () => {
    const t = TOOLS.find((x) => x.name === 'audit_folders')!;
    expect(Object.keys(t.inputSchema.properties)).toEqual([]);
    expect(t.description).toContain('只读');
  });
});

// ── 三轮评审（2026-07-30）之后补的 ──

describe('回话前缀不能毁掉块级 markdown（第三轮：zhupi 走 markdown-it 渲染 reply）', () => {
  // `**回话** ` + 一行围栏 = 行内 code span，代码块整段糊成一段话。
  it('首行是围栏 / 列表 / 标题 / 引用 / 表格 —— 前缀另起一段', () => {
    for (const body of ['```ts\nconst x = 1;\n```', '- 第一条\n- 第二条', '## 小标题', '> 引文', '| a | b |']) {
      expect(withReplyPrefix(body), body).toBe(`${REPLY_PREFIX}\n\n${body}`);
    }
  });

  it('普通首行仍然同一行（300px 栏里别三层重复）', () => {
    expect(withReplyPrefix('采纳，已改。')).toBe(`${REPLY_PREFIX} 采纳，已改。`);
    expect(withReplyPrefix('`inline code` 开头也算普通行')).toBe(`${REPLY_PREFIX} \`inline code\` 开头也算普通行`);
  });
});

describe('图落到哪个路径（第三轮：奏折仓真实布局是 docs/assets/<子目录>/…）', () => {
  it('源路径里有 /assets/ —— 保留它后面整段', () => {
    expect(assetTarget('/local/imgs/assets/shots/setup.png')).toBe('docs/assets/shots/setup.png');
    expect(assetTarget('/a/assets/x/y/z.png')).toBe('docs/assets/x/y/z.png');
  });

  it('没有 /assets/ —— 退回 basename（与老行为一致）', () => {
    expect(assetTarget('/tmp/p.png')).toBe('docs/assets/p.png');
  });

  it('取**最后**一个 /assets/，不是第一个', () => {
    expect(assetTarget('/x/assets/old/assets/new/p.png')).toBe('docs/assets/new/p.png');
  });
});
