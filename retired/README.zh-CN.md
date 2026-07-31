[English](README.md) · **中文**

# 退休的脚本（存档，别跑）

这是被本 MCP server 取代的四个 bash 脚本，删除当刻（2026-07-30，Phase 4）原样存下来的。

**为什么存档而不是直接删。** 它们住在 `~/.claude/skills/review-loop/`，
那个目录**不在任何版本控制里** —— 在那儿删掉就是永久没了。而 SPEC §5.1
（「照实现移植，不照文档移植」）一路都在引用它们的行号，存档放在取代它们的那个仓旁边，
那些引用才还查得动。

**别跑它们。** 留着是当参考，不是当退路。其中两个带着已知缺陷（见下）——
那些缺陷正是这次移植的理由。

| 脚本 | 被谁取代 | 备注 |
|---|---|---|
| `open-folder.sh` | `open_folder` | 它的范围**更窄**：只做 lint + 建 PR。开分支、拷文件、commit、push 全是 `SKILL.md` 里的散文，而这个项目量过散文的漏执行率是 37.5% |
| `folder-lint.sh` | `lint.ts` + `lint_folder` | **有已知缺陷，见下** |
| `audit-folders.sh` | `audit_folders` | 它的 `--fix` **刻意没有移植** —— 见 SPEC §3.3 |
| `happy-session-id.sh` | `session.ts` | 「命中后再验一次这个 pid 真是 happy」那一句原样保留（SPEC §4.4） |

## 两处刻意保留的缺陷

**`folder-lint.sh:58` —— 一个贯穿脚本整个生命的假通过。** `${ZH}（` 里那个全角括号
被 bash 算进标识符，`set -u` 下让跑 slug 循环的子 shell **当场死掉**，`FAIL` 保持 0，
于是**整个脚本打印「体例合格」并 exit 0**。「缺中文版」这一整类**一次都没拦住过**。
`LC_ALL=C` 下不复现，所以一直没人发现。注意：并行窗口里 `PARITY.md` 写的是
「以老脚本为准」—— 在这一类上，那条指示是错的。

**`open-folder.sh:65` —— 同一个形状**，`$sec」`。

## 退休判据为什么换了

原本的规矩（design D1）是「连续 10 次呈折零分歧」，它的三条腿在立起来的**同一天**
全断了，见 [`PARITY.md`](../PARITY.md) 顶部那一段。真正放行这几个脚本的判据是
[`scripts/retire-gate.mjs`](../scripts/retire-gate.mjs)：九条 lint 规则各自都要有一个
新实现真的拦得住的必失败样本。九条逐条做过变异，全部变红。
