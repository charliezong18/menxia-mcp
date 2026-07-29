[English](design.md) · **中文**

# Phase 1 设计 —— 只读工具

> 三段走的第二段。上一段 [requirements](requirements.zh-CN.md) 已于 2026-07-29 钦此定稿（#19，零批注）。
> 这份回答**「怎么建」**，不重复「什么才算对」。下一段才拆 task。

## 0. 写在最前：requirements 撞到了一堵墙

R4 说「**没有我方 reply 的批注 = 未回**」。写 design 时实测发现：

**agent 和 Charlie 用同一个 GitHub 账号。** `gh auth token` 拿到的就是 `charliezong18`，所以「他的批注」和「我的回话」在 API 里作者字段**完全一样**（#18 两条总批实测，都是 `charliezong18`）。

**「我方」在数据里根本不存在。** R4 没错，只是它假设了一个不成立的前提。§3 是这份 design 的核心，专门解决它。

---

## 1. 模块边界

Phase 1 只建 [SPEC §4.5](../../SPEC.zh-CN.md) 的一个子集，外加一个 SPEC 里没有的新模块。

| 模块 | 职责 | 有 IO 吗 |
|---|---|---|
| `src/index.ts` | MCP server 装配、两个 tool 的注册与入参校验。**不含业务逻辑** | 否 |
| `src/config.ts` | 读 `ZHUPI_REVIEW_REPO`，缺省 `charliezong18/review` | 否 |
| `src/github.ts` | Octokit 包装 + 认证。**唯一碰网络的地方** | 是 |
| `src/threads.ts` | **纯函数**：扁平 comment 列表 → 还原批注串 + 判定 answered | 否 |
| `src/errors.ts` | 失败 → 面向模型可执行的话（R6） | 否 |

`threads.ts` 无 IO 是刻意的：它承载 R4 的全部语义，是唯一需要密集单测的模块，把网络挡在外面才测得动。

**SPEC §4.5 里的 `lint.ts` / `worktree.ts` / `body.ts` / `session.ts` 这一阶段一个都不建。**

---

## 2. 数据流：两个工具共用一条路径

```
readFolder(pr) ──▶ { inline[], conversation[], unansweredCount }
                      │
      ┌───────────────┴───────────────┐
      ▼                               ▼
 list_folders                    read_comments
 （只投影出计数）                （返回全量）
```

**共用是刻意的。** R2 要求「未回数与人工数一致（见 R4）」——两个工具若各算各的，判定逻辑迟早分叉，而分叉之后 `list_folders` 说有 3 条未回、`read_comments` 只列出 2 条，这种矛盾极难发现。

**N+1 的取舍**：`list_folders` 要带未回数，就必须读每一折的 comments。open 折约 10 个 → 约 1 + 2×10 = 21 次 REST 调用。**接受**，理由：个人尺度、不在热路径、换 GraphQL 一把梭要引入 schema 维护成本。折数上百了再说。

---

## 3. R4 的实现 —— 本设计最该被质疑的部分

账号共用之下，「谁发的」这条线索作废。两种数据形态得分开解决。

### 3.1 inline 批注：靠**串结构**，不靠作者

- 根批注 = `in_reply_to_id` 为空
- 回话 = `in_reply_to_id` 指向某条根批注
- **判定：一条根批注下面挂了至少一条 reply → 已回**

**这个判定完全不看作者，所以账号共用不影响它。** 实测 #17 有 4 条 inline、其中 2 条是 reply，串结构真实可用。

**已知失效**：Charlie 自己 reply 自己（追加说明）→ 被误判为已回。可接受——他追加说明时通常本来就在等我答，而代价只是漏看一条，不是答错。

### 3.2 会话区总批：没有串结构，只能靠**顺序**近似

- **判定：他的某条总批之后还存在另一条总批 → 视为已回**

**这是近似，不是判定。** 它多数时候对，因为实际节奏就是「他发一条 → 我回一条」的交替。

**已知失效**：他连发两条 → 第一条被误判为已回。**这是真漏，会让我看不见他的第一条意见**，比 3.1 那个失效严重得多。

**所以总批的 `answered` 不返回 `true`/`false` 两态，而是三态**：

| 值 | 含义 |
|---|---|
| `false` | 后面没有任何总批 —— 确定未回 |
| `"inferred"` | 后面有总批，**推测已回，但账号共用使这条无法确证** |
| `true` | 这一阶段永不返回（要等 §3.3 的标记落地） |

