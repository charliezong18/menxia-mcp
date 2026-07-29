<div align="center">

[English](README.md) · **中文**

# zhupi-mcp

**[御笔朱批](https://github.com/charliezong18/zhupi)的 agent 侧，做成 MCP server。**<br>
朱批是人读 AI 写的长文档、划句留批注的地方。这个仓是那个循环的另一头：agent 用来呈上文档、读回批注、逐条回话的那套工具。

[设计定稿](SPEC.zh-CN.md) · [里程碑](MILESTONES.zh-CN.md) · [Backlog](BACKLOG.zh-CN.md) · [zhupi 本体](https://github.com/charliezong18/zhupi)

</div>

---

## 状态：Phase 1 已上线（两个只读工具）

**能装、能用。** `list_folders` 与 `read_comments` 已实现并挂进 MCP 配置，96 条单测 + 38 条实机断言全绿，实机跑的是真 GitHub 数据。

实测省下的上下文（对比原来那串 `gh api`）：读单折 **7.1×**，读全部 open 折 **3.9×**（41 KB → 5.8 KB）。这是建这东西的头号理由，数字站得住。

尚未实现：`open_folder`（呈折）、`lint_folder`、`audit_folders`、`reply_comment` —— 见 [MILESTONES](MILESTONES.zh-CN.md) 的 Phase 2/3。

**另有一块早就上线且不属于 server**：拒绝对奏折仓裸 `gh pr create` 的[路由守卫](SPEC.zh-CN.md)。它住在 review-loop skill 里，刻意先上——理由见下面「MCP 治不了什么」。

装法：
```json
{ "mcpServers": { "zhupi": { "command": "node", "args": ["<repo>/dist/index.js"] } } }
```
先 `npm install && npm run build`。认证借机器上已有的 `gh`，不需要另配 PAT。

进度与未决：[MILESTONES](MILESTONES.zh-CN.md) · [OPEN-QUESTIONS](OPEN-QUESTIONS.zh-CN.md)

## 为什么做

这个循环的 agent 侧本来就能跑，住在 `~/.claude/skills/review-loop/` 这个 skill 里：一份 8KB 的散文加四个 bash 脚本。2026-07-28 刚加固过一轮，起因是实测到底漏了什么——八次呈折有三次漏掉必须埋的标记，十一篇文档没带翻译对子。结论是散文提醒治不了漏执行，只有闸门能，于是规则搬进了脚本。

那修好的是规则，没修另外三件：

| | 痛在哪 |
|---|---|
| **跨 harness** | Claude Code 的 skill 只在 Claude Code 里存在。别的 agent 运行时——Antigravity、Codex、桌面端——根本呈不了折 |
| **读回来的 context 成本** | 「读批注」是一串 `gh api` 加模型手工解析 threads 和 inline position，每次都要重来一遍。结构化 JSON 能把它压成一次调用 |
| **入参没有类型** | 必填项写在散文里。漏了要等 shell 脚本跑到一半死掉才知道，而不是调用当场 |

## MCP 治不了什么

这条得说白，因为它正是最容易想当然的地方：**MCP server 拦不住 agent 绕过它。** 模型照样能直接 shell 出去敲 `gh pr create`，把所有闸门跳过。把逻辑从 bash 搬到 TypeScript，换的是实现，不是路由。

堵路由的是一个 `PreToolUse` hook——拒绝对奏折仓的裸 `gh pr create`。那是十行配置，独立于本仓，而且先上（[SPEC §7](SPEC.zh-CN.md)）。

这个区分就是这份 spec 存在的理由。如果你也在考虑同一件事，先想清楚你手上的到底是哪个问题。

## 工具面

六个，**打 ✅ 的两个已上线**。merge 刻意不在其中——那是人在 app 里点的。

| 工具 | 干什么 |
|---|---|
| `open_folder` | 呈折全流程：开分支、commit、push、开 PR、焊入回跳标记、回读自核 |
| `lint_folder` | 呈折前查体例 |
| `audit_folders` | 把已经开着的全扫一遍，报缺口 |
| `list_folders` ✅ | 列出所有折，按最近活动排序，带计数与待看正文预览 |
| `read_comments` ✅ | 把批注读成结构化 JSON，作者判定与 answered 由服务端算好 |
| `reply_comment` | 回一条批注，或发一条总批 |

## 怎么工作

![循环全景](assets/loop.png)

**正中间那个仓就是全部接口。** 两侧谁也不调谁，各自只跟 GitHub 说话。所以朱批台随时可以摘掉，而这个 server 也可以换回 bash 脚本而人那边毫无察觉。

Node + TypeScript，stdio transport，按绝对路径安装——不碰任何全局 npm 状态。GitHub 认证直接借 `gh auth token`，不另管一份 PAT。

## 已知边界

丑话说在前面：

- **防并发靠的是文件锁，不是排队。** stdio 型 MCP server 是每会话一个进程，不是共享常驻服务，自己做不到跨 session 串行。`flock` 加一个用完即弃的 worktree 能办成事，但机制得先说清楚，别按「常驻单进程」去想。
- **回跳标记是尽力而为。** 它靠爬进程树探测，只在调用方是宿主 CLI 的后代时才成立。探不到就什么都不埋——静默指错比没有按钮更糟。
- **风险集中在 lint 重写上。** 现有 bash 检查里沉淀了一批修复，重写最容易把它们悄悄丢掉。[SPEC §5](SPEC.zh-CN.md) 逐条记录了每道规则的**实际行为**（有三处与它自己的文档不符），并要求上线前跑 differential test 跟旧脚本逐条对齐。
- **按个人尺度设计。** 一个评审人、一个奏折仓，没有多租户的打算。

## Fork 去用

奏折仓名和本地 checkout 路径是配置，不是常量：

```
ZHUPI_REVIEW_REPO=<owner>/<repo>     默认 charliezong18/review
ZHUPI_REVIEW_PATH=<path>             默认 ~/Developer/review
```

工具强制的那些约定——双语对、互链头、PR body 五段——是一个人的体例。fork 过去改掉就是；它们是一个模块里的规则，不是散落在代码各处的隐含假设。

## 许可

[MIT](LICENSE) © Charlie Zong
