# zhupi-mcp — 御笔朱批的 agent 侧 MCP server

设计定稿 · 2026-07-28

配套产品：[`charliezong18/zhupi`](https://github.com/charliezong18/zhupi)（朱批台，人的一侧）。本仓是 agent 的一侧。

---

## 1. 为什么做

朱批循环的 agent 侧现在住在 `~/.claude/skills/review-loop/`：一份 8KB 的 SKILL.md 加四个 bash 脚本。2026-07-28 刚做过一轮加固——把体例从散文提醒变成脚本闸门，起因是实测「八折漏三折的回奏对标记、十一篇缺双语对」，结论是**文档提醒治不了漏执行**。

这轮要解决的是那次没解决的两件事。

**MCP 不解决「绕过」。** 闸门焊进脚本之后，剩下的漏洞是路由问题——模型可以不走那条路，直接手敲 `gh pr create`。换成 MCP 一样能绕。真正堵死路由的是 PreToolUse hook，见 §7。这两件事要分开做、分开算账，不能把 MCP 当成防绕过的手段。

**MCP 解决的是另外三件：**

| 收益 | 现状的痛 |
|---|---|
| **跨 harness** | skill 只活在 Claude Code 里。agy（Antigravity）、CCD、Codex 都发不了折——而研究型重活正越来越多外包给 agy |
| **读批注省 context** | 「读批注」现在是一串 `gh api` 调用加模型自行解析 threads 和 inline position，每次烧掉可观窗口。返回结构化 JSON 能把这块成本压到近零 |
| **类型化入参** | 五段 body、slug、双语对能做成 schema 必填，漏参数当场被 MCP 层打回重试，而不是脚本跑到一半报错 |

**加一件本来想算作收益、但实际要靠别的机制拿到的**：并行互踩。2026-07-27 栽过一次——多个 session 同时动 `~/Developer/review`，切走对方分支、把暂存文件卷进别人的 commit。现在的对策是 CLAUDE.md 里一句「并行时各开 worktree」，又一条散文提醒。见 §4.2，机制是文件锁不是单进程。

---

## 2. 范围

**做**：`open_folder`（呈折）、`lint_folder`（自查）、`audit_folders`（巡检）、`list_folders`（列折）、`read_comments`（读批注）、`reply_comment`（回话）。

**不做**：

- **钦此（squash merge）不做工具。** 那是 Charlie 在朱批台上点的动作，agent 侧没有理由持有这个能力。
- **交付后的记账不做工具**（tracker 编号、STATUS.md 在途表）——那些散落在不同 vault 位置，属于 skill 的散文职责，不适合固化成 schema。
- **不改 zhupi 前端。** 本仓与 `charliezong18/zhupi` 只通过 GitHub（PR body 约定、`<!-- happy-session: -->` 标记格式）耦合，不共享代码。

---

## 3. 工具面

统一约定：所有工具的错误返回**面向模型可执行**——「`docs/foo.md` 缺中文对子 `docs/foo.zh-CN.md`」这种，模型读完能直接自己修了重试，不返回 stack trace。

### 3.1 `open_folder` — 呈折

```
title:      string              奏折标题
body: {
  destination: string          目的地（进 vault / 发某仓 issue / 发邮件 …）
  directLink:  string?         直达链
  tldr:        string          TLDR
  decisions:   string          待你拍板
  howto:       string          怎么用
}
docs:       string[]           本机绝对路径，双语一对都要给
assets:     string[]?          本机绝对路径，正文引用的图
sessionId:  string?            覆盖用；不给则服务端自行探测，探不到就不埋
```

返回：PR 号、PR URL、朱批台深链 `https://charliezong18.github.io/zhupi/?pr=<n>`、lint 报告。

**`docs` 传路径不传全文**，这是刻意的。同机运行，server 自己把文件拷进它管的 worktree，agent 全程不碰 `~/Developer/review`——互踩才真的堵死。全文经 tool 入参传递不但浪费 token，还会让 agent 保留「我可以自己写进那个仓」的心智模型。

拷入位置固定：`docs` 落 `docs/<basename>`，`assets` 落 `docs/assets/<basename>`——正文里按 `assets/` 打头的相对路径引用，与现有仓内布局一致。

### 3.2 `lint_folder` — 呈折前自查

```
docs:    string[]     本机绝对路径
assets:  string[]?
```

返回：结构化 findings[]，每条含 `severity: error | warn`、`rule`、`message`、`file`。规则清单见 §5.1。

**能查的规则少一条。** 现有 `folder-lint.sh` 是在奏折仓工作树里跑的，靠 `git diff origin/main...HEAD` 拿本折文档，因而能做「分支基点」检查。`lint_folder` 拿到的是散落在本机的路径、不在任何相关 git 树里，所以它只跑规则 1-4（双语对 / 互链头 / `.payload` 例外 / 断图）。**「分支基点」只在 `open_folder` 内部跑**——那时 server 已经有自己的 worktree，git 上下文齐备。这个差异要在 `lint_folder` 的返回里显式声明，否则会给出「体例合格」的假安心。

### 3.3 `audit_folders` — 存量巡检

```
fix: boolean?    默认 false。true 时补机械可补的（回奏对标记、draft 转正）
```

返回：每折的体例缺口。双语缺口只报不补（要翻译，机器补不了）。

### 3.4 `list_folders` — 列折 / 「他批了吗」

```
state: "open" | "merged"    默认 open
```

返回：折号、标题、分支、**未回批注数**。

### 3.5 `read_comments` — 读批注

```
pr: number?    不给 = 扫全部 open 折
```

返回：

```
folders: [{
  number, title, headRefName,
  inline: [{ id, path, line, quote, body, inReplyToId, answered: boolean }],
  conversation: [{ id, body, author, answered: boolean }],
  unansweredCount: number
}]
```

**`answered` 由服务端算，不返回原始列表让模型自己判。** 「没有我方 reply 的 inline 批注 = 未处理」这个判断现在靠模型每次重新推，是最容易漏的一步。Charlie 在会话区整条列意见（不划行）也算批注，所以 `conversation` 同样带 `answered`。

### 3.6 `reply_comment` — 回话

```
pr:        number
commentId: number?    省略 = 发总批（conversation comment）
body:      string
```

省掉 `commentId` 就是发总批，不单开一个工具。给了 `commentId` 走 `POST /pulls/{n}/comments/{id}/replies`，接成批注串而不是新开一条。

---

## 4. 架构

Node 20 + TypeScript，`@modelcontextprotocol/sdk`，stdio transport。

### 4.1 装法

MCP 配置里写绝对路径：

```json
{ "command": "node", "args": ["/Users/charliezong/Developer/zhupi-mcp/dist/index.js"] }
```

**不用 `npm link`。** 2026-07-24 栽过——全局单指针被抢走，线上回退，收拾半天。全局单指针类操作一律不进这个项目。

奏折仓（默认 `charliezong18/review`）与本地 checkout 路径（默认 `~/Developer/review`）走环境变量 `ZHUPI_REVIEW_REPO` / `ZHUPI_REVIEW_PATH`，不硬编码——本仓是公开的。

### 4.2 并发：文件锁，不是单进程

**先纠正一个想当然：stdio 型 MCP server 是每个会话各起一个进程，不是共享常驻的**，所以它天然做不到跨 session 排队。要防互踩得靠：

- `flock` 锁 `~/Developer/review`（锁文件放仓外，如 `~/.zhupi-mcp/review.lock`）
- 每次 `open_folder` 在锁内开临时 worktree，用完即收
- 锁等待超时返回可读错误，让调用方知道是另一个 session 在呈折，而不是挂死

`worktree.ts` 是**唯一**碰 `~/Developer/review` 的模块。

### 4.3 GitHub 接入

Octokit，token 从 `gh auth token` 现取，不另管一份 PAT——机器上 `gh` 早就认证好了，多一份 PAT 就多一个过期源。401 时重取一次再重试。

（zhupi 前端用 fine-grained PAT 是因为它跑在浏览器里，没有 `gh` 可用。两边不共享凭据，也不该共享。）

### 4.4 「回奏对」标记的探测

`happy-session-id.sh` 的原理是从自身进程沿 ppid 往上爬，拿每一级 pid 撞 `~/.happy/sessions.json` 里各会话记的 hostPid。

stdio 模式下 MCP server 是 Claude Code 的子进程，这条链**碰巧仍然成立**。但它脆：

- agy 调用时根本没有 happy 会话，永远探不到
- `sessions.json` 只累加不清理（实测 114 条全标 running），陈旧记录的 hostPid 早被 OS 回收给别的进程，撞上就会给出**错的**会话 id

原脚本对此的处置是：命中后再验一句「这个 pid 现在跑的确实是 happy」。这条必须原样保留。

**策略：探不到就不埋，绝不编。** 按钮不出现而已；静默指错比没有更糟。另留 `sessionId` 入参给外部调用方显式传。

### 4.5 模块切分

| 模块 | 职责 | 依赖 |
|---|---|---|
| `lint.ts` | 体例检查，**纯函数**：吃文件清单 + git 信息，吐 findings[]。无 IO | 无 |
| `worktree.ts` | flock + 临时 worktree 生命周期。唯一碰 review 仓的地方 | fs, child_process(git) |
| `body.ts` | 五段 body 组装、标记焊入、**自核**回读 | github.ts |
| `session.ts` | ppid 爬取，探不到返回 null | fs, child_process(ps) |
| `github.ts` | Octokit 包装 | @octokit/rest |
| `index.ts` | tool 注册与入参校验，不含业务逻辑 | 全部 |

`lint.ts` 无 IO 是刻意的——它是规则最多、最需要密集单测的一块，把 IO 挡在外面才测得动。

---

## 5. 移植验收

zhupi 自己那次 vanilla JS → Preact 迁移的头号风险是「修过的东西悄悄丢失」，为此做了三轮逐条核实存活。这次重写同样适用。

### 5.1 照实现移植，不照文档移植

读完 `folder-lint.sh` 与 `open-folder.sh` 实现，**已确认三处文档与实现的漂移**——这是本条规矩的直接证据，移植时必须以下表的「实现真相」为准，另见 §5.3 已决事项。

| # | 规则 | SKILL.md 声称 | 实现真相 |
|---|---|---|---|
| 1 | 双语一对 | 「**先判原文语言再定方向**——对外草稿本来就是英文，反了就白翻」 | **只查两个文件都存在**，不查内容语言。方向判错完全不拦 |
| 2 | 互链头 | 英文版首行 `**English** · [中文](<slug>.zh-CN.md)`；中文版首行 `[English](<slug>.md) · **中文**` | 一致，逐字符匹配（`grep -qxF` / 锚定正则） |
| 3 | **`.payload` 例外** | **文档里没有这条** | `docs/.payload`（或 `.payload`）登记的「待发正文」免英文版互链头（加了会把那行一起贴进对外 issue）；但其中文版**必须**含「不要从本页复制」横幅，缺则报错 |
| 4 | 图一起搬 | 正文引用的 `assets/**` 必须真在仓里 | 一致，但只匹配 markdown 链接语法的引用，**HTML `<img src>` 不查**；且**不跳过代码块与 inline code**，见下 |
| 5 | 分支基点 | 「警告 + 列出已在 main 上的文档」 | 一致，刻意不阻断（阻断会把人逼向绕过闸门，pre-push 那次的教训） |
| 6 | PR body 五段 | 「**缺项也拦**」 | **只 `echo ⚠` 到 stderr，照开不误**。脚本第 27 行注释也写「缺项也拦」，与第 29 行代码自相矛盾 |
| 7 | 不许 draft | `audit-folders.sh --fix` 转正 | 一致 |

另外三处实现问题，移植时保留或明确改掉：

- **断图检查不跳代码块与 inline code——本折亲身踩到。** 这份 spec 第一次呈折就被 lint 拦下，报了两张「断图」，实际是正文里用来说明规则本身的字面量例子（写在 inline code 里）。一篇讲 lint 规则的文档过不了 lint，因为 lint 不认代码跨度。**TS 版扫图片引用前必须先剥掉 fenced code block 与 inline code**——这与 §5.3 #1 的语言检测用的是同一套剥离逻辑，应共用一个 helper。当时的绕法是改写正文措辞躲开字面量，那是权宜。
- `git fetch -q origin ... || true`：网络失败时**静默继续**，此时 `origin/main` 是陈旧的，基点检查基于旧数据得出结论。TS 版应至少把「fetch 失败、结论可能过期」作为 warn 报出来。
- 五段检查用 `grep -q "$sec"`，即**段名出现在 body 任何位置**即算通过，不要求是标题。TS 版应按标题匹配。

### 5.2 Differential test

拿现存的全部 open 折加一批故意造坏的样本（每条规则至少一个必失败用例），**老脚本与新 TS 各跑一遍，输出逐条对齐**。

有差异只有两种结局：是 bug 就修；是刻意改进就写进本文档说清为什么。目前已知的刻意改进有两处：**#1 加语言方向比例检测**（§5.3）、**#4 图片引用兼查 HTML `<img src>`**。**对不齐不许上线。**

顺带一个白拿的好处：macOS bash 3.2 没有 `mapfile`、没有关联数组这类坑在 TS 里根本不存在（`folder-lint.sh` 顶部专门注释了这点）。但这也意味着**不能照抄逻辑结构**——bash 版里那些 `while read` 子 shell 变量不回传的规避写法（第 74-77 行把 FAIL 写进临时文件再 grep 回来）在 TS 里是纯噪音，重写时逻辑要重新组织，因此更要靠 differential 兜底。

### 5.3 已决（2026-07-28 Charlie 拍板）

- **#1 语言方向：按比例查。** 先剥掉 fenced code block 与 inline code，再算剩余正文的中日韩字符占比——英文版 >30% 报错，中文版 <30% 报错（顺带能抓漏译）。选比例而非「出现成段中文即报错」，是因为术语表、专名、中英混排的行撑不到阈值，误伤基本躲得开；而整篇翻反了必被抓。**这是相对现有脚本的收紧**，在 differential test 里属于「刻意改进」，见 §5.2。

- **#6 五段缺项：警告，不拦。** 即代码是对的，**错的是文档**——SKILL.md 体例表第 5 行与 `open-folder.sh` 第 27 行注释都把它写成了「拦」。理由：body 段落是给人读的，缺了不会像双语对那样直接搞坏 zhupi 的功能；而拦得太死会把人逼向绕过闸门（pre-push 那次的教训）。**这不属于移植工作，是一笔欠账的文档修正**，进 §8 Phase 4 一并还。

---

## 6. 测试

- **`lint.ts` 单测（vitest）**：§5.1 每条规则至少一个通过用例 + 一个必失败用例。这是唯一强制覆盖的模块。
- **Differential test**：§5.2，作为一次性上线闸门保留在仓里，可重跑。
- **`body.ts` 自核路径**：`gh` 有静默吞 body 的前科（`open-folder.sh` 第 42-45 行专门为此写了回读校验），须有一个 mock 掉「创建成功但 body 丢了」的用例。
- **`session.ts`**：陈旧 hostPid 撞到别的进程时必须返回 null 而不是那个 id。
- 不追求 `github.ts` / `worktree.ts` 的高覆盖——它们薄且重 IO，靠上面三块和实机跑一遍站住。

---

## 7. Hook（Phase 0，不依赖本仓）

PreToolUse on Bash，命中即拒：

- `gh pr create` 且目标是 `charliezong18/review`
- 直接 `gh api -X POST .../repos/charliezong18/review/pulls`

拒绝信息指向当时的正确入口——Phase 0 时指 `open-folder.sh`，Phase 4 后改指 MCP 工具。

这条独立于 MCP，先上先见效。它才是「更固定」的正解；MCP 是换载体，不是防绕过。

---

## 8. 落地顺序

| 阶段 | 内容 | 为什么这个顺序 |
|---|---|---|
| **0** | Hook 焊死路由 | 不依赖 MCP，立刻见效 |
| **1** | server 骨架 + `list_folders` + `read_comments` | **只读、零风险**，省 context 的收益马上兑现 |
| **2** | `lint_folder` + §5.2 differential test 对齐 | 检查逻辑先站稳，才敢让它管写入 |
| **3** | `open_folder` + `audit_folders` + `reply_comment` | 写入侧，含 flock/worktree/标记自核 |
| **4** | 脚本退休；SKILL.md 瘦成「名词表 + 指向工具」；hook 改指 MCP；**还 §5.3 #6 那笔文档账**（SKILL.md 体例表第 5 行与 `open-folder.sh` 第 27 行注释里「五段缺项也拦」是假的，改成「警告」） | 收尾 |

每阶段结束跑一次实机（真开一折 / 真读一次批注），不靠单测断言「能用」。

---

## 9. 风险

| 风险 | 处置 |
|---|---|
| 重写丢失既有修复 | §5.1 逐条实现清单 + §5.2 differential test |
| agy 侧能否挂 MCP 未经验证 | Phase 1 结束时实测一次；挂不上则跨 harness 这条收益作废，需重估 Phase 3-4 是否还值得 |
| ppid 探测在未来 Happy 版本失效 | 探不到就不埋（已有策略），失效表现为按钮消失，不会指错 |
| 公开仓泄露私有信息 | 本仓不含任何文档内容；`charliezong18/review` 仓名可配置，默认值写在 README 而非硬编码 |
