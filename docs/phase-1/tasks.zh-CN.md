[English](tasks.md) · **中文**

# Phase 1 任务拆分 v2 —— 只读工具

> v2：2026-07-29 双 review 之后重写。v1 有 5 处高危（判据可被「返回空」满足、#18 期望值不可满足、fixture 无来源约束、只读守卫恒绿、三态被压回两态），全部已修进本版与 [design v2](design.zh-CN.md)。

## 排序依据

按**「哪个错了代价最大」**，不按先易后难。核心：`threads.ts` 是唯一「写错了不报错、只是答案悄悄不对」的模块，所以它在网络之前。

**时间盒**：每个 task 有上限，超时则记录阻塞点、跳过、继续下一个（T2–T6 不依赖 T1 的 MCP 装配）。**不停摆等人**。

---

## T0 · 抓真实 fixture（15 分钟）

**交付**：`test/fixtures/` 下四个真实 API dump —— `pr17-comments.json`、`pr17-reviews.json`、`pr18-issue-comments.json`、`pr-list.json`。

**判据**：文件是原样 dump，未手工编辑；`pr17-comments.json` 恰好 4 条且 `line` 全为 null。

**为什么单列**：双 review 的高危之一 —— 手编 fixture 会用 `in_reply_to_id: null`，真实 payload 是**该 key 缺失**，实现写 `=== null` 就把所有批注判成根 → 全部未回 → 单测全绿而线上全错。IO 只发生在生成 fixture 时，不破坏 T2 的无 IO 属性。

---

## T1 · 骨架（时间盒 45 分钟）

**交付**：`package.json`（锁定 `@modelcontextprotocol/sdk` 具体版本、ESM、vitest、`npm test`）、`tsconfig.json`（`module: node16`）、`src/index.ts`、`src/config.ts`、`scripts/smoke-tools-list.ts`。

**判据**
- `npm run build` 出 `dist/index.js`
- `smoke-tools-list.ts` 用 SDK 的 `Client` + `StdioClientTransport` 连自己，`listTools()` 列出两个工具（**必须走完 initialize 握手**，裸发 `tools/list` 会被拒）
- `ZHUPI_REVIEW_REPO` 生效
- **全局状态守卫**：`package.json` 无 `bin`、无 `postinstall`；源码与脚本不出现 `npm link` / `/usr/local`

**超时动作**：记录阻塞点，跳到 T2；T1/T7 留到最后再回头。

---

## T2 · `threads.ts` —— 作者判定与 answered

**交付**：纯函数 + 单测，fixture 全部来自 T0。

**判据**
- **作者判定**：comment 的 `pull_request_review_id` 回查 review body，以 `御笔朱批` 开头 → 他的；否则 → 我方（design §3.0）
- inline：他的根批注挂了我方 reply → `answered: true`；没挂 → `false`
- inline：我方发的根批注**不计入待回**（R4 第三条）
- inline：**判定不读 `user.login`** —— 把 fixture 里作者全抹成同一个值，结果不变
- 总批：`answered` 只有 `handled` / `pending`（**review#29 起**：取自本地已处理记录，不再按位置推断）
- `counts.needsReply` = 没回话的朱批 inline + `pending` 的总批（总批那一半会把我方历史留言也算进来，方向是多报）
- 空输入 → 空结果不抛异常
- 用 T0 的 #17 fixture 跑出：2 条他的根批注、各 1 条我方 reply、`unanswered = 0`

**风险**：把 §3 的已知边界当 bug 修掉。它们是刻意的。

---

## T3 · `errors.ts`

**交付**：判别式联合 `AuthError | RepoError | NotFoundError | NetworkError | UnknownError` → 一句话，加单测。

**判据**
- 五种各返回 design §6 的话
- **塞假 token 进错误对象，断言输出里搜不到它**
- 不含 stack trace

---

## T4 · `github.ts` —— 认证与只读取数

**交付**：单一 `get(route)` 包装、懒取认证、分页护栏、404 消歧、只读守卫。

**判据**
- 首次使用才跑 `gh auth token`，缓存在内存；401 → 清缓存重取一次 → 再 401 报 T3 的话
- **只导出 `get()`**，内部唯一网络调用是 `octokit.request(route)` 且 `route` 匹配 `/^GET /`
- **分页护栏**：带 `per_page=100`；响应头有 `Link rel="next"` 直接报错，**不静默截断**
- **404 消歧**：PR 404 时先探 `GET /repos/{owner}/{repo}`，仓读得到才归「折号不存在」
- **只读守卫**：纯函数 `scanForMutations(src)`；自验用例喂内联假源码，含 `octokit.rest.issues.createComment(` 与 `execFile('gh',['api','-X','POST'` 两种，**都必须被抓到**

**风险**：守卫写成动词字面量扫描 = 恒绿。必须白名单。

---

## T5 · `folders.ts` + `read_comments`

**交付**：`readFolder` 落在 **`src/folders.ts`**（不在 index.ts），接上 `read_comments`。

**判据**
- 给折号返一折；不给扫全部 open
- inline 是嵌套 `replies` 的树
- **`line` 取 `line ?? original_line`**，另返 `outdated: boolean`
- **`quote` 剥掉行首 diff 标记**；末行是 `\ No newline…` 时取倒数第二行；多行划选取末尾 `line - startLine + 1` 行
- `conversation` 每条 `answered` 只能是 `"handled"` 或 `"pending"`，**断言全量结果里不存在 `inferred`/`unknown`/`true`/`false`**
- 返回 `counts`，与 `list_folders` 同名同义
- 折号不存在 → T3 的话

---

## T6 · `list_folders`

**判据**
- 复用 `readFolder`，**不另写计数逻辑**
- `state=merged` = 取 `closed` 后按 `merged_at != null` 过滤；**一条用例断言 #10 不出现在 merged 里**
- 入参校验：`state` 非枚举值、`pr` 非正整数 → 返回 T3 兜底话术，不抛异常
- **一条测试同时调两个工具，逐字段比对 `counts`**
- 无折 → 空列表

---

## T7 · 实机验收 + 交付可用（时间盒 60 分钟）

**判据（全部为正向断言，「返回空」必然变红）**
- `read_comments(17)` → inline **恰好 2 条**根批注，各挂 **1 条** reply，`answered` 全 `true`，`counts.needsReply = 0`
- `read_comments(18)` → conversation **恰好 2 条**；没标记过时**两条都 `pending`**（旧位置推断会把第一条判成已答 —— 那正是 review#29 修掉的漏报），`counts.needsReply = 2`
- `list_folders({state:'merged'})` → **不含 #10**
- 在真的 MCP 客户端里调通两个工具
- **把 server 写进 Charlie 的 MCP 配置**，他早上起来能直接用
- MILESTONES 的 Phase 1 行改 ✅ 并追加「实际发生了什么」
- **装 MILESTONES 触发器**：`npm test` 结束打印各阶段状态行（从文件解析，不硬编码）—— 这是 MILESTONES 自己点名 Phase 1 偿还的欠账

---

## 不在这一阶段的

呈折、lint、巡检、回话、钦此；缓存、真分页、GraphQL、并发控制、读 review body 的内容。
