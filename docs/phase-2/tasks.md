**English** · [中文](tasks.zh-CN.md)

# Phase 2 task breakdown

> Upstream: [requirements](https://github.com/charliezong18/review/pull/32) (sealed) · [design v3](https://github.com/charliezong18/review/pull/33) (D5/D7/D8 decided)
> **Execute one at a time**; clear each task's criterion before starting the next.

## Dependency order

```
T1 stripCode ──► T2 lint.ts ──┬──► T3 scar list (the ship gate)
                              ├──► T4 snapshot.ts ──► T5 CLI + T6 tool ──┬──► T7 R7 sweep
                              │                                          └──► T9 wiring
                              └──────────────────────────────────────────────► T8 differential
                                                                              T10 review + docs
```

T1 comes first because rules 4 and 5 both depend on it, and getting it wrong misfires **both at once in opposite directions** (4 under-reports broken images, 5 over-reports language) — hard to notice by watching.

## T1 · The shared `stripCode` helper

Strips fenced code blocks and inline code (R4: rules 4 and 5 must share one implementation).

**Criterion**: one case each for unbalanced backticks, fences inside fences, `~~~` fences, inline code spanning lines.

## T2 · `lint.ts` pure core: 9 rules

Snapshot in, findings out, **no IO**. Rule table in design §2.

**Criterion**: one passing and one must-fail case per rule, all against inline fake snapshots — no git repos. Rule 5's severity is warning (D5).

## T3 · The scar list — this is the ship gate

About ten tests **named after the incident**, with the case history pinned in a comment (design §3's table). Template: `~/.claude/skills/review-loop/guard-var.test.sh`.

**Criterion**: (1) each test's name carries the incident and its comment carries the case-history date; (2) **breaking the corresponding rule must turn it red** — actually run the mutation, do not merely claim it.

D7 decided this replaces the differential as the gate, because the differential dies with the old script, 14 of 16 real folders are no-ops for it, and it cannot cover rules 5 and 9.

## T4 · `snapshot.ts`: fed by git subprocesses

Via `git show <ref>:<path>` / `git cat-file`. **Never imports fs** — `guard.ts` pins this, and the `node:fs/promises` bypass was only closed on 2026-07-30.

**Criterion**: one happy-path case against a real git repo plus one for the failed-`fetch` branch; the guard's `src/` scan stays at zero violations under `npm test`.

## T5 · `lint-cli.ts` + T6 · the `lint_folder` tool

- CLI: findings → ✓/✗/⚠ text plus exit code 0/1, for `open-folder.sh`; `--parity` compares normalised finding sets
- MCP: `lint_folder({ worktree, ref })`, structured output, local reads only, no network

**Criterion**: both mouths reach the **same conclusion** for the same folder — assert the findings are field-identical, not merely that both say "fine".

## T7 · R7: the sweep uses the same core

D3 decided they share `lint_folder`. The sweep calls it once per open folder's branch; the only difference left is whether the GitHub layer (session backlink marker / draft) is also called, and that layer belongs to Phase 3.

**Criterion**: the five inconsistencies in R7's table (cross-link header / broken images / `.payload` / bilingual direction / five sections) measurably disappear across the real 16 open folders. **Read side only; `--fix` untouched.**

## T8 · The differential, as a one-off comparison

Demoted by D7: run once and keep it, do not build standing infrastructure. Reuse `scripts/acceptance.mjs`'s `check()/ok()/bad()`; build samples in `/tmp`.

**Criterion**: every difference classified as either a bug or a deliberate improvement (rules 5 and 9 are the latter); **self-verified once** by deliberately introducing a difference and confirming it is reported.

## T9 · Wiring

```sh
OLD=0; sh folder-lint.sh . || OLD=$?     # || is required; under set -euo pipefail, `; OLD=$?` kills the submission outright
NEW=0; node "$LINT_CLI" . --parity || NEW=$?
[ "$OLD" -eq 0 ] || exit 1               # the OLD one is authoritative during the window
```

Parity results go into `PARITY.md` in the repo, with the existing trigger at the end of `npm test` printing the consecutive-agreement count (**no hand-written file in the home directory** — that is the "copy that will drift" this project already argued against). `SKIP_LINT=1` leaves a line and announces on stderr (D8).

**Criterion**: (1) with the two lints deliberately disagreeing, submission still completes and prints the difference; (2) after one `SKIP_LINT` run, `PARITY.md` records it.

## T10 · Three review rounds plus paying the doc debt

Three rounds after implementation, each with a different lens, **at least one looking outside the repo**.

Docs: mark in SPEC §5 what is implemented and that **R2 was amended by D7**; append one row to MILESTONES (never rewrite old rows); add `lint_folder` to the README's tool surface; put the retirement condition (10 consecutive runs with zero disagreement) at the top of `PARITY.md`.

**Criterion**: no drift where a doc says "to be implemented" while the code has it, or vice versa — three such cases were found before, and SPEC §5.1 exists because of them.

## Out of scope

`audit-folders.sh --fix` (Phase 3) · deleting the old script (D1 chose parallel reconciliation) · the "missing sections also block" line in SKILL.md (Phase 4) · merged pagination (BACKLOG, due mid-August) · `bin` in `package.json` (pinned by the guard)
