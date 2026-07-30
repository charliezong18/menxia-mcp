[English](tasks.md) · **中文**

# Phase 3 任务拆分 —— 写入侧

> 上游：[SPEC §3.1/§3.3/§3.6 · §4.2](../../SPEC.zh-CN.md)（#18 已钦此）· [MILESTONES 判据](../../MILESTONES.zh-CN.md)
> **一条一条执行**，每条做完先过判据再动下一条。

Phase 0–2 全部只读或只写本地。**这一阶段第一次往别人的仓里写**，而这个项目已有的三道
安全闸门（Octokit 只读 hook、`guard.ts` 的 fs / git 白名单、hook 路由守卫）当初正是
按「不写远端」设计的。所以本阶段的头两条任务不是功能，是**把闸门从「禁止」精确成
「只许这几条」** —— 方向是放松，而放松是这个项目栽跟头最多的方向
（Phase 2 第二轮评审：六条新问题里最重的一条就是把 `&&` 换成 `;` 换来的恒绿）。

## 起点上的四处冲突

写代码前先记账，免得写到一半才发现前提不成立。

| # | 冲突 | 处置 | 记在哪 |
|---|---|---|---|
| C1 | `github.ts:45` 的运行时 hook 断言 `method === 'GET'`，非 GET 一律抛 | **不拆**。加一条 `write()`，走精确 `(METHOD, route)` 白名单；Octokit 实例照旧封在闭包里 | T1 |
| C2 | `guard.ts` 的 `FS_WRITE_ALLOWED_FILE` 是**单值**（`processed.ts`），规则 ⑥ 在 `src/` 全禁 git 写 | 扩成 Set + 按文件的 git 豁免，**每个新成员配一条「白名单只能这么长」的反向测试** | T2 |
| C3 | **SPEC §3.6 与 `guard-reply-body.sh` 硬约定① 直接打架**：SPEC 说省掉 `commentId` 就发总批；守卫（2026-07-30 10:54 立）说 agent 一律不许发总批，实测 13 条 needsReply 里 7 条是 agent 自己的话（多报 77%） | 守卫比 SPEC 新，且有实测数据。`reply_comment` **只做 inline，`commentId` 必填**；SPEC §3.6 改掉 | T7 |
| C4 | `open_folder` 的范围**严格大于** `open-folder.sh` | 老脚本只做 lint + 建 PR；开分支 / 拷文件 / commit / push 现在全在 SKILL.md 的散文里（:71–:76）。**这一段没有可移植的实现**，要新写 —— 而这个项目自己量过散文的漏执行率是 37.5% | T4 |

C4 的分量最容易被低估：SPEC §5.1「照实现移植，不照文档移植」是 Phase 2 的纪律，
到这一阶段有一半路段**没有实现可照**。那半段要按新代码对待 —— 配自己的测试，
不能靠「老脚本一直这么跑」的信心。

## 依赖顺序

```
T0 PARITY 粘行（已修）
T1 write() 白名单 ──┐
T2 guard 白名单     ├──► T4 worktree.ts ──► T6 open_folder ──┬──► T9 疤痕清单
T3 session.ts ──────┘         │                              ├──► T10 并发实测
                              └──► T5 body.ts ───────────────┴──► T11 端到端真呈一折
T7 reply_comment（只依赖 T1/T2）                                   T12 三轮评审 + 文档还账
T8 audit_folders（依赖 T1/T2 + Phase 2 的 lint 核）
```

T1/T2 先做的理由：它们是**闸门**。先写功能再回头开闸，等于有一段时间闸门是关的而
代码在绕过它 —— 那段时间里写的任何东西都没有被守卫看过。

## T0 · `open-folder.sh` 的 PARITY 粘行 —— 已修（2026-07-30）

`parity_row` 用 `$(printf ... '\n')` 拼行，命令替换**剥掉尾换行**；`parity_flush`
用 `printf '%s'` 又不补 —— 于是第二行起全部粘在上一行末尾。实测 #34 #35 两次真呈折
在台账上是一行，`parity.ts` 的 `/^\|\s*\d{4}-/` 只认行首那条，**「连续一致」少算一半**。
而这个计数支撑的是「删掉 `folder-lint.sh`」这个不可逆决定。

修法：换行在 flush 时补；文件末尾没换行就先补一个（存量文件正是这个状态）。