**把不确定性显式暴露出来，而不是伪装成确定。** 调用方看到 `inferred` 就知道该扫一眼原文，看到 `false` 就知道必须处理。

### 3.3 根治留给 Phase 3

`reply_comment` 发总批时埋一个不可见标记（`<!-- zhupi-mcp:reply -->`，沿用回奏对标记的做法）。从那以后总批也能精确判定，三态收敛回两态。

Phase 1 是只读的，埋不了标记，所以只能近似。**存量的历史总批则永远只能靠顺序**——这是没法追溯修复的，写在这里免得将来当成 bug 去查。

---

## 4. 返回形状

### `list_folders`

```
入参：state?: "open" | "merged"     默认 open
返回：{
  folders: [{
    number, title, headRefName,
    unanswered: { inline: number, conversation: number, inferred: number }
  }]
}
```

未回数拆成三个而不是一个总数：`inline` 是确定的，`conversation` 是确定未回的，`inferred` 是拿不准的。**把一个总数拆开，是为了不让不确定的部分混进确定的部分。**

### `read_comments`

```
入参：pr?: number                   不给 = 扫全部 open 折
返回：{
  folders: [{
    number, title, headRefName, headSha,
    inline: [{
      id, path, line, quote, body, createdAt,
      replies: [{ id, body, createdAt }],
      answered: boolean
    }],
    conversation: [{ id, body, author, createdAt, answered: false | "inferred" }],
    unansweredCount: number
  }]
}
```

**inline 用嵌套 `replies` 而不是扁平数组 + `inReplyToId`。** 串结构由服务端还原好，模型拿到就是树。这是 R3「不需要再解析、再推理」的直接落实，**也是对 [SPEC §3.5](../../SPEC.zh-CN.md) 那个扁平形状的收紧**——原形状仍然要求模型自己按 `inReplyToId` 拼树。

**引文（`quote`）**：取 GitHub comment 自带的 `diff_hunk` 的最后一行，那就是被锚定的那行源文本。**已知限制：只有一行。** Charlie 可能划的是半句或跨行，拿到的是整行。够用，因为批注正文通常自带上下文；不够时还有 `path:line` 可回查。

---

## 5. 认证（R5）

**懒取，不在启动时取。** 第一次真正需要时才跑 `gh auth token`，结果缓存在内存里。401 → 重取一次 → 再 401 就报 §6 的话。

启动时取会让「装上了但这次没用到」的会话也依赖 `gh` 可用——server 在每个 Claude Code 会话都会起，代价白付。

---

## 6. 错误（R6）

四种，每种一句话，**不带 token、不带 stack trace**：

| 情形 | 返回 |
|---|---|
| 拿不到 gh 认证 | 「拿不到 GitHub 认证。跑 `gh auth login` 后重试。」 |
| 仓不存在或无权限 | 「读不到 `<repo>`。确认仓名对、且当前 gh 账号有权限。」 |
| 折号不存在 | 「`<repo>` 里没有 #`<n>`。用 `list_folders` 看现有折号。」 |
| 网络失败 | 「连不上 github.com：`<原因>`。网络恢复后重试。」 |

---

## 7. 只读怎么保证（R7）

不靠自觉，靠两道：

1. **`github.ts` 只暴露 GET 方法**，不封装任何 POST/PATCH/PUT/DELETE。
2. **一条会失败的测试**：扫 `src/` 源码，出现非 GET 的 Octokit 调用即测试失败。

第二条是重点——R7 是个「不发生什么」的要求，而**不发生的事没法靠观察验证**，只能靠一条主动去找它的测试。

---

## 8. 测试策略

| 对象 | 怎么测 |
|---|---|
| `threads.ts` | 纯函数单测：inline 已回 / 未回 / 自己回自己；总批交替 / 连发两条 / 单条；空输入 |
| `errors.ts` | 四种映射各一条 |
| 只读守卫 | §7 第二条 |
| 实机 | 对 **#18** 跑一次 → `unanswered` 应为 0（R3 明写的验收）；对 **#19** 跑一次（已 merged、零批注）|

`github.ts` 不追高覆盖——它薄且重 IO，靠实机那一趟站住。

---

## 9. 非目标

不做缓存、不做分页优化、不做 GraphQL、不做并发请求控制。这四样都是「折数上百」才出现的问题，现在做等于为不存在的规模付复杂度。
