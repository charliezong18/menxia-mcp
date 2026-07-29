<div align="center">

**English** · [中文](README.zh-CN.md)

# zhupi-mcp

**The agent side of [zhupi](https://github.com/charliezong18/zhupi), as an MCP server.**<br>
zhupi is where a human reads and annotates AI-authored documents. This is the other end of that loop: the tools an agent uses to submit a document, read the annotations, and reply to each one.

[Spec](SPEC.md) · [Milestones](MILESTONES.md) · [Backlog](BACKLOG.md) · [zhupi (the app)](https://github.com/charliezong18/zhupi)

</div>

---

## Status: Phase 1 shipped (two read-only tools)

**Installable and usable.** `list_folders` and `read_comments` are implemented and wired into the MCP config; 119 unit tests plus 41 real-machine assertions are green, run against live GitHub data.

Measured context saved versus the string of `gh api` calls it replaces: **7.1×** for one folder, **3.9×** across all open folders (41 KB → 5.8 KB). That was the headline reason to build this, and the number holds.

Not yet implemented: `open_folder`, `lint_folder`, `audit_folders`, `reply_comment` — see Phase 2/3 in [MILESTONES](MILESTONES.md).

**One piece shipped earlier and is not part of the server**: the [route guard](SPEC.md) that refuses raw `gh pr create` against the folder repo. It lives in the review-loop skill and shipped first on purpose — see "What MCP does not fix" below.

Install:
```json
{ "mcpServers": { "zhupi": { "command": "node", "args": ["<repo>/dist/index.js"] } } }
```
Run `npm install && npm run build` first. Authentication borrows the machine's existing `gh`; no separate PAT.

Where things stand: [MILESTONES](MILESTONES.md) · [OPEN-QUESTIONS](OPEN-QUESTIONS.md)

## Why

The agent side of this loop already works. It lives in a `~/.claude/skills/review-loop/` skill: one 8KB prose file plus four bash scripts. It got hardened on 2026-07-28 after measuring what actually leaked — 3 of 8 submissions missed a required marker, 11 documents shipped without their translation pair. The conclusion was that prose reminders do not cure missed execution, only gates do, so the rules moved into scripts.

That fixed the rules. It did not fix three other things:

| | The pain |
|---|---|
| **Cross-harness** | A Claude Code skill only exists inside Claude Code. Every other agent runtime — Antigravity, Codex, the desktop app — cannot submit a document at all |
| **Context cost of reading back** | "Read the annotations" is a string of `gh api` calls plus the model parsing threads and inline positions by hand, every single time. Structured JSON collapses that to one call |
| **Untyped inputs** | Required fields live in prose. A missing one surfaces when a shell script dies halfway, not when the call is made |

## What MCP does *not* fix

Worth saying plainly, because it is the obvious thing to assume: **an MCP server does not stop an agent from bypassing it.** The model can still shell out to `gh pr create` and skip every gate. Moving the logic from bash to TypeScript changes the implementation, not the routing.

What blocks the route is a `PreToolUse` hook that refuses raw `gh pr create` against the review repo. That is ten lines of config, it is independent of this repo, and it ships first ([SPEC §7](SPEC.md)).

This distinction is the reason the spec exists. If you are considering the same move, decide which of the two problems you actually have.

## Tool surface

Six tools; **the two marked ✅ are shipped**. Merging is deliberately not one of them — that is the human's click, in the app.

| Tool | What it does |
|---|---|
| `open_folder` | Submit a document: branch, commit, push, open the PR, weld in the backlink marker, verify it landed |
| `lint_folder` | Check house style before submitting |
| `audit_folders` | Sweep everything already open for gaps |
| `list_folders` ✅ | List folders, most-recently-active first, with counts and previews of what needs a look |
| `read_comments` ✅ | Read annotations as structured JSON, with authorship and `answered` computed server-side |
| `reply_comment` | Reply to one annotation, or post an overall comment |

## How it works

![The review loop](assets/loop.png)

The repo in the middle is the whole interface. Neither side calls the other; both talk to GitHub. That is why zhupi can be taken off at any time, and why this server can be swapped for a bash script without the human noticing.

Node + TypeScript, stdio transport, installed by absolute path — no global npm state. GitHub auth is borrowed from `gh auth token` rather than managing a second PAT.

## Known limits

Honest list, in advance:

- **The concurrency fix is a file lock, not a queue.** A stdio MCP server is one process per session, not a shared daemon, so it cannot serialize across sessions on its own. `flock` plus a throwaway worktree does the job; the mechanism is worth knowing before you assume otherwise.
- **The session-backlink marker is best-effort.** It is detected by walking the process tree, which works only when the caller is a descendant of the host CLI. When it cannot be detected, nothing is embedded — a silently wrong id is worse than a missing button.
- **The lint rewrite is where the risk is.** The existing bash checks have accumulated fixes that a rewrite can silently drop. [SPEC §5](SPEC.md) documents each rule's *actual* behaviour (which drifts from its documentation in three places) and requires a differential test against the old scripts before shipping.
- **Personal-scale by design.** One reviewer, one review repo, no multi-tenant story.

## Fork it

The repo name and local checkout path are configuration, not constants:

```
ZHUPI_REVIEW_REPO=<owner>/<repo>     default: charliezong18/review
ZHUPI_REVIEW_PATH=<path>             default: ~/Developer/review
```

The conventions the tools enforce — bilingual pairs, cross-link headers, the five-section PR body — are one person's house style. Fork and change them; they are rules in one module, not assumptions spread through the code.

## License

[MIT](LICENSE) © Charlie Zong