**已有的那行不手工拆开。** 少算的方向是保守的，而「别手工编辑这张表」是台账自己写的规矩
（手工痕迹会让 `unknown` 判定失效，那才是真危险）。代价是 10 次里损失 1 次，认了。

**判据**：从真源码 `eval` 出这两个函数，对「末尾无换行」的文件连写三行，
`summarize()` 必须读出 `rows=4 / unknown=0`，且 `SKIP_LINT` 那行把 streak 打断。✅ 已过

## T1 · `github.ts` 开一条写入路 —— 白名单，不是开闸

现在的 `installReadOnlyGate` 是**唯一**可信的那道闸（第一轮评审用本地 server 实证：
文本扫描拦不住别名 / 模板 route / 原生 fetch）。写入侧不能把它拆了。

做法：
- 新增 `installWriteGate(oc, allow)` —— hook 里断言 `(method, 归一化 route)` 在白名单里，**不在就抛**
- 白名单是**字面量常量**，Phase 3 只有四条：
  - `POST /repos/{owner}/{repo}/pulls`（建折）
  - `PATCH /repos/{owner}/{repo}/pulls/{pull_number}`（补 body / draft 转正）
  - `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies`（回话）
  - `GET`（写侧实例也要能回读自核，但走同一张表更简单：GET 全放）
- 写实例与读实例**分开缓存**，读实例照旧只走 `installReadOnlyGate`

**判据**：起一个本地 server，验四件事 ——
① 白名单内的 POST 真发出去了；
② 白名单外的 `DELETE /repos/{owner}/{repo}`（删仓）被拦；
③ `write('POST /...pulls', { method: 'DELETE' })` 被拦（Octokit 的 options 覆盖 method，
   这是第一轮评审实证过的假闸门形状，写侧要重验一遍）；
④ **读实例仍然一个非 GET 都发不出去** —— 别让写侧的改动把读侧的闸门也松了。

## T2 · `guard.ts` 白名单扩张 + 反向测试

要放松三处：

| 规则 | 现状 | 改成 | 新成员 |
|---|---|---|---|
| ②′②″ fs | 单值 `src/processed.ts` | `Set`（2 个） | `src/worktree.ts`（拷文档进 worktree + 锁文件） |
| ⑥ git 写 | `src/` 全禁 | 按文件豁免（1 个） | `src/worktree.ts`（`worktree add/remove`、`add`、`commit`、`push`） |
| ③ route 必须 GET 开头 | 全禁 | **不动** | 见下 |

`body.ts` **不进 fs 白名单**：body 是个字符串，直接交给 Octokit。老脚本写临时文件
只是因为 `gh pr create --body-file` 要一个路径 —— 换了 API 那个理由就没了，
顺手加进白名单就是白送一个洞。

规则 ③ 不动，但**它没看见 T1**：它只匹配字面量 `octokit.request('POST …')`，
而 `github.ts` 的真实写法是 `oc.request(route, safe)`，route 是变量。
实测 T1 写完之后 44 条守卫测试一条没红 —— 这个项目安全姿态上最大的一次变化，
守卫全程没吭声。守卫自己的注释承认它已降级为辅助 lint，所以「写入面有多大」
改由 `WRITE_ALLOWED` 的**长度断言**来守（写在 `write-gate.test.ts`）。

**放松的守卫必须配反向测试，否则它就是装饰。** 每一处加两条：
- 正向：新成员里的合法写法不报违规
- **反向：白名单外的文件写同样的代码必须报** —— 且断言**白名单本身的长度**。
  不钉长度的话，以后随手往 Set 里加一个成员**不会有任何测试变红**：上面那些测试
  测的是「白名单外被拦」，而加成员恰恰是把文件挪到白名单**内**。
- 按**完整相对路径**匹配，不按 basename —— 否则把文件塞进 `src/sub/worktree.ts`
  即可全豁免。第二轮评审在 `OCTOKIT_ALLOWED_FILE` 上抓过同一个坑。
- 拦截名单补 `mkdtempSync` / `openSync`（原来一个字都没提，而临时 worktree 正靠它们）

**判据**：三处变异全部必须红 —— ① 往 fs 白名单偷加一个成员；
② 豁免改成按 basename 匹配；③ git 豁免放开成全局。**真做一遍变异**，不是声称。
✅ 已过（分别红 4 / 2 / 3 条）

## T3 · `session.ts` —— ppid 爬

