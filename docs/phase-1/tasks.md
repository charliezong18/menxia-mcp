**English** · [中文](tasks.zh-CN.md)

# Phase 1 task breakdown — read-only tools

> Third of three stages. Both [requirements](requirements.md) (#19) and [design](design.md) (#20) have received final approval.
> **Executed one at a time** — each task stops, gets accepted, and only then does the next begin. Not run end to end in one go.

## What the ordering is based on

Not "easy first" but **"whichever is costliest to get wrong goes first"**:

1. **Pure logic before IO.** `threads.ts` carries all of R4's semantics and is the one place in this phase where being wrong raises no error — the answer is just quietly incorrect. It has no IO, so it can be tested thoroughly while the network, authentication, and MCP wiring do not exist yet.
2. **Tool wiring after the capability is ready.** First have something that computes correctly, then attach it to MCP.
3. **Real-machine acceptance is its own task.** All-green unit tests do not mean it works; pulling "actually run it once" out on its own is what keeps the green from fooling us.

---

## T1 · Skeleton: it starts, and it can be mounted

**Deliverable**: build and run scripts in `package.json`, `tsconfig.json`, `src/index.ts` (MCP server wiring plus registration placeholders for the two tools), `src/config.ts`.

**Exit criteria**
- `npm run build` succeeds and produces `dist/index.js`
- Started over stdio, it lists `list_folders` and `read_comments` in response to `tools/list`
- With `ZHUPI_REVIEW_REPO` unset the default `charliezong18/review` applies; when set, the set value applies
- No global state is produced

**Why first**: every later task needs a running shell to hang tests on.

**Risk**: stdio wiring with the MCP SDK is the only technical move in this phase that has not been done before, and it may snag on versions or ESM. **If it snags, stay snagged — do not route around it with a different transport**, because changing the transport invalidates R1's criteria.

---

## T2 · `threads.ts` — the answered determination

**Deliverable**: a pure-function module plus unit tests. No IO, no network imports.

**Exit criteria** (each preceded by a test that must fail first)
- inline: a root with a reply beneath it → answered; without → unanswered
- inline: **self-reply → reads as answered** (design §3.1 explicitly accepts this failure; the test **pins the behaviour down** rather than avoiding it)
- conversation: alternating (his one, mine one) → the earlier one is `"inferred"`
- conversation: **two in a row → the first is `"inferred"`, the second is `false`** (design §3.2's known miss, likewise pinned)
- conversation: a single comment → `false`
- empty input → empty result, no exception
- **the three-state value never returns `true`** (a hard constraint of this phase)

**Why second**: it is the only module where being wrong raises no error. Get it wrong and `list_folders` still returns numbers — just the wrong ones — and you only find out after a real annotation has been missed.

**Risk**: someone "fixing" the two known failures from design §3. **They are deliberate; the tests exist to stop a future tidy-up from removing them.**

---

## T3 · `errors.ts` — the four failure messages

**Deliverable**: a failure-cause → one-sentence mapping, plus unit tests.

**Exit criteria**
- Authentication unavailable / repo missing or inaccessible / folder number missing / network failure each return the sentence from design §6
- **No sentence contains a token or a stack trace** — the unit test plants a fake token in the error object and asserts it cannot be found in the output
- Unanticipated errors get a fallback sentence rather than leaking raw

**Why before `github.ts`**: so `github.ts` speaks human from birth, instead of throwing raw exceptions in one version and getting wrapped later.

---

## T4 · `github.ts` — authentication and read-only fetching

**Deliverable**: the Octokit wrapper, lazy authentication, and **R7's read-only guard test**.

**Exit criteria**
- `gh auth token` runs on first actual use, and the result is cached in memory
- 401 → refetch once → second 401 → return T3's authentication message
- Only GET methods are exposed; no POST/PATCH/PUT/DELETE appears in the module
- **Guard test**: scan `src/` and fail if any non-GET Octokit call appears
- With the network down, T3's network message is returned rather than a stack trace

**Risk**: writing the guard test so that it only scans the lines I wrote makes it useless. It must scan **all of `src/`**, and must come with a self-check that deliberately adding a POST line turns it red.

---

## T5 · `readFolder` plus the `read_comments` tool

**Deliverable**: feed the raw data from `github.ts` into `threads.ts`, assemble design §4's return shape, and attach `read_comments`.

**Exit criteria**
- Given a folder number, return that folder; given none, sweep every open folder
- inline is **a tree with nested `replies`**, not a flat array plus `inReplyToId`
- `quote` comes from the last line of `diff_hunk`; when unavailable it returns an empty string instead of crashing
- The return contains no "raw JSON, model picks it apart" field
- Missing folder number → T3's message

**Risk**: `diff_hunk` may be absent or unexpectedly shaped. **When it cannot be read, return an empty string** — do not guess to fill it in.

---

## T6 · The `list_folders` tool

**Deliverable**: reuse `readFolder` and project it down to counts.

**Exit criteria**
- `state=open` (default) and `merged` both correct
- Each entry carries number, title, branch name, and **the unanswered count split three ways** (`inline` / `conversation` / `inferred`)
- **The counts agree with `read_comments`' full result** — one test calls both tools and compares, so the two sides cannot drift apart
- No folders at all → empty list, no error

**Risk**: taking the shortcut of writing a second counting path. **`readFolder` must be reused** — that is the rule design §2 set.

---

## T7 · Real-machine acceptance plus mounting instructions

**Deliverable**: a real run, its result written into [MILESTONES](../../MILESTONES.md), and the MCP config snippet added to the README.

**Exit criteria**
- Run `read_comments` against **#18** → `needsReply` is 0 (the sample requirements R3 spells out)
- Run against **#19** (merged, zero annotations) → no crash, empty annotations returned
- `list_folders` unanswered counts match a **hand count** (final acceptance for R2/R4)
- Mounted in a real Claude Code session with both tools called successfully (R1)
- The Phase 1 row in MILESTONES flips from "not started" to ✅ with a "what actually happened" entry appended

**Why its own task**: all six previous tasks going green proves only that the code works the way I assumed. **This one proves it is right in the real environment** — two different things, which is why design §8 lists the real-machine run separately.

---

## Not in this phase

Opening folders, house-style linting, auditing, replying, final approval; caching, pagination, GraphQL, concurrency control.

## One deliberate deviation

The standard way to write a plan requires full code in every step, which assumes an executor with zero context. This plan's executor is me, with full context, so the document stops at **boundaries, criteria, and risks**, and the code gets written when execution reaches that step. **What that buys is a document you can actually read and annotate** — a plan you cannot review is a plan that was never reviewed.
