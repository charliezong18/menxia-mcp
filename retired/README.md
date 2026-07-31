**English** · [中文](README.zh-CN.md)

# Retired scripts (archive, do not run)

These are the four bash scripts this MCP server replaced, preserved verbatim at the moment
of deletion (2026-07-30, Phase 4).

**Why they are here and not just deleted.** They lived in `~/.claude/skills/review-loop/`,
which is **not under version control** — deleting them there is irreversible. And SPEC §5.1
("port from the implementation, not from the documentation") cites their line numbers
throughout. An archive next to the thing that replaced them keeps those citations checkable.

**Do not run them.** They are kept as reference, not as a fallback. Two of them carry known
defects (below) that are exactly why the port happened.

| Script | Replaced by | Note |
|---|---|---|
| `open-folder.sh` | `open_folder` | Its scope was **narrower**: it only linted and created the PR. Branching, copying files, commit and push were prose in `SKILL.md` — this project measured prose-only requirements at a 37.5% miss rate |
| `folder-lint.sh` | `lint.ts` + `lint_folder` | **Known defect, see below** |
| `audit-folders.sh` | `audit_folders` | Its `--fix` was deliberately *not* ported — see SPEC §3.3 |
| `happy-session-id.sh` | `session.ts` | The "after a hit, verify this pid really is happy" line was ported verbatim (SPEC §4.4) |

## Two defects preserved on purpose

**`folder-lint.sh:58` — a false pass that lasted the script's whole life.** The `${ZH}（`
contains a full-width parenthesis, which bash counts as part of the identifier. Under
`set -u` the subshell running the slug loop dies on the spot, `FAIL` stays 0, and **the
whole script prints "house style OK" and exits 0**. The entire "missing Chinese version"
class was never once caught. It does not reproduce under `LC_ALL=C`, which is why nobody
found it. Note that during the parallel window `PARITY.md` said "the old script is
authoritative" — on this class, that instruction was wrong.

**`open-folder.sh:65` — the same shape**, `$sec」`.

## Why the retirement criterion changed

The original rule (design D1) was "10 consecutive submissions with zero disagreement".
All three of its legs broke on the same day it was set; see the block at the top of
[`PARITY.md`](../PARITY.md). The criterion that actually released these scripts is
[`scripts/retire-gate.mjs`](../scripts/retire-gate.mjs): every one of the nine lint rules
must have a must-fail sample the new implementation really catches. All nine were
mutation-checked one at a time and every one turned red.
