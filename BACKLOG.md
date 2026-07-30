**English** · [中文](BACKLOG.zh-CN.md)

# BACKLOG

Things that are thought through but not scheduled.

**Scheduling rule**: nothing here is touched until [MILESTONES](MILESTONES.md) Phase 4 lands — that is, until the bash scripts are retired and one full round has run through the MCP tools. Anything added before then competes with a loop that does not close yet. During that window only bugs and friction that is actually in the way get fixed. No new B items unless a real submission hit the problem.

## B1 · Multiple documents in one folder

**What**: `open_folder` currently assumes one bilingual pair per folder. Let a folder carry several documents.

**Why**: a review round sometimes has a natural set — a spec plus its migration notes, or four review archives translated in one batch. Today that is either four folders (four separate reading sessions) or one folder that quietly violates the slug convention.

**How**: `docs[]` already takes a list, so the plumbing exists; what is missing is the lint rule — pair-matching currently derives one slug and would need to group by slug instead. `folder-lint.sh` already groups by slug (it strips `.zh-CN` and dedupes), so the logic is portable rather than new.

**Undecided**: whether zhupi's reading UI handles a multi-document PR well enough for this to be worth it. Check before building — this is a frontend question, not a server one.

## B2 · Feed bilingual gaps straight to a translator

**What**: `audit_folders --fix` reports missing translation pairs but cannot fill them. Let it hand the gap to a translation agent and write the result back.

**Why**: the 11-documents-missing-a-pair backlog was cleared by hand-dispatching three batches to a translation agent. That is exactly the shape of work a tool should own.

**How**: shell out to whichever translation agent is in use (no longer assumed to be agy as of 2026-07-29) with the prompt discipline that already works (self-contained, absolute paths, forbid directory search, never fabricate), then run the structural acceptance check — line count, heading count, code-block count — before writing anything.

**Undecided**: whether a machine should ever write a translation without a human comparing it. The one real run produced zero high-severity errors but six medium ones, all from mechanical glossary substitution, and a human caught them. Auto-writing without that pass would have shipped them.

## B3 · Infer assets instead of passing them

**What**: `open_folder` takes an explicit `assets[]`. Parse the documents for image references and copy those instead.

**Why**: one more thing to remember is one more thing to forget, and forgetting it produces exactly the broken images the lint exists to catch.

**How**: reuse the reference scanner from `lint.ts` — same code path that has to strip code blocks and inline code anyway (SPEC §5.1).

**Undecided**: whether to keep `assets[]` as an override for images referenced in ways the scanner does not see (HTML `<img>`, or a file that should ship but is not linked).

## B4 · A dry-run mode for open_folder

**What**: `open_folder({dryRun: true})` — run every check, build the body, resolve the marker, report exactly what would be created, and stop before the PR.

**Why**: the write path is the one with the highest cost of being wrong, and today the only way to exercise it is to actually create something.

**How**: the lock and worktree still get taken so the branch-base check is real; everything after the GitHub call is skipped.

**Undecided**: whether this is worth its own parameter or is just what a good test harness gives you for free.

## B5 · Support more than one folder repo

**What**: today the repo is a single environment variable. Allow a set, selected per call.

**Why**: speculative. Recorded so it does not get argued about again — the answer is no until there is a second repo.

**How**: n/a.

**Undecided**: nothing. This is a "no" with its reasoning attached, not a plan.

## B6 · Push one line when annotations arrive

**What**: notify when a folder gets new annotations, rather than the agent polling `list_folders`.

**Why**: the current loop is "ask whether he has reviewed it," which costs a round trip every time and is usually answered no.

**How**: out of scope for an MCP server — a server only speaks when spoken to. This belongs in a GitHub Action or the existing ntfy setup. Recorded here because it is the natural next thought after `list_folders` and should be pointed elsewhere rather than re-litigated.

**Undecided**: whether zhupi's own BACKLOG F10 (push one line when a document arrives) already covers the mirror image of this, in which case both live there.

## Paginate the merged listing (noted 2026-07-30; will bite around mid-August 2026)

`list_folders({state:'merged'})` fetches `pulls?state=closed&per_page=100`, and `get()`
fails outright on `rel="next"`. Review round 3 did the arithmetic: the repo grew from #1
(07-26) to #31 (07-30), roughly 7 folders/day, with 15 closed today — **it crosses 100 in
about two weeks**, at which point the tool stops working entirely.

The "fail loudly rather than silently return fewer" decision stands, but by then the error
text must at least offer a usable detour (list open only, or `read_comments(pr)` directly).
Not doing it now because the open side is much further away (16).

## Debts left by Phase 2's first review round (noted 2026-07-30)

**① `$ZH（` in the old `folder-lint.sh:58` is an unbound bash variable.** The full-width
parenthesis counts as part of the identifier, so under `set -u` the subshell running the slug
loop **dies on the spot** — meaning the "missing Chinese version" rule **has never worked**,
and every slug sorted after it goes unchecked too. Same disease at `open-folder.sh:65` (`$sec」`).

Consequence: "the old script is authoritative" is wrong for this one rule during the
reconciliation window, and such folders still get submitted. Out of scope for Phase 2 because
touching the old script means touching the gate itself; but **it keeps one differential row
permanently red** (registered as "old-script bug, new implementation correct").

**② The old script prints git-escaped Chinese filenames straight at the user**
(`✗ guanzhi-00-\345...md" 缺英文版`), because it does not set `core.quotePath=false` either.
A display bug; the verdict itself is right.

**③ Image resolution for docs in subdirectories disagrees with GitHub.** The `*` in the
`docs/*.md` pathspec crosses `/`, so `docs/sub/x.md` is checked; but references are always
resolved against `docs/assets/` while GitHub resolves them relatively (`docs/sub/assets/`).
Wrong in both directions. Inherited from the old script; fixing it widens scope.

**④ Image references inside indented code blocks and HTML comments raise false hard errors.**
`stripCode` only strips unindented fences and inline code; a fence indented four spaces inside
a nested list, or `<!-- ![x](assets/y.png) -->`, both read as real references. The "a document
about lint rules cannot pass lint" case history is only half closed.

**⑤ The submission gate guards against slips, not against going around it.** The first review
round measured six bypasses: wrapping in a script, `xargs`, `eval`, python `subprocess`,
`git push` plus creating the PR in the web UI, and any non-Claude-Code runtime (agy, a plain
terminal). The three PreToolUse hooks only attach to Claude Code's Bash tool; no amount of
added patterns closes this layer.

The only real closure is to **move the criterion into the repo** (CI on main validating the
format of every PR). That is Phase 3/4 scope, and it needs Charlie's sign-off first — adding CI
changes how submission feels to him.
