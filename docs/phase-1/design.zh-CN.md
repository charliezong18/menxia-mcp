[English](design.md) · **中文**

# Phase 1 设计 —— 只读工具

> 三段走的第二段。上一段 [requirements](requirements.zh-CN.md) 已于 2026-07-29 画可（#19）。
> 本文 v2：2026-07-29 经两轮独立对抗性评审重写，§3 与 §4 的结论**与 v1 相反**，见 §0.2。

## 0. 写在最前

### 0.1 requirements 撞到的墙

R4 说「**没有我方 reply 的批注 = 未回**」。但 **agent 和 Charlie 用同一个 GitHub 账号**（`gh auth token` 拿到的就是 `charliezong18`），API 里作者字段完全一样（#18 两条判实测，都是他）。**「我方」在数据里不存在。**

### 0.2 v1 错在哪（双 review 的结论）

v1 认定「谁发的」这条线索彻底作废，于是 inline 靠「有没有 reply」、判靠「后面有没有别的判」。两个独立评审各自查出三条高危，根因同一个：**v1 的数据模型里没有「我方回话」这个概念，而 R3/R4 有。**

实测推翻了 v1 的前提：**inline 侧存在可靠判别信号**（§3.0）。判侧确实没有，但 v1 的近似方式会**常态谎报**（§3.2）。

三条被真数据打掉的具体结论：

| v1 的说法 | 真数据 |
|---|---|
| 「对 #18 跑一次，未回数应为 0」 | 按 v1 规则算必然是 1，这条验收判据不可满足 |
| 判「后面还有 → 已回」够用 | **最后一条判几乎永远是我方回话**，会被判成他的未回批注。有判的 3 折里 2 折会常态挂一条我自己写的字当待办 |
| inline 的 `line` 直接用 | **实测 100% 为 null**，真值在 `original_line` |

---

## 1. 模块边界

| 模块 | 职责 | 有 IO 吗 |
|---|---|---|
| `src/index.ts` | MCP server 装配、两个 tool 的注册与 schema 校验。**不含业务逻辑** | 否 |
| `src/config.ts` | 读 `ZHUPI_REVIEW_REPO`，缺省 `charliezong18/review` | 否 |
| `src/github.ts` | GitHub 取数 + 认证。**唯一碰网络的地方**，只导出 GET | 是 |
| `src/threads.ts` | **纯函数**：原始 payload → 批注串 + 作者判定 + answered | 否 |
| `src/folders.ts` | `readFolder` 组装：把 `github.ts` 的原始数据喂给 `threads.ts`，产出 §4 的形状 | 否（吃传入的数据） |
| `src/errors.ts` | 判别式联合 `AuthError \| RepoError \| NotFoundError \| NetworkError` → 一句话 | 否 |

`readFolder` **落在 `folders.ts`，不落在 `index.ts`** —— 否则 §2「两个工具共用一条路径」失去结构支撑（双 review 指出）。

SPEC §4.5 的 `lint.ts` / `worktree.ts` / `body.ts` / `session.ts` 这一阶段一个都不建。

---

## 2. 数据流：两个工具共用一条路径

```
readFolder(pr) ──▶ { inline[], conversation[], counts }
                      │
      ┌───────────────┴───────────────┐
      ▼                               ▼
 list_folders                    read_comments
 （只取 counts）                  （返回全量）
```

**共用是刻意的**：R2 要求未回数与人工数一致，两个工具若各算各的，逻辑迟早分叉，而「列折说 3 条未回、读批注只列出 2 条」这种矛盾极难发现。

**v1 在这里自己破了功**：给 `read_comments` 定标量 `counts`、给 `list_folders` 定三元组，换算关系从未定义 —— 双 review 指出 T6 那条比对测试因此根本写不出来。**v2 让两边返回同一个 `counts` 对象**，同名同义，比对是逐字段的。

**N+1 的取舍**：`list_folders` 要带计数就得读每折 comments，约 10 折 → 约 30 次 REST 调用（含 reviews）。接受：个人尺度、不在热路径。折数上百再换 GraphQL。

