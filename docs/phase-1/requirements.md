**English** · [中文](requirements.zh-CN.md)

# zhupi-mcp Phase 1 requirements — read-only tools

> First of three stages (requirements → design → tasks). This document answers only **what counts as correct**, never how to build it — technology choices, module boundaries, and data flow all belong to the design stage.
> Background in [SPEC](https://github.com/charliezong18/zhupi-mcp/blob/main/SPEC.md); phase exit criteria in [MILESTONES](https://github.com/charliezong18/zhupi-mcp/blob/main/MILESTONES.md).

## The pain this phase addresses

**"Read the annotations" burns a large slice of context every single time.** The model has to fire a string of `gh api` calls, parse threads and inline positions by hand, and re-derive "which ones have I not answered yet." That cost is paid on every turn of the loop, which is why it ranks first in SPEC §1.

Phase 1 is **read-only** — the lowest cost of being wrong, and the benefit is cashed immediately.

---

## R1 · The server can be mounted

**Must hold**: after Claude Code mounts the server by local absolute path, its tools are visible and callable in a session.

**How it passes**

- After the config is written and the session restarts, `list_folders` and `read_comments` appear in the tool list
- Calling each once returns data, not an error
- No global state is produced anywhere in the process (no `npm link`, nothing written to `/usr/local`)

---

## R2 · List folders — "what is waiting on me"

**Must hold**: one call is enough to know which folders are open, and **which ones I have annotated but nobody has answered**.

**How it passes**

- `state=open` (default) returns every unmerged folder, each with: number, title, branch name, and **unanswered annotation count**
- `state=merged` returns folders that have received final approval
- The unanswered count matches a hand count (see R4)
- When the folder repo has no folders at all, an empty list is returned rather than an error

---

## R3 · Read annotations — structured in one call

**Must hold**: what the model receives is directly usable, with no further parsing or inference.

**How it passes**

- Given a folder number, return that folder; given none, sweep every open folder
- Each inline annotation carries: annotation id, file path, line number, **the highlighted quote**, the annotation body, thread membership (which one it replies to), and **whether it has been answered**
- Conversation comments carry body, author, and **whether they have been answered**
- The return contains no "raw JSON, model picks it apart" section
- **Verified against the preceding folder (#18) as a real sample**: it has one conversation comment and we already replied → unanswered count must be 0

---

## R4 · "Unanswered" must mean what a human means

**Must hold**: the "unanswered" the server computes is the same thing as your "you still haven't answered me."

**How it passes**

- An inline annotation with no reply from us → unanswered
- A comment of yours in the conversation area with no later comment from us → unanswered (**listing opinions in one block without highlighting lines also counts as annotating**, which is the existing convention)
- Annotations we posted ourselves do not count toward unanswered
- The determination happens on the server, not by handing the raw list back for the model to work out

---

## R5 · No new credential to maintain

**Must hold**: no second key that expires and has to be remembered.

**How it passes**

- Uses the GitHub authentication already present on the machine; no separate PAT required
- When authentication fails, the message says plainly what to go do about it

---

## R6 · Errors are actionable for the model

**Must hold**: on failure the return says "here is what to fix," not a stack trace.

**How it passes**

- Authentication unavailable, repo missing, folder number missing, network failure — each has one sentence a human and a model can both read
- No token appears in any error

---

## R7 · Strictly read-only

**Must hold**: this phase cannot change any remote state.

**How it passes**

- No code path contains a create, update, or delete call against the remote
- Even if invoked by mistake, nothing in the folder repo changes

---

## Non-goals (explicitly not in this phase)

Opening folders, house-style linting, auditing, replying, final approval. **Cross-harness is not verified either** — agy is out and Codex is not urgent; that criterion was removed from Phase 1 on 2026-07-29.