移植 `happy-session-id.sh`（39 行 python）。**原脚本那句「命中后再验一次这个 pid
现在跑的确实是 happy」必须原样保留**（SPEC §4.4）—— `sessions.json` 只累加不清理，
实测 114 条全标 running，陈旧记录的 hostPid 早被 OS 回收给别的进程。

策略：探不到返回 `null`，**绝不编**。

**判据**：三个用例 —— ① 假 `sessions.json` + 假 ps 链，命中；② hostPid 撞上但
进程名不是 happy（陈旧记录），返回 null；③ `sessions.json` 不存在，返回 null 不抛。
用注入的 `ps` / 读文件函数测，不依赖真进程树。

## T4 · `worktree.ts` —— 唯一碰奏折仓的模块

这是本阶段最危险的一块，也是**没有实现可照抄**的那一段（C4）。

流程（全程在锁内）：
```
拿锁 → fetch origin → mkdtemp → git worktree add <tmp> -b <slug> origin/main
     → 拷 docs/<basename> 与 docs/assets/<basename> → git add → git commit
     → 【lint 闸门：见下】→ git push -u origin <slug>
     → 交给 T6 建 PR → git worktree remove（无论成败）
```

**锁：`O_EXLOCK | O_NONBLOCK` + 退避重试，不用 PID 文件。**
锁文件放仓外（`~/.zhupi-mcp/review.lock`）。选它的理由是**进程死了内核自动放锁** ——
PID 文件方案在 session 被 kill 时会留下永久死锁，而「Happy 关掉一批会话」这件事
今天早上刚发生过。`O_EXLOCK` 是 BSD 语义（macOS 有，Linux 没有），本项目只跑 macOS，
这一条要写进注释，别让将来的人以为是跨平台的。

**lint 闸门放在 commit 之后、push 之前**（刻意改进，登记进 SPEC §5.4）：
`snapshot.ts` 读的是**提交过的**内容（`git show <ref>:<path>`），所以必须先 commit 才测得了；
而不合格时 push 之前停住 —— 什么都没推上去，删掉 worktree 和本地分支即可，
远端一片干净。老脚本做不到这一点：它跑的时候分支早被人手推上去了。

**必须失败而不是将就的几处**：
- 分支已存在 → 明确报错，不许覆盖（重复呈折是真事故，#30 归并说明就是这么来的）
- `origin/main` 拿不到 → 中止（分支基点是体例第 4 条）
- 拷贝的目标已存在 → 报错，不静默覆盖

**判据**：
① 在 `/tmp` 造一个假奏折仓（`git init --bare` + clone），跑完整流程，
   断言远端真多了一个分支、内容逐字节等于源文件；
② lint 不合格时：远端**零变化**，本地无残留 worktree、无残留分支；
③ 中途 kill（模拟 session 被关）后，下一次拿锁**不超时** —— 这一条要真 kill 一个子进程，
   不能靠推理；
④ 两个进程同时进来，第二个拿到的是「另一个 session 在呈折」的可读错误或排队成功，
   不是挂死、也不是两个都进去了。

## T5 · `body.ts` —— 五段拼装 + 标记焊入 + 回读自核

- 按 SPEC §3.1 的 `body` 结构拼五段（目的地 / 直达链 / TLDR / 待你拍板 / 怎么用）
- 缺项**只警告不拦**（SPEC §5.3 #6：文档和脚本注释都写「拦」，是假的，照代码来）
- 末尾焊 `<!-- happy-session: <id> -->`；`session.ts` 返回 null 就省掉，绝不编
- 建完 PR 后 **GET 回 body 确认标记真落进去了**（老脚本有这条，`gh` 有过静默吞 body 的先例）
- 回读失败**照样返回** —— PR 已经建了，瞒着更糟（SPEC §3.1 图里的橙色分支）

**判据**：① 五段齐 / 缺一段 各一个用例，后者是 warn 不是 error；
② 标记为 null 时 body 里一行都不多；
③ 回读拿到的 body 里没有标记时，返回体里带一句能照着修的话（不是抛异常）。

## T6 · `open_folder` 接线

把 T3/T4/T5 串起来，加上 PARITY 台账写入 —— **台账的落盘点在 PR 建成之后**，
不在 lint 之后（老脚本第一轮评审的结论：被拒的折、重试都不是「一次呈折」，
实测 2 个折 0 个真 PR 能攒出 6 行）。中止路径记「呈折中止（不计入）」。