---

## 3. 谁发的：判定规则

### 3.0 判别信号 —— review body

门下 提交批注走 `POST /pulls/{n}/reviews`（`menxia/src/github.js:144 submitReview`），带固定 review body **`御笔朱批 · N 条`**。agent 回话走 `POST /pulls/{n}/comments/{id}/replies`，GitHub 为它自动建一个 **body 为空**的 review。

**而 门下 没有任何发 reply 的代码路径** —— `github.js` 里只有 `submitReview` / `createIssueComment` / `mergePR` / `markReady`。

实测 #17：

| review id | body | 底下的 comment |
|---|---|---|
| 4802391903 | `御笔朱批 · 2 条` | 2 条 ROOT ← 他的批注 |
| 4802417485 | （空） | 1 条 reply ← 我方 |
| 4802419195 | （空） | 1 条 reply ← 我方 |

**规则**：每条 inline comment 用 `pull_request_review_id` 回查所属 review 的 body —— 以 `御笔朱批` 开头 → **他的**；否则（含空 body）→ **我方**。**追溯有效，历史数据全适用。**

**已知边界**：他若绕开涂归、直接在 GitHub 网页上回话，会被判成我方。可接受 —— 涂归存在的理由就是不用 GitHub 网页；真发生了症状是「少一条待办」。

### 3.1 inline：确定判定

- **他的批注** = 根 comment（`in_reply_to_id` 空）且所属 review body 带 `御笔朱批`
- **已回** = 该根下面挂了至少一条**我方** reply
- 我方发的根 comment 不计入待回（落实 R4 第三条）

`answered: boolean`，**确定值不是猜**。

v1 靠「有没有 reply、不看作者」，会被「他在串里反驳」打穿 —— GitHub 把整串 reply 都指向根，他的反驳会让整串显示成已回，而那恰恰是最要紧的一条（双 review 指出）。v2 靠作者判，不受串长影响。

### 3.2 判：只能靠顺序，但**不再谎报**

`createIssueComment` 裸发 body，会话区**没有判别信号**。

v1 的规则有致命缺陷：**最后一条判几乎永远是我方回话**，却被判成「他的未回批注」。实测有判的 3 折里 2 折会常态挂一条我自己写的字当待办 —— 而 `list_folders` 的全部意义就是「哪些折在等我」。

v2 三态，且**语义重定义**：

| 值 | 何时 | 计入 `needsReply` |
|---|---|---|
| `"inferred"` | 后面还有别的判 | 否 |
| `"unknown"` | 它是最后一条 —— 无法判定是他的新意见还是我的回话 | **否** |
| `false` | 这一阶段永不出现（需要标记才能确定） | — |

**关键决定：`needsReply` 只计确定的，`unknown` 单列一栏。** 宁可少报也不谎报 —— 少报你还会去看 `unknown` 那栏；谎报会让你以为有事要办，或者更糟，让我以为没事。

为让 `unknown` 一眼可判，`read_comments` 返回带上每条判的正文与时间。

### 3.3 根治留给 Phase 3

`reply_comment` 发判时埋 `<!-- menxia-mcp:reply -->`，此后判也能确定判定。**存量历史判永远只能是 `unknown`** —— 不可追溯修复，写在这里免得将来当 bug 查。

---

## 4. 返回形状

### `list_folders`

```
入参：state?: "open" | "merged"        默认 open
返回：{
  folders: [{
    number, title, headRefName,
    counts: { needsReply, unclear, hasFollowUp }
  }]
}
```

`state=merged` 实现为取 `state=closed` 再按 `merged_at != null` 过滤 —— **REST 没有 `merged` 这个枚举**，直接用 `closed` 会把打回关闭的折（实测 #10）当成已画可（双 review 指出）。

### `read_comments`

