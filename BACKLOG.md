**English** · [中文](BACKLOG.zh-CN.md)

# BACKLOG

Things that are thought through but not scheduled.

**Scheduling rule**: nothing here is touched until [MILESTONES](MILESTONES.md) Phase 4 lands — that is, until the bash scripts are retired and one full round has run through the MCP tools. Anything added before then competes with a loop that does not close yet. During that window only bugs and friction that is actually in the way get fixed. No new B items unless a real submission hit the problem.

## B1 · Multiple documents in one folder

**What**: `open_folder` currently assumes one bilingual pair per folder. Let a folder carry several documents.

**Why**: a review round sometimes has a natural set — a spec plus its migration notes, or four review archives translated in one batch. Today that is either four folders (four separate reading sessions) or one folder that quietly violates the slug convention.

**How**: `docs[]` already takes a list, so the plumbing exists; what is missing is the lint rule — pair-matching currently derives one slug and would need to group by slug instead. `folder-lint.sh` already groups by slug (it strips `.zh-CN` and dedupes), so the logic is portable rather than new.

**Undecided**: whether menxia's reading UI handles a multi-document PR well enough for this to be worth it. Check before building — this is a frontend question, not a server one.

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

**Undecided**: whether menxia's own BACKLOG F10 (push one line when a document arrives) already covers the mirror image of this, in which case both live there.

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

**⑤ The submission gate guards against slips, not against going around it. — measured 2026-07-31; not doing it for now, reasoning below.** The first review
round measured six bypasses: wrapping in a script, `xargs`, `eval`, python `subprocess`,
`git push` plus creating the PR in the web UI, and any non-Claude-Code runtime (agy, a plain
terminal). The three PreToolUse hooks only attach to Claude Code's Bash tool; no amount of
added patterns closes this layer.

The only real closure is to **move the criterion into the repo** (CI on main validating the
format of every PR). That is Phase 3/4 scope, and it needs Charlie's sign-off first — adding CI
changes how submission feels to him.

**Talked it through 2026-07-31. Verdict: not yet.** Three numbers, each pointing the same way independently:

| What was measured | Result |
|---|---|
| Did anyone actually go around it | **0/18** — every open folder carries the return-to-session marker, i.e. all went the proper route. Those 6 bypass routes are reasoned, not observed |
| How much house style actually drifted | 17/18 clean, and the single hit was a **false positive** (#31 should have had the monolingual exemption) |
| Does the annotation desk show check status | **No.** Across menxia's 23 source files, `check_run` / `checkSuite` / `statuses` / `mergeable_state` all return zero hits |

The third is decisive: a required check would **light up red where he cannot see it, then block the one button he cares about (画可)** — invisible signal plus blocking action. Advisory would just be a red X nobody reads.

**And that single red exposed a different, real debt**: the `docs/.monolingual` exemption had never once been usable (a file inside the repo, and `open_folder` had no path that could create it), so #31 reported 22 false hard findings for its whole life. **A check that starts reporting false red is a check people learn to ignore** — that is killing this gate more concretely than any bypass. Fixed (`open_folder`'s `monolingual` flag, plus a one-off registration for #31); the sweep is now 19/19 clean.

**Reopening criteria**: the first real bypass (an open folder with no return-to-session marker), or `audit_folders` reporting drift that is not a false positive. Until then detection belongs to `audit_folders()` — same core, sweeps every open folder, never touches the merge path.

## B7 · One fragment per folder for the registries (`.payload` / `.monolingual` are collision magnets)

**What**: `docs/.payload` and `docs/.monolingual` are each **a single shared line-list file**. Change them to one fragment per folder (`docs/.payload.d/<slug>`), or drop the registry entirely and put the exemption marker inside the document itself.

**Why**: hit for real on 2026-07-31 — #7 and #35 each created `docs/.payload` to register their own outbound document, so both sides "added" the same filename, collided add/add, and #35 failed to merge a second time. **Nothing to do with content; the file shape alone determines it**: any two folders registering at the same time must collide, and since a registry is union-semantic by definition, every one of these conflicts is 100% spurious — git has never once stopped something that genuinely needed a human. `.monolingual` has the same shape, and **the next collision can already be predicted**: it has never reached main (only the open folder #31 carries it), so the moment a second folder registers a monolingual document it will collide with #31 in exactly the same way.

This is the same root as the `.monolingual` debt above: **a writable file shared across folders**. Last time the symptom was "can't be created at all"; this time it's "two folders create it at once".

**How**:

- Cheap tier: `docs/.payload.d/<slug>` — one file per folder, lint reads the whole directory and unions it. Different folders write different filenames, so they can never collide. On the `open_folder` side it's just "write a fragment" instead of "write the file".
- Ceiling: put the exemption marker in an HTML comment on the document's first line (e.g. `<!-- payload -->`) and delete the registry outright. The marker travels with the document, which buys one more thing: **no dangling entries when a file is deleted but its registration isn't** — and a shared list is guaranteed to accumulate that kind of garbage.

**Undecided**: which tier. Fragments are a purely mechanical change that preserves today's lint structure and do eliminate the collisions outright — but they can't fix the dangling entries that come from keeping registration separate from the document. The in-document marker solves both at once, at the cost of changing lint's read path. Leaning towards the latter.

**Meets the scheduling rule**: this came out of a real folder submission, not from speculation.

## B8 · Legacy-word gate: first push of any new branch is a guaranteed false positive (hit for real 2026-08-08)

**What**: on a new branch's first push (remote sha all zeros) the pre-push hook cannot compute an increment and, per "only fail toward stricter", degrades to scanning the whole tree at HEAD — inevitably hitting two old files outside the exclusion list: `docs/phase-1/tasks.zh-CN.md` (cites protocol constants) and `retired/SKILL.md.orig` (an archived snapshot). Net effect: every new branch needs the `--no-verify` escape, which both neuters the gate and trains the bypass reflex.

**Why**: 签 v1 (review #116) hit this pushing `feat/qian-tags`. The added lines themselves were clean (legacy-word scan: 0); everything blocked was pre-existing history.

**How**: pick one. ① Cheapest: add those two files to `LEGACY_SKIP` (same rationale as the existing exclusions — one cites protocol constants, one is an archive); ② root fix: change the whole-tree fallback to scan only the commits being pushed (`git rev-list <lsha> --not --remotes` or similar), with its own self-test. Per house rules, run the hook's self-tests before touching it.