返回：PR 号、**朱批台深链**、lint 报告。**别把 github.com 的 PR 链接当主输出**
（2026-07-27 踩过：他会读成「让你发朱批你却发了个 PR」）。

**判据**：① 假奏折仓上端到端跑通，`PARITY.md` 恰好多一行且带真折号；
② lint 不合格时台账记「呈折中止」且**不进连续计数**（用 `summarize()` 断言 streak 不变）。

## T7 · `reply_comment` —— 只做 inline

C3 的落地。`commentId` **必填**，总批那条路不实现。

`**回话**` 前缀（硬约定③）**焊进工具**：首行没有就自动补上，不是拒绝。
理由是这个项目的既定哲学 —— 「文档写了照样能跳过，所以焊进动作本身」（SPEC §3.1）；
而实测数据支持它：全仓 12 条回话 **0 条**带前缀，散文治不住，守卫改成了拒绝，
工具这一侧能做得更彻底。**同一行，别空行**（朱批台已有 `回话 · <login>` 标签，
独占一行的加粗「回话」在 300px 宽的批注栏里是三层重复）。

**判据**：① 首行没前缀 → 补上且**同一行**；② 首行已有 → 不重复补；
③ 省略 `commentId` → 报一句指向「小结在聊天里说」的可执行错误，不是静默发总批。

## T8 · `audit_folders`

读侧复用 Phase 2 的 lint 核（R7 已在 Phase 2 落地）；本阶段补它独有的、要打网络的两项：
回奏对标记、draft 状态。

**`--fix` 不补回奏对标记**（刻意改进，登记 §5.4）。老脚本 `audit-folders.sh:38`
补的是**当前会话**的 id —— 那不是呈这折的那个会话，是**编**了一个，
与 SPEC §4.4「探不到就不埋，绝不编；静默指错比没有更糟」直接矛盾。
`--fix` 只保留 draft 转正（那一项没有正确性风险）。

**判据**：在假奏折仓上，缺标记的折跑 `--fix` 后 body **零变化**且报告里明说「不补，理由」；
draft 折转正成功。

## T9 · 疤痕清单（Phase 3 版）

以事故命名，注释里写死病历。至少覆盖：
PARITY 粘行（T0）· 写白名单被 params 覆盖动词（T1）· 守卫白名单悄悄变长（T2）·
陈旧 hostPid 指错会话（T3）· 崩溃后死锁（T4）· lint 不合格却推了分支（T4）·
标记没落进 body 却报成功（T5）· 台账在被拒的折上也计数（T6）· 回话前缀独占一行（T7）·
`--fix` 补了一个编造的会话 id（T8）。

**判据**：每条**把对应实现改坏时必须红** —— 真做一遍变异，不是声称。
Phase 2 的杀伤率是 53/59 (90%)，这一版不低于它。

## T10 · 并发实测（MILESTONES 判据之一）

两个真会话**同时**呈折。要**看到 flock 生效** —— 不是假设。

**判据**：日志里能看到第二个进程在等锁（时间戳重叠、拿锁时刻错开），
两折内容各自完整、分支不串、`PARITY.md` 两行都在且没粘。测完把这两折关掉。

## T11 · 端到端真呈一折（MILESTONES 判据之二三）

**dogfood**：用 `open_folder` 呈的第一折就是 Phase 3 自己的交付文档。

**判据**：① 真 PR 建成、朱批台深链能打开；
② **标记从线上 PR body 回读确认**（不是本地拼完就算）；
③ 全程 agent 一次都没碰 `~/Developer/review`。

## T12 · 三轮评审 + 文档还账

三轮换视角，**至少一轮看仓外**（Phase 2 的第三轮读 zhupi 源码，挖出三条规则与产品
实际行为错位 —— 那一轮最值钱）。

文档：SPEC §3.6 改掉总批（C3）· §5.4 登记三处刻意改进（lint 位置 / `--fix` 不补标记 /
回话前缀焊死）· MILESTONES 追一行（永不改写旧条目）· README 工具面补三个 ·
`PARITY.md` 记一笔 T0。

**判据**：不留「文档说待实现而代码已实现」或反之的漂移。

## 不做

删老脚本（Phase 4，且 PARITY 连续数还没到）· SKILL.md 瘦身与 hook 改指（Phase 4）·
`open_folder` 的 `dryRun`（BACKLOG B4）· 图片自动推断（B3）· 一折多篇（B1）·
双语缺口派翻译（B2）· merged 分页（约八月中）