```
入参：pr?: number                       不给 = 扫全部 open 折
返回：{
  folders: [{
    number, title, headRefName, headSha,
    inline: [{
      id, path, line, startLine, outdated, quote, body, createdAt,
      replies: [{ id, body, createdAt }],
      answered: boolean
    }],
    conversation: [{ id, body, author, createdAt, answered: "inferred" | "unknown" }],
    counts: { needsReply, unclear, hasFollowUp }
  }]
}
```

`counts` 与 `list_folders` **同名同义、同一个对象**。

**inline 用嵌套 `replies` 而不是扁平 + `inReplyToId`** —— 串由服务端还原成树，落实 R3「不需要再解析、再推理」。这**收紧了 SPEC §3.5** 的扁平形状。

字段细节，**全部由双 review 用真数据查出**：

- **`line` 实测 100% 为 null**（#17 四条全是）。原因系统性：批注之后 agent 推了改版 → 批注 outdated → GitHub 对 outdated 批注返回 `line: null`。而「批注 → 改版 → 再读」正是这个循环的稳态，**也就是说最该用得上的时候它一定是空的**。取值 `line ?? original_line`，并返回 `outdated: boolean`（`commit_id !== headSha`）。
- **`quote` 必须剥 diff 前缀**。`diff_hunk` 每行行首带 ` ` / `+` / `-`，直接取末行会得到 `+## 阶段 3 …`。末行若是 `\ No newline at end of file` 则取倒数第二行。
- **多行划选**：`start_line ?? original_start_line` 非空时，quote 取末尾 `line - startLine + 1` 行，不是只取一行。
- **分页**：请求带 `per_page=100`；响应头出现 `Link rel="next"` 时**直接报错**，不静默截断 —— 截断会把 reply 与根分到两页，reply 变孤儿，**凭空多出一条未回**。
- **review body 不读**：`/pulls/{n}/reviews[].body` 目前只由提交脚本生成固定串，不含内容。**这是决定，不是遗漏。**

---

## 5. 认证（R5）

**懒取**：第一次真正需要时才跑 `gh auth token`，缓存在内存。401 → 清空缓存重取一次 → 再 401 → 报 §6 的话。

启动时取会让「装上但没用到」的会话也依赖 `gh` 可用，而 server 在每个 Claude Code 会话都会起。

（双 review 提醒：`gh auth token` 读的是本地已存凭据，重取通常返回同一个 token。这次重试防的是「另一个 session 期间重新登录过」，不是 OAuth 刷新。）

---

## 6. 错误（R6）

`errors.ts` 吃的是**判别式联合**，不是裸 Error：

```
AuthError | RepoError | NotFoundError | NetworkError | UnknownError
```

| 情形 | 返回 |
|---|---|
| 拿不到 gh 认证 | 「拿不到 GitHub 认证。跑 `gh auth login` 后重试。」 |
| 仓不存在或无权限 | 「读不到 `<repo>`。确认仓名对、且当前 gh 账号有权限。」 |
| 折号不存在 | 「`<repo>` 里没有 #`<n>`。用 `list_folders` 看现有折号。」 |
| 网络失败 | 「连不上 github.com：`<原因>`。网络恢复后重试。」 |
| 其他 | 兜底话术，不裸奔 |

**404 消歧**（双 review 指出，v1 漏了）：GitHub 对「仓不存在」「私有仓无权限」「折号不存在」**都返回 404**。规则：PR 请求收到 404 时，先 `GET /repos/{owner}/{repo}` 探仓 —— 仓读得到才归为「折号不存在」，否则归为「仓读不到」。否则折号敲错时会被告知去查权限，正好把人指反。

一律不带 token、不带 stack trace。

---

## 7. 只读怎么保证（R7）

v1 的守卫是「扫源码找 POST/PATCH/PUT/DELETE 字面量」。**双 review 两边都判定它恒绿**：Octokit 的具名写方法（`issues.createComment()`、`pulls.merge()`、`.update()`）根本不含这些字符串；而 `github.ts` 自己要跑 `gh` 子进程，`execFile('gh', ['api','-X','POST'])` 同样绕过。

v2 改**白名单**：

