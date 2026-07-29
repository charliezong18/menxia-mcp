**English** · [中文](MILESTONES.zh-CN.md)

# Milestones

The rollout order lives in [SPEC §8](SPEC.md). This file adds the thing the spec does not have: **what proves a phase is done.**

**Written ≠ done.** Phase 0 was written in about an hour and done three hours later — the gap was three false positives that only a test suite surfaced, one of which was a silent security hole. Every exit criterion below is therefore falsifiable and observed, never "the code exists."

## Phases

| Phase | Exit criteria (falsifiable) | Status |
|---|---|---|
| **0 · Route guard** | 21/21 in `guard-pr-create.test.sh`; both paths observed live (a blocked call actually refused, a legitimate call actually passed); SKILL.md and SPEC §7 agree with the code | **✅ 2026-07-28** |
| **1 · Read-only tools** | `read_comments` returns the real annotations on a real folder with `answered` correct against a hand count; `list_folders` unanswered counts match | not started |
| **2 · lint_folder** | Differential test over every open folder plus one must-fail sample per rule; new and old outputs align line by line, every difference either fixed or documented in SPEC §5.2 | not started |
| **3 · Write tools** | One folder opened end to end through `open_folder`; two concurrent sessions provably do not collide (flock observed, not assumed); the backlink marker read back from the live PR body | not started |
| **4 · Retirement** | With all four bash scripts deleted, one full round completes: open → read → reply; SKILL.md reduced to glossary + tool pointers; hook message points at the MCP tool; the SPEC §5.3 #6 documentation debt paid | not started |

**The largest risk now sits in Phase 2, not Phase 1.** Phase 1 used to carry "can agy mount an MCP server" — that check was voided on 2026-07-29 when agy was dropped ([SPEC §1](SPEC.md)). It was not answered, it was routed around. **The risk did not disappear, it relocated**: what is most likely to ruin this project now is the Phase 2 lint port silently losing accumulated fixes. That is not a failure you can observe — the scripts are gone, the tests are green, and the mistakes happen anyway. Only the differential test catches it.

## What actually happened

Appended per phase. Never rewritten.

| Date | Phase | What happened |
|---|---|---|
| 2026-07-28 | 0 | Shipped after **three false positives, all one root cause: treating "the string appears" as "this command will run."** ① Scanned the whole command line, so `create -R other-repo && view -R folder-repo` was blocked — keywords in different segments. Fixed by splitting on `&& \|\| ; \|`. ② Blocked the guard author's own `git commit`, because the commit message named the command and the cwd happened to be a folder-repo worktree. Fixed by requiring the segment to *begin with* `gh` after stripping env prefixes, `bash -c` wrappers, and absolute paths. ③ The stripping `sed` used basic-regex alternation, which **BSD sed does not support** — the rule was dead on arrival and silent, leaving the `bash -c` bypass wide open. Only the test caught it, and `folder-lint.sh` already carries a comment warning about this exact trap. |

## Keeping this file honest

zhupi's own ledger stalled for 7 commits with an indicator tripped the entire time. The retro's conclusion is worth copying verbatim: **the lesson isn't "we forgot," it's that booking had no trigger** — feature commits and measurement commits were separate, held together by nothing but good intentions.

**Right now this file has no trigger either**, and that is a known debt, not an oversight. It is tolerable only because one phase is done and the table is short. When Phase 1 lands code, the trigger goes in with it: the test runner prints the phase table's status line, so every run forces the number into view. Until then, treat an unchanged "not started" as unverified rather than accurate.
