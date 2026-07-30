[English](tasks.md) · **中文**

# Phase 2 任务拆分

> 上游：[需求](https://github.com/charliezong18/review/pull/32)（已钦此）· [设计 v3](https://github.com/charliezong18/review/pull/33)（D5/D7/D8 已定）
> **一条一条执行**，每条做完先过判据再动下一条。

## 依赖顺序

```
T1 stripCode ──► T2 lint.ts ──┬──► T3 疤痕清单（上线闸门）
                              ├──► T4 snapshot.ts ──► T5 CLI + T6 工具 ──┬──► T7 R7 巡检
                              │                                          └──► T9 接线
                              └──────────────────────────────────────────────► T8 differential
                                                                              T10 评审 + 文档
```

T1 先做的理由：规则 4 和 5 都靠它，而它错了会让两条**同时**误判、方向相反（4 漏报断图、5 误报语言），不容易靠观察发现。

## T1 · `stripCode` 共用 helper

剥 fenced code block 与 inline code（R4：规则 4 和 5 必须共用一套）。

**判据**：反引号数不匹配 / 代码块套代码块 / `~~~` 围栏 / 行内代码跨行 各一个用例。

## T2 · `lint.ts` 纯核：9 条规则

吃 `Snapshot` 吐 findings，**无 IO**。规则表见设计 §2。

**判据**：每条规则一个通过 + 一个必失败用例，全部用内联假 snapshot —— 不造 git 仓。规则 5 严重度 = 警告（D5）。

## T3 · 疤痕清单 —— 这是上线闸门

约 10 条「以事故命名」的测试，注释里写死病历（设计 §3 那张表）。范本：`~/.claude/skills/review-loop/guard-var.test.sh`。

**判据**：① 每条测试名里有事故、注释里有病历日期；② **把对应规则改坏时它必须红** —— 这一条要真做一遍变异，不是声称。

D7 已定：它取代 differential 当上线闸门，因为 differential 会随老脚本一起死、真实语料 14/16 空转、且覆盖不到规则 5 和 9。

## T4 · `snapshot.ts`：git 子进程采料

走 `git show <ref>:<path>` / `git cat-file`。**绝不 import fs** —— `guard.ts` 焊死了，且 2026-07-30 刚补上 `node:fs/promises` 的绕过洞。

**判据**：真 git 仓 happy path + `fetch` 失败分支各一个用例；`npm test` 里守卫对 `src/` 的扫描保持零违规。

## T5 · `lint-cli.ts` + T6 · `lint_folder` 工具

- CLI：findings → ✓/✗/⚠ 文本 + 退出码 0/1，给 `open-folder.sh`；`--parity` 比归一化后的 findings 集合
- MCP：`lint_folder({ worktree, ref })`，结构化返回，只读本地不打网络

**判据**：两个口对同一折给出**同一结论** —— 断言 findings 逐字段相等，不是「都说合格」。

## T7 · R7：巡检改用同一个核

D3 已定共用 `lint_folder`。巡检对每个 open 折的分支各调一次；差别只剩「有没有叫 GitHub 那一层」（回奏对标记 / draft），那一层归 Phase 3。

**判据**：R7 表里五处不一致（互链头 / 断图 / `.payload` / 双语方向 / 五段）在真实的 16 个 open 折上实测消失。**只做读侧，不动 `--fix`。**

## T8 · differential 一次性对照

D7 降级：跑一遍留存，不建成常设基础设施。复用 `scripts/acceptance.mjs` 的 `check()/ok()/bad()`，样本现造在 `/tmp`。

**判据**：差异逐条分类成「bug」或「刻意改进」（规则 5/9 属后者）；**自验一次** —— 故意造差异，确认它真报。

## T9 · 接线

```sh
OLD=0; sh folder-lint.sh . || OLD=$?     # 必须用 ||；set -euo pipefail 下 `; OLD=$?` 会直接掐死呈折
NEW=0; node "$LINT_CLI" . --parity || NEW=$?
[ "$OLD" -eq 0 ] || exit 1               # 对账窗口内**以老的为准**
```

parity 结果写仓里 `PARITY.md`，由 `npm test` 末尾现成的触发器打印连续一致次数（**不手写家目录日志** —— 那是这个项目自己反对过的「会漂的副本」）。`SKIP_LINT=1` 记一行 + stderr 播报（D8）。

**判据**：① 故意让新旧不一致时呈折仍能完成且打印差异；② `SKIP_LINT` 用一次后 `PARITY.md` 里有记录。

## T10 · 三轮评审 + 文档还账

实现完跑三轮，每轮换视角，**至少一轮看仓外**。

文档：SPEC §5 标注哪些已实现、**R2 被 D7 修改**；MILESTONES 追一行（永不改写旧条目）；README 工具面加 `lint_folder`；退休条件（连续 10 次零分歧）写进 `PARITY.md` 顶部。

**判据**：不留「文档说待实现而代码已实现」或反之的漂移 —— 这个项目查出过 3 处，SPEC §5.1 就是为它立的。

## 不做

`audit-folders.sh --fix`（Phase 3）· 删老脚本（D1 并行对账）· SKILL.md「缺项也拦」那句（Phase 4）· merged 分页（BACKLOG，约八月中）· `package.json` 的 `bin`（守卫定死）
