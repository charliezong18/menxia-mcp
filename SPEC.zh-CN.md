[English](SPEC.md) · **中文**

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
| **读批注省 context** | 「读批注」现在是一串 `gh api` 调用加模型自行解析 threads 和 inline position，每次烧掉可观窗口。返回结构化 JSON 能把这块成本压到近零。**这是每次都在付的成本，所以它是头号理由** |
| **防并行互踩** | 2026-07-27 栽过一次——多个 session 同时动 `~/Developer/review`，切走对方分支、把暂存文件卷进别人的 commit。现在的对策是 CLAUDE.md 里一句「并行时各开 worktree」，又一条散文提醒。见 §4.2，机制是文件锁不是单进程 |
| **类型化入参** | 五段 body、slug、双语对能做成 schema 必填，漏参数当场被 MCP 层打回重试，而不是脚本跑到一半报错。真实但收益不大 |

**跨 harness 曾经排在第一，2026-07-29 降级为推测性收益。** 原论证是「skill 只活在 Claude Code 里，agy/CCD/Codex 都发不了折」，而重活正越来越多外包给 agy。Charlie 在评审里定了 agy 不用了、先专心 Claude、Codex「也许接下来、不急」——**于是这条收益今天没有消费者**。它没有变成假的，只是从「立刻兑现」变成了「将来某天可能兑现」，因此不再承担论证重量。上面三条足以支撑这个项目；如果哪天只剩这一条，就该重新评估。

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
monolingual: boolean?          这折是单语读物，免双语对；登记进 docs/.monolingual
```

返回：PR 号、PR URL、朱批台深链 `https://charliezong18.github.io/zhupi/?pr=<n>`、lint 报告。

**`docs` 传路径不传全文**，这是刻意的。同机运行，server 自己把文件拷进它管的 worktree，agent 全程不碰 `~/Developer/review`——互踩才真的堵死。全文经 tool 入参传递不但浪费 token，还会让 agent 保留「我可以自己写进那个仓」的心智模型。

拷入位置：`docs` 落 `docs/<basename>`；`assets` 落 `docs/assets/…`——源路径里出现 `/assets/` 就**保留它后面的整段**，否则用 basename。正文里按 `assets/` 打头的相对路径引用。

**`monolingual: true`（2026-07-31 补）**：往折自己的分支上的 `docs/.monolingual` **追加**本折的文档路径（不覆盖 —— 从 main 继承来的条目一条都不能丢，丢了那几折下次又被规则 1 判死），随折 merge 进 main，之后从 main 切的折自动继承。这与 `.payload` 同一个模型。

为什么补：D9 加了这个豁免，但**它从加上起一次都没能用上** —— 那是个仓内文件，而 `open_folder` 只把 `docs` 拷成 `docs/<basename>`，没有任何路径能创建或追加它。第三轮跨系统评审记过「登记表文件够不着」，当时归成理论问题；实际后果是 #31（22 章官制史）长期在巡检里报 22 条假硬伤 —— **一个开始报假红的检查，人就学会忽略它**。

（2026-07-30 修正：上一版写的是一律拍平成 `docs/assets/<basename>`。仓里真实布局有子目录——`docs/assets/shots/annotate.png` 等，而 `docs/zhupi-readme.md` 引用的正是 `assets/shots/setup.png`。zhupi 按文档自身所在目录解析（`render.js:27`），拍平会让这类引用变成断图，而规则 4 会把账算在文档头上、让人去改正文——改完同一篇在两折里说的话就不一样了。）

![呈折流程与它的失败分支](assets/open-folder.png)

图里橙色的三处是**刻意不阻断**的：分支基点落后只警告（阻断会把人逼向绕过闸门）、会话 id 探不到就不埋（绝不编）、body 回读失败也照样返回（PR 已经建了，瞒着更糟）。红色两处才是真正的中止。

### 3.2 `lint_folder` — 呈折前自查

```
docs:    string[]     本机绝对路径
assets:  string[]?
```

返回：结构化 findings[]，每条含 `severity: error | warn`、`rule`、`message`、`file`。规则清单见 §5.1。

**能查的规则少一条。** 现有 `folder-lint.sh` 是在奏折仓工作树里跑的，靠 `git diff origin/main...HEAD` 拿本折文档，因而能做「分支基点」检查。`lint_folder` 拿到的是散落在本机的路径、不在任何相关 git 树里，所以它只跑规则 1-4（双语对 / 互链头 / `.payload` 例外 / 断图）。**「分支基点」只在 `open_folder` 内部跑**——那时 server 已经有自己的 worktree，git 上下文齐备。这个差异要在 `lint_folder` 的返回里显式声明，否则会给出「体例合格」的假安心。

