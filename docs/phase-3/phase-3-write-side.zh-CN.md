[English](phase-3-write-side.md) · **中文**

# Phase 3：写入侧

呈折 / 回话 / 巡检三个工具搬进 MCP 了。483 个测试，24 条变异全杀。
**但这一折要你看的不是「搬完了」，是搬的过程里查出来的三件事** —— 其中一件我按自己的
判断改了设计，一件把工具从写变成了只读，还有一件我没敢自己定。

## 一、SPEC §4.2 写的锁，在这台机器上不存在

设计和任务书都写「`flock`，`O_EXLOCK | O_NONBLOCK`」。实测：

```
$ node -e "console.log(require('fs').constants.O_EXLOCK)"
undefined
$ which flock
flock not found
```

Node v25.2.1 的 `fs.constants` 里**没有 `O_EXLOCK`**（`O_*` 只有 RDONLY / WRONLY /
RDWR / CREAT / EXCL / NOCTTY / TRUNC / APPEND / DIRECTORY / NOFOLLOW / SYNC / DSYNC /
SYMLINK / NONBLOCK），macOS 也没有 `flock(1)` 可以 shell 出去。

**照着写会怎样**：`O_CREAT | O_RDWR | undefined | O_NONBLOCK` —— `undefined` 在按位或里
当 0，于是锁标志静默消失，得到一把**永远锁不上的锁**。`openSync` 照常成功，
全部测试照绿，两个 session 同时呈折照样互踩。这个项目栽过五次的「恒绿」，第六次。

改成了 `O_EXCL` 原子建锁文件 + 里面记 pid/时间 + 三条判活（内容读不出来 / pid 已死 /
超过五分钟）。**崩溃后不死锁靠的是判活，不是内核放锁** —— 这条差别很要紧，
所以配了一条真 `SIGKILL` 一个持锁子进程的测试，而不是断言「应该能拿到」。
另有两个真进程并发抢锁、断言持锁窗口不重叠的测试。

抢陈旧锁走 rename-aside（两个进程同抢只有一个 rename 得成），拿到锁之后**回读确认
锁里的 pid 是自己的**。残留竞态写在文件头没藏着：A 读到陈旧锁 → C 抢先拿锁 →
A 把 C 的新锁挪走，微秒级窗口；最坏结果是两个 git 操作撞上，git 自己的 index 锁会
明着报错，不是静默串仓。

## 二、`audit_folders --fix` 实现到一半发现两件事都不能做，于是它变成了只读

老脚本 `audit-folders.sh --fix` 干两件事，逐条查下来：

- **补「回奏对」标记** —— 老脚本 `:38` 补的是**当前会话**的 id。那不是呈这折的那个会话，
  是编一个。与 SPEC §4.4「探不到就不埋，绝不编；静默指错比没有更糟」直接矛盾。
  后果也不是「差不多就行」：指错的标记会让「回奏对」按钮把你送进一个不相干的会话。
- **draft 转正** —— GitHub REST 的 `PATCH /pulls/{n}` **不接受 `draft` 字段**，
  只能走 GraphQL 的 `markPullRequestReadyForReview`。而把 `POST /graphql` 放进写白名单
  等于开放全部 mutation（删仓、合折、改任何东西都走那一个端点），白名单当场失去意义。

一个错、一个不安全，所以 `--fix` 整个没做，`audit_folders` 是纯只读的，
draft 那条会给你现成的 `gh pr ready <n> -R charliezong18/review`。

连带效果：`PATCH /pulls/{n}` 没有用户了，从写白名单里删掉。
**这个 server 现在总共只能发两种写请求**：建折、回话。别的一律被运行时闸门拦下。

## 三、这一条我没敢自己定：MCP 工具从三个闸门旁边过去

`guard-pr-create.sh` / `guard-reply-body.sh` / `guard-closed-folder.sh` 都是
**PreToolUse(Bash)** hook。MCP 工具调用不是 Bash 调用，**它们一条都不生效**。

也就是说，如果什么都不做，Phase 3 的净效果是「把呈折从一条有三道闸门的路，
搬到了一条没有闸门的新路上」。

我在工具里自己补了两条：

| 原来靠哪个 hook | 现在 |
|---|---|
| 已钦此/已关的折不许回话（`guard-closed-folder`） | `reply_comment` 先 GET 一次查 state，非 open 直接拒 |
| inline 回话首行盖 `**回话**`（硬约定③） | 焊死：缺了自动补，同一行 |
| 不许发总批（硬约定①） | 工具面上**根本没有这个能力** —— `commentId` 必填 |
| 裸 `gh pr create` 绕过体例闸门（`guard-pr-create`） | 不适用：新工具自己就是那个闸门 |

但这只补上了「我想得到的那几条」。`BACKLOG` 里早就记着一条更根本的
（Phase 2 第一轮评审 ⑤）：**呈折闸门是「防手滑，不防绕过」**，实测 6 条旁路
（包一层脚本、`xargs`、`eval`、python `subprocess`、`git push` + 网页建 PR、
非 Claude Code 运行时）。原文写着：

> 真要闭合只有一条路：把判据下移到仓侧（main 上加 CI 对 PR 校验体例）。
> 那是 Phase 3/4 的范围，而且**要先跟 Charlie 确认** —— 加 CI 会改变他的呈折体感。

Phase 3 把「正路」加宽了一条（MCP），旁路一条没少。这件事该不该现在做、
怎么做才不烦你，见下面第 2 条。

## 四、顺手修的两个在漏的洞

**`PARITY.md` 的行粘在一起了。** `open-folder.sh` 的 `parity_row` 用
`$(printf ... '\n')` 拼行，而命令替换会剥掉尾换行；`parity_flush` 又用 `printf '%s'`
不补。于是第二行起全部粘在上一行末尾，`parity.ts` 的 `/^\|\s*\d{4}-/` 只认行首那条 ——
**#34 #35 两次真呈折在台账上只算了一次**。而那个计数支撑「删掉 `folder-lint.sh`」
这个不可逆决定。已修（换行改在 flush 时补）；已粘的那行不手工拆，少算的方向是保守的。

**守卫拦错了自己的错误提示。** 写入侧每条错误都要带一句恢复命令（`gh pr edit <n> …`），
而 `guard.ts` 把这些提示文案当成了要执行的命令。SPEC §7 把「字符串里出现 ≠ 这条命令
要执行」这个病根记了三遍，这是第四次。顺带查出模式④本来就有个洞：
`run('gh', ['pr','create'])` 这种数组拆分的写法它一直匹配不到。两处都改了。

## 五、变异战役

24 条非等价变异全部被杀（Phase 2 基准 53/59 = 90%）。战役本身抓到两处
**声称有防御但没有测试**的地方：

- `get()` 里的 `sanitizeParams` 零覆盖 —— 删掉它全套测试照绿
- 锁「回读确认是自己的」零覆盖 —— 它防的是微秒级竞态，并发跑撞不出来，
  开了个测试接缝把那一手直接插进去

顺带一个自嘲：第一轮变异里「write 不剔 params」显示**存活**，我差点当成漏洞记下来。
实际是我的 `perl -0pi -e 's/.../.../'` 没写 `/g`，只替换了第一处 —— 而第一处在 `get()`
不在 `write()`。**变异工具本身也会撒谎**，存活的结论要先核实变异是不是真变到了那儿。