1. `github.ts` 只导出一个 `get(route)` 包装，内部唯一的网络调用是 `octokit.request(route)`，且 `route` 必须匹配 `/^GET /`。
2. **守卫是一个吃字符串的纯函数** `scanForMutations(src: string): string[]`，断言：`src/` 里除该包装外不出现 `octokit.`；不出现 `gh` 子进程的写参数（`-X POST` / `--method`）。
3. **自验用例喂内联假源码**（含具名写方法与 `-X POST` 两种），断言都能被抓到 —— 不真往 `src/` 加一行再删（凌晨忘删 = 把写能力留在源码里）。

R7 是「不发生什么」的要求，**不发生的事只能靠一条主动去找它的测试**。

---

## 8. 测试策略

**fixture 必须来自真实 API dump，不许手写**（双 review 的高危之一）：手编 fixture 用 `in_reply_to_id: null`、真实 payload 是 key 缺失，实现写 `=== null` 就会把所有批注判成根 → 全部未回 → 单测全绿而线上全错。

| 对象 | 怎么测 |
|---|---|
| `threads.ts` | fixture 取自 `test/fixtures/*.json`（#17 comments / #17 reviews / #18 issue comments 的真实 dump）。用例：他的批注有我方 reply → answered；没有 → 未回；我方发的根不计入；判交替 → `inferred`；末条 → `unknown`；空输入 |
| `errors.ts` | 五种映射各一条；**塞假 token 进错误对象，断言输出里搜不到它** |
| 只读守卫 | §7 第 3 条 |
| 实机 | 见 tasks T7，判据用真数字正向断言 |

**实机的 ground truth（写死，不许「返回空也算过」）**：
- `read_comments(17)` → inline 恰好 **2 条根批注**（他的），各挂 **1 条** reply，`answered` 全 true，`counts.needsReply = 0`
- `read_comments(18)` → conversation **2 条**，没标记过时**两条都 `pending`**、`counts.needsReply = 2`（**§10.7 改**：旧判据写的是「第一条 `inferred`、第二条 `unknown`、`needsReply = 0`」——那正是被修掉的漏报）
- `list_folders()` 里 **#10 不出现在 `merged` 结果中**（它是打回关闭不是画可）

---

## 9. 非目标

不做缓存、不做真分页（只做「超一页就报错」）、不做 GraphQL、不做并发控制。不读 review body 的内容。这些都是「折数上百」才出现的问题。

---

## 10. v3 修订（2026-07-29 夜，三轮代码评审之后）

**§3 与 §4 的结论又变了一次。** 下面这些是实现过程中被独立评审 agent 用真数据 / 本地探针打出来的，正文保持 v2 原样不改写，以此节为准。

**例外：§8 的「实机 ground truth」是判据不是叙事，已就地改掉。** 第二轮评审指出上一次
只声明「§3 与 §4 变了」，于是 §8 那条写着「写死，不许『返回空也算过』」的判据与
现行行为直接对立 —— 而那正是新 session 最可能抄来当验收标准的一节。

### 10.1 作者判定：多一个 marker

门下 有一条**降级路径**（`menxia/src/ui.js:545-553`）：草稿写于旧版本（`stale = d.ref !== ref`）或行号锚不到可批注行时，那些涂归不进 inline，被塞进 review body，前缀是「以下朱批锚定不到可批注行（或写于旧版本），并入总批：」。

两个后果，都严重且静默：

- **只要有一条降级**，整个 review body 就不再是「御笔朱批 · N 条」→ 这一批里**成功锚上的**批注全被判成非门下 → `answered=true` → 看不见；
- **若全部降级**，review 里零条 comment，他写的东西只存在于 body 里 → 工具直接说「这折没事」。

而「隔夜草稿 + agent 推过改版」正是最常见的形态。故 `isDeskBody` 认两个 marker，且降级 body 的正文被捞出来当 conversation 项（门下 自己的说法就是「并入判」），并且**确定是他发的**，作者不用猜。

### 10.2 「已回」不再是确定值