### 3.3 `audit_folders` — 存量巡检

```
（无入参）
```

返回：每折的体例缺口 + 回奏对标记 + draft 状态。**纯只读。**

**~~`fix`~~ —— 2026-07-30 实现时两件事都不能做，于是这个参数没有了。**

- **补回奏对标记**：只补得成**当前**会话的 id，而那不是呈这折的那个会话 —— 是编一个。与 [§4.4](#44-回奏对标记的探测)「探不到就不埋，绝不编；静默指错比没有更糟」直接矛盾，后果是按钮把 Charlie 送进一个不相干的会话。老脚本 `audit-folders.sh:38` 就是这么补的。
- **draft 转正**：GitHub REST 的 `PATCH /pulls/{n}` **不接受 `draft` 字段**，只能走 GraphQL 的 `markPullRequestReadyForReview`；而把 `POST /graphql` 放进写白名单等于开放全部 mutation（删仓、合折都走那一个端点），白名单当场失去意义。改成报一句 `gh pr ready <n>` 让人自己跑。

连带：`PATCH /pulls/{n}` 没有用户了，从写白名单删掉 —— **这个 server 总共只能发两种写请求**：建折、回话。

标记检查查的是**值**不是前缀：`<!-- happy-session: -->` 和格式不对的 id 在 zhupi 那边都渲染不出按钮（`link.js:88`），只查前缀等于报假绿。老脚本 `audit-folders.sh:32` 的 `grep -q 'happy-session:'` 就是这个毛病。

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
commentId: number     inline 根批注 id。**必填**
body:      string
```

走 `POST /pulls/{n}/comments/{id}/replies`，接成批注串而不是新开一条。首行的 `**回话**` 前缀由工具焊上（硬约定③），调用方不用自己写；首行是块级构造（围栏 / 列表 / 标题…）时前缀另起一段 —— zhupi 把 reply 正文整个过 markdown-it（`cards.js:48`），同一行会把代码块读成行内 code span。

**~~省掉 `commentId` 就是发总批~~ —— 这条 2026-07-30 作废（Phase 3 实现时）。** 当天 10:54 立的硬约定①（`guard-reply-body.sh`）禁止 agent 往会话区发总批：agent 发的总批与 Charlie 的在 API 里完全同形（共用账号），会变成 `list_folders` 里清不掉的假待办 —— 实测 13 条 `needsReply` 里 7 条是 agent 自己的话，多报 77%。守卫比本节新且有实测数据，按守卫来。折级小结**在聊天里说**，要留档的元数据写进 `docs/<slug>.md` 正文。

工具面上**根本没有发总批这个能力**（不是靠描述劝阻）：`WRITE_ALLOWED` 里就没有 `POST /issues/{n}/comments`。

另外两条 Phase 3 加的 —— **三个 PreToolUse hook 只挂在 Claude Code 的 Bash 工具上，MCP 调用从它们旁边过去**，那些闸门必须在这一侧再实现一遍，否则 Phase 3 的净效果是「把呈折搬到了一条没有闸门的新路上」：

- **已钦此/已关的折直接拒**（`guard-closed-folder` 那条）。2026-07-29 #23 实测：折已 merged 时 agent 照常回话，命令全部成功而结果是零。
- **`commentId` 若是一条 reply，自动换成它的根**。GitHub 会不会归一化未知，而万一不会，zhupi 会把它当孤儿另起一张没有引文的卡（`anchor.js:165`）。

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

- 锁 `~/Developer/review`（锁文件放仓外：`~/.zhupi-mcp/review.lock`）
- 每次 `open_folder` 在锁内开临时 worktree，用完即收
- 锁等待超时返回可读错误，让调用方知道是另一个 session 在呈折，而不是挂死

`worktree.ts` 是**唯一**碰 `~/Developer/review` 的模块。

**~~`flock`~~ —— 2026-07-30 实现时发现这台机器上没有。** 本节原文写的是 `O_EXLOCK | O_NONBLOCK`。实测 Node v25.2.1 的 `fs.constants` 里**没有 `O_EXLOCK`**（`O_*` 只有 RDONLY / WRONLY / RDWR / CREAT / EXCL / NOCTTY / TRUNC / APPEND / DIRECTORY / NOFOLLOW / SYNC / DSYNC / SYMLINK / NONBLOCK），macOS 也没有 `flock(1)` 可以 shell 出去。照着写会得到 `O_CREAT | O_RDWR | undefined | O_NONBLOCK` —— `undefined` 在按位或里当 0，**锁标志静默消失，得到一把永远锁不上的锁，而且全部测试照绿**。

现在的做法：`O_EXCL` 原子建锁文件，里面记 `{pid, at}`，三条判活任一成立就当陈旧可抢（内容读不出来 / pid 已死 / 超过陈旧阈值 —— **从 git 超时预算推导，不是写死的 5 分钟**：`staleMs()` = 3× 单次 git 调用超时 + 60s 余量，硬底 600s，判定时现算，所以调大 `ZHUPI_GIT_TIMEOUT_MS` 阈值跟着涨；一次合法持锁跨 fetch → commit → push 最坏可达 ~540s，旧的 300s 兜不住）。**崩溃后不死锁靠的是判活，不是内核放锁** —— 这条差别决定了必须有一条真 `SIGKILL` 持锁子进程的测试，而不是断言「应该能拿到」。

抢陈旧锁走 rename-aside，且三处必须成对存在（缺一条就会让两个进程同时进临界区，三条都是评审推演出来的，各配了一条接缝测试）：

| 防御 | 不做会怎样 |
|---|---|
| 拿到锁后回读确认 pid 是自己的 | 别人在建锁与回读之间挪走了它，我揣着一把不存在的锁往下走 |
| 挪走后核对挪到手的是刚才判陈旧的那一个 | B 判陈旧被调度走 → A 抢到并进入 → B 醒来挪走 A 的**有效**锁，两个人同时在里面 |
| 释放前确认锁还是自己的 | 我持锁超过 5 分钟（一次慢 push）被 B 抢走，我收工时一句 `rmSync` 删掉 B 的有效锁 |

跑 git 的子进程**必须带超时**（180 秒，env 可覆盖）：真机上 `commit.gpgsign=true` 会等 pinentry 弹窗、仓里的钩子也可能等输入，没有超时就是 server 永远挂着**而且锁还在手上**，别的会话跟着一起死。

![两个会话如何被锁串起来](assets/concurrency.png)

### 4.3 GitHub 接入

Octokit，token 从 `gh auth token` 现取，不另管一份 PAT——机器上 `gh` 早就认证好了，多一份 PAT 就多一个过期源。401 时重取一次再重试。

（zhupi 前端用 fine-grained PAT 是因为它跑在浏览器里，没有 `gh` 可用。两边不共享凭据，也不该共享。）

### 4.4 「回奏对」标记的探测

`happy-session-id.sh` 的原理是从自身进程沿 ppid 往上爬，拿每一级 pid 撞 `~/.happy/sessions.json` 里各会话记的 hostPid。

stdio 模式下 MCP server 是 Claude Code 的子进程，这条链**碰巧仍然成立**。但它脆：

- 非 Claude Code 的调用方根本没有 happy 会话，永远探不到
- `sessions.json` 只累加不清理（实测 114 条全标 running），陈旧记录的 hostPid 早被 OS 回收给别的进程，撞上就会给出**错的**会话 id

原脚本对此的处置是：命中后再验一句「这个 pid 现在跑的确实是 happy」。这条必须原样保留。

**策略：探不到就不埋，绝不编。** 按钮不出现而已；静默指错比没有更糟。另留 `sessionId` 入参给外部调用方显式传。

**这整节的分量在 2026-07-29 被调低了。** Charlie 的定性：「能回回，不能回，有这个文档在任何一个 agent 里也能讨论」——**真正的兜底是文档自包含，不是这个按钮**。所以 ppid 探测将来失效不算事故，也不值得为它加任何补偿机制（见 OPEN-QUESTIONS）。

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

## 7. Hook（Phase 0，**2026-07-28 已上线**）

`~/.claude/skills/review-loop/guard-pr-create.sh`，挂在全局 settings.json 的 `PreToolUse(Bash)`。命中即拒：

- `gh pr create` 冲着奏折仓去的
- `gh api -X POST .../pulls` 同上

两条判据：**① 命令段里点名了奏折仓；② 没点名，但 `cd` 进的目录（或会话 cwd）的 origin 是奏折仓**——第二条堵的是最可能的绕法「`cd <worktree> && gh pr create`」。读操作（`pr view` / `pr list` / GET pulls）和别的仓一概不拦。

拒绝信息指向当时的正确入口——现在指 `open-folder.sh`，Phase 4 后改指 MCP 工具。

**上线过程连踩三次误伤，每次都是同一个病根——把「字符串里出现」当成了「这条命令要执行」。全记在这，因为 MCP 版重写这段逻辑时会原样再踩一遍：**

1. **按命令段判，不按整串判。** 第一版扫整条命令字符串，`gh pr create -R 别的仓 && gh pr view -R 奏折仓` 被误拦——两个关键词分属不同段。改成按 `&& || ; |` 切段后逐段判。
2. **段首必须真是 gh 调用。** 第二版拦了守卫作者自己的 `git commit`——commit message 里写了那个命令名，而 cwd 恰好在奏折仓 worktree 里，两条判据凑齐。现在会先剥掉前导空白、env 赋值、`bash -c` 包壳、绝对路径前缀，再要求剩下的部分**以 `gh` 开头**。`git commit -m "...gh pr create..."`、`echo`、`grep` 全部放行。
3. **剥壳的 sed 必须用 `-E`。** BSD sed（macOS 自带）的基本正则不支持 `\|` 交替，写了那条规则等于完全失效——`bash -c '...'` 包壳绕过一路畅通，而且**静默**，只有测试能发现。`folder-lint.sh` 顶部专门警告过同一类坑，还是又踩了一次。

配套的 `guard-pr-create.test.sh` 有 21 条用例（10 条该拦 / 11 条不该拦），改守卫前先跑它。

![路由守卫的判定树](assets/guard.png)

图里标 (1)(2)(3) 的步骤，每一步都是被一次真实误伤逼出来的——**这棵树没有一个节点是设计出来的，全是撞出来的。**

这条独立于 MCP，先上先见效。它才是「更固定」的正解；MCP 是换载体，不是防绕过。

---

## 8. 落地顺序

| 阶段 | 内容 | 为什么这个顺序 |
|---|---|---|
| **0** ✅ | Hook 焊死路由（2026-07-28 已上线，见 §7） | 不依赖 MCP，立刻见效 |
| **1** | server 骨架 + `list_folders` + `read_comments` + `mark_handled` | 前两个**只读**；`mark_handled` 只写本地状态文件、不碰远端，可 `undo`。省 context 的收益马上兑现 |
| **2** | `lint_folder` + §5.2 differential test 对齐 | 检查逻辑先站稳，才敢让它管写入 |
| **3** | `open_folder` + `audit_folders` + `reply_comment` | 写入侧，含 flock/worktree/标记自核 |
| **4** | 脚本退休；SKILL.md 瘦成「名词表 + 指向工具」；hook 改指 MCP；**还 §5.3 #6 那笔文档账**（SKILL.md 体例表第 5 行与 `open-folder.sh` 第 27 行注释里「五段缺项也拦」是假的，改成「警告」） | 收尾 |

每阶段结束跑一次实机（真开一折 / 真读一次批注），不靠单测断言「能用」。

---

## 9. 风险

| 风险 | 处置 |
|---|---|
| 重写丢失既有修复 | §5.1 逐条实现清单 + §5.2 differential test |
| 跨 harness 今天没有消费者 | 已知并接受（§1）。项目靠另外三条收益立住；若哪天只剩这一条，重新评估 |
| ppid 探测在未来 Happy 版本失效 | 探不到就不埋（已有策略），失效表现为按钮消失，不会指错 |
| 公开仓泄露私有信息 | 本仓不含任何文档内容；`charliezong18/review` 仓名可配置，默认值写在 README 而非硬编码 |


### 5.4 刻意改进登记表（2026-07-30 补全，Phase 2 三轮评审后）

§5.2 说「是刻意改进就写进文档说清为什么」。实现时登记表漏了三处，全部是
「老的拦、新的放」这个**危险方向**（第二轮评审抓到）：

| 差异 | 老 | 新 | 为什么 |
|---|---|---|---|
| 首行带 BOM | 拦 | 放 | JS 的 `trim()` 按规范吃掉 U+FEFF |
| 首行 CRLF | 拦 | 放 | 同上，`trim()` 吃掉 `\r` |
| 首行尾随空格 | 拦 | 放 | 同上 |

这三处现在**无所谓了** —— 第三轮读 zhupi 源码发现互链头规则的立身理由是假的
（`lang.js` 只按文件名配对，从不读首行），判据已改成「链接目标解析后指对文件」，
写法差异一律降为警告。

**第三轮改掉的三条规则（都是与 zhupi 实际行为错位）**：

1. **规则 2 从「逐字符」改成「点得到对面」，硬伤降为警告**（写法差异那部分）。
   实测它正拦着 #12，而 #12 在朱批台上渲染完全正常。
2. **规则 4 的图片引用改成相对文档自身目录解析**，与 `zhupi/src/render.js:26` 一致。
   上一版一律按 `docs/` 拼 —— 子目录文档的图 **lint 说在、zhupi 显示断图**，方向是漏报。
3. **规则 1 新增 `docs/.monolingual` 登记豁免**。修掉老脚本的假通过 bug 之后规则 1
   第一次真正生效，于是 #31（22 章中国官制史）被判 22 条硬伤 —— 而没人会把它翻成英文。

**规则 5 的实测**（27 个双语对全量）：误报率 **0/27**，但判别力也接近 0 ——
中位数要漏译 40% 才报警，6 篇漏译 95% 都不报，且它结构上看不到单语文档
（29 个单语 slug 里 25 个是「中文躺在英文槽」）。阈值不用改（0 误报，当 warn 跑没成本），
但**别把它当「语言方向的保险」写进文档** —— 它目前只能抓「整篇一个字没翻」。

### 5.5 Phase 3 的刻意改进登记表（2026-07-30）

写入侧同样适用 §5.1「照实现移植」。下面每一条都是**新实现与老脚本行为不同**，
逐条写清为什么，免得日后被当成 bug 修回去。

| # | 老脚本 | 新实现 | 为什么 |
|---|---|---|---|
| 1 | lint 在分支已推上去之后跑 | **lint 卡在 commit 之后、push 之前** | `snapshot.ts` 读的是提交过的内容，不 commit 没得测；而在 push 前停住，不合格时远端一片干净。老脚本做不到 —— 它跑的时候分支早被人手推上去了 |
| 2 | `audit-folders.sh --fix` 补回奏对标记 | **不补** | 只补得成当前会话的 id，那是编一个（§3.3、§4.4） |
| 3 | `--fix` 把 draft 转正 | **只报，给命令** | REST 不支持，只能 GraphQL；开放 `POST /graphql` 等于开放全部 mutation |
| 4 | `guard-reply-body.sh` 对缺 `**回话**` 前缀的做法是**拒绝** | **焊死**（自动补） | 「文档写了照样能跳过，所以焊进动作本身」（§3.1 的同一条理由）。代价是块级构造要自己接住 —— 首行是围栏 / 列表时前缀另起一段 |
| 5 | 图一律落 `docs/assets/<basename>` | 源路径里有 `/assets/` 就**保留它后面整段** | 仓里真实布局是 `docs/assets/shots/*.png`，拍平会让既有文档的引用变断图，而规则 4 会把账算在文档头上 |
| 6 | 巡检 `grep -q 'happy-session:'` | 查标记的**值** | 前缀在、值不合格时 zhupi 渲染不出按钮，只查前缀是报假绿 |
| 7 | 分支已存在一律「换个 slug」 | **本地有 / 远端有分开说** | 「本地有、远端没有」唯一来源是上次崩在 push 之前，那时远端一片干净，正确动作是清掉重来而不是绕开 |
| 8 | `open-folder.sh` 写 `PARITY.md` 台账 | **不写** | 新工具不跑老 bash lint，没有可对账的东西 —— D1 的「连续 10 次」计数因此冻死。**当晚换了判据**（Charlie 拍板）：改成「九条规则各自的必失败样本都被新实现拦下」，跑 `npm run retire-gate`，九条逐条变异全部变红。见 [PARITY.md](PARITY.md) |
| 9 | `SKIP_LINT=1` 无条件关闸逃生口 | **没有** | 尚未决定。这个项目自己记着「拦太死把人逼向绕过闸门」，所以缺这个口子是个已知的账，不是设计 |
| 10 | 退休判据 = 连续 10 次呈折零分歧（D1） | **每条规则一个必失败样本**（`scripts/retire-gate.mjs`） | 老判据同日三头都断：样本没判别力（88% 的折两边都零硬伤）／被当权威的老脚本本身有假通过 bug（`folder-lint.sh:58`）／呈折搬进 MCP 之后计数冻死。新判据测的是「新实现真的在拦」，且规则被删被降级时当场变红 |

**8 已经解决**（当晚换判据，见第 10 行）。**9 还欠着** —— 逃生口的事没定。
**另有一件不在这张表里、也还欠着的：仓侧 CI**（BACKLOG ⑤：呈折闸门防手滑不防绕过，
实测 6 条旁路，真闭合只有把判据下移到 main 上一条路，但要先跟 Charlie 确认）。