§3.1 写着 `answered: boolean`，**确定值不是猜**。那句话是错的：他从 GitHub 网页在串里回一句，与 agent 回话完全同形（都是空 body review）。v2 的判据会因此把串标成已回 —— **他一开口，工具反而更安静**，这是最坏的一种错。

现在：涂归根批注**有回话**的一律进 `unclear` + `attention`，预览取**最后一条回话**的正文（「我方回话：已改」和「不对，我说的是第二段」一眼可分）。代价实测很小：9 折只多 2 条 attention。

### 10.3 counts 改名并重新定义

`unanswered / unknown / inferred` → `needsReply / unclear / hasFollowUp`。`inferred`（「推测已回」）被判定为**在撒谎** —— 他连发两条时第一条也落这里。

### 10.4 加 attention[] 与 updatedAt

光给数字答不了「哪些折在等我」：实测 #9 的 counts 是 0/1/0，而那条的正文是「文档是不是有点旧了。」—— 他发的真问题，模型看到全 0 必然跳过。现在每条待看带 80 字预览；折按最近活动倒序（唯一有待回的 #7 在创建时间序里排最后一个）。

### 10.5 §7 只读的执行机制换了

§7 描述的文本扫描守卫**从没对本项目生效过** —— 真实代码是 `oc.request(route, params)`，变量不叫 `octokit`、route 是变量，三条规则一条都没命中。更要命的是 `octokit.request('GET /x', { method: 'POST' })` **真的会发 POST**（Octokit 的 options 覆盖 method，评审用本地 server 实证）。

现在：Octokit 实例封在模块闭包绝不外泄 + `hook.wrap` 断言最终 `method === 'GET'` + `sanitizeParams` 剔除 `method/url/baseUrl/request/headers`。文本扫描降级为辅助 lint。第三轮试了 12 种绕法全被拦下。

### 10.6 §4 的字段细节修正

- 「`line` 实测 100% 为 null」——**repo 级别不成立**，#7 的批注 `line: 7`。#17 全 null 是因为那折的批注 outdated。取值逻辑不变（`line ?? original_line`），但优先信 GitHub 自己的信号判 `outdated`。
- `quote` 要按 `side` 取侧：`LEFT`（批注锚在被删除的那一行）得留 `-` 行、滤 `+` 行，否则会引一句他根本没划的话。
- 孤儿回话（根被删或被截断）单独成串，不静默丢弃。

### 10.7 判的 answered 改用本地记录（review#29 + 第一轮评审）

§3.2 那套「会话区按位置推断」**已废**。它成立的前提是「会话区是双方 channel」；
agent 不再发折级小结之后它变成单方收件箱，`i < len-1 → 已答` 于是把
「他连发两条判」的前一条静默判成已答（**漏报**）。

现行：`answered` 只有 `handled` / `pending`，取自本地 `~/.zhupi-mcp/processed.json`。
`counts.hasFollowUp` 一并删除 —— 它数的就是那个坏推断的产物。

R7 的口径精确成「**不写远端**」：`processed.ts` 是全项目唯一写路径，
`guard.ts` 有规则焊死「`src/` 里除它之外不许出现 fs 写」。

第一轮评审在此之上又抓到三条高危，一并定型：
1. **记的是 `id → 当时的 updated_at`，不是光记 id。** 他原地编辑一条已 handled 的判时
   id 不变，只记 id 会让那句新话永不出现 —— 正是本节要杀的漏报换了个形态。
2. **`load` 必须分清「文件不存在」和「读不出来」。** 后者拒绝写：拿读失败的空基线
   `save` 一次会把所有折的记录永久抹掉（并发实测 2.5% 触发）。`save` 改成 temp + rename 原子写，
   `commit` 落盘前重读合并。
3. **`seed` 改两步。** 它会连 门下 降级并入判的**他的涂归**一起标掉（评审在 #9 上实测），
   而它不可见也曾不可撤销。现在不带 `confirm` 只返回预览，且新增 `undo`。
