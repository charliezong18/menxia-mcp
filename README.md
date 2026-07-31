**English** · [中文](README.zh-CN.md)
<div align="center">

# zhupi-mcp

**The agent-side of [the annotation desk (zhupi)](https://github.com/charliezong18/menxia), built as an MCP server.**<br>
The annotation desk (zhupi) is where humans read long documents written by AI, highlight sentences, and leave comments. This repo is the other end of that loop: the set of tools used by the agent to submit a folder, read back comments, and reply to them one by one.

[Design Spec](SPEC.zh-CN.md) · [Milestones](MILESTONES.zh-CN.md) · [Backlog](BACKLOG.zh-CN.md) · [zhupi core](https://github.com/charliezong18/menxia)

</div>

---

## Status: Phase 3 is live (seven tools, two of which can write to remote)

**Installable, usable.** All seven tools are implemented and tested: `list_folders` / `read_comments` / `lint_folder` / `audit_folders` are read-only, `mark_handled` only writes to local files, `open_folder` / `reply_comment` write to remote. 510 unit tests + e2e acceptance all green, running against real GitHub data.

**There are only two holes for remote writes.** `WRITE_ALLOWED` is a literal whitelist, matching route templates exactly. Requests outside the whitelist are intercepted by a runtime hook (read instances still cannot issue any non-GET request):

```
POST /repos/{owner}/{repo}/pulls                                          create a folder
POST /repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies                reply
```

Modifying a folder, deleting a folder, or merging a folder are all impossible. `mark_handled` only writes to `~/.zhupi-mcp/processed.json`, **without touching GitHub** — the stance for R7 is therefore "only these two are allowed for remote", and there are guard rules locking down the whitelists for fs writes and git writes (and the **length** of the whitelists is pinned down by tests, adding a member must be seen by a human once).

Measured context saved (compared to the old `gh api` chain): reading a single folder **7.1×**, reading all open folders **3.9×** (41 KB → 5.8 KB). This is the number one reason for building this thing; the numbers hold up.

The gains on the submit a folder side are another matter: **the agent does not touch `~/Developer/review` at all** (branching, copying files, commit, push are all in a temporary worktree managed by the server, serialized across sessions with file locks), whereas before that entire segment was only written in the prose of SKILL.md — this project measured its own prose omission rate to be 37.5%.

**There is another piece that went live early and does not belong to the server**: the [route guard](SPEC.zh-CN.md) that rejects bare `gh pr create` against the folder repo. It lives in the review-loop skill, and was shipped first deliberately — the reason is in "What MCP cannot cure" below.

Installation:
```json
{ "mcpServers": { "menxia": { "command": "node", "args": ["<repo>/dist/index.js"] } } }
```
Run `npm install && npm run build` first. Authentication borrows the existing `gh` on the machine, no need to configure a separate PAT.

Progress and open questions: [MILESTONES](MILESTONES.zh-CN.md) · [OPEN-QUESTIONS](OPEN-QUESTIONS.zh-CN.md)

## Why build it

The agent side of this loop could already run, living in the `~/.claude/skills/review-loop/` skill: an 8KB prose plus four bash scripts. It just went through a round of hardening on 2026-07-28, prompted by measuring what was actually missed — out of eight submit a folder actions, three missed required markers, and eleven documents lacked translation pairs. The conclusion is that prose reminders cannot cure omission; only gates can, so the rules were moved into the scripts.

That fixed the rules, but left three other things unfixed:

| | Where it hurts |
|---|---|
| **Cross-harness** | Claude Code's skill only exists inside Claude Code. Other agent runtimes — Antigravity, Codex, desktop clients — simply cannot submit a folder |
| **Context cost of reading back** | "Reading comments" is a chain of `gh api` plus manual model parsing of threads and inline positions, which must be repeated from scratch every time. Structured JSON can compress it into a single call |
| **Untyped inputs** | Required fields are written in prose. If missed, you only know when the shell script dies halfway through, instead of at the exact point of call |

## What MCP cannot cure

This must be stated plainly, because it is exactly where assumptions are easiest to make: **an MCP server cannot stop an agent from bypassing it.** The model can still shell out directly and run `gh pr create`, skipping all gates. Moving logic from bash to TypeScript swaps the implementation, not the routing.

What blocks the routing is a `PreToolUse` hook — rejecting bare `gh pr create` against the folder repo. That is a ten-line config, independent of this repo, and went live first ([SPEC §7](SPEC.zh-CN.md)).

This distinction is the reason this spec exists. If you are also considering the same thing, first figure out exactly which problem you have on hand.

## Tools surface

Seven, all live. merge is deliberately excluded — that is clicked by the human in the app ("sealed (squash-merged)"), and there is no reason for the agent side to hold this capability.

| Tool | What it does | What it writes |
|---|---|---|
| `open_folder` | The full submit a folder process: copy documents into a temporary worktree, branch, commit, **check house style**, push, open PR, hardcode return-to-session markers, read back for self-verification | Remote (create a folder) |
| `reply_comment` | Reply to an inline comment, the `**回话**` prefix is hardcoded | Remote (reply) |
| `mark_handled` | Record "I have handled this conversation comment" | Local file |
| `lint_folder` | Check house style before submit a folder | — |
| `audit_folders` | Scan all open ones, report gaps | — |
| `list_folders` | List all folders, sorted by recent activity, with counts and previews of body to read | — |
| `read_comments` | Read comments into structured JSON, author determination and answered state are pre-calculated by the server | — |

**`reply_comment` cannot post a conversation comment**, this is deliberate: a conversation comment posted by the agent is morphologically identical to the repo owner's in the API (sharing an account), and would turn into un-clearable false todos, measured to over-report by 77%. Folder-level summaries are spoken in the chat.

**`audit_folders` has no `--fix`**: of the two things that can be mechanically patched, one is wrong (patching the return-to-session marker can only patch in the id of the *current* session, which is fabricating one), and one is unsafe (graduating a draft is not supported by REST, requiring GraphQL, and opening that endpoint equals opening all mutations).

## How it works

![Loop overview](assets/loop.png)

**The repo right in the middle is the entire interface.** Neither side calls the other; they each only talk to GitHub. So the annotation desk (zhupi) can be unhooked at any time, and this server can also be swapped back to bash scripts without the human side noticing at all.

Node + TypeScript, stdio transport, installed by absolute path — touching no global npm state. GitHub authentication directly borrows `gh auth token`, without separately managing a PAT.

## Known boundaries

Ugly words up front:

- **Concurrency prevention relies on file locks, not queuing.** A stdio-based MCP server is one process per session, not a shared resident service, and cannot serialize across sessions on its own. `flock` plus a disposable worktree gets the job done, but the mechanism must be stated clearly upfront; don't think of it as a "resident single process".
- **The return-to-session marker is best-effort.** It relies on crawling the process tree for detection, and only holds true when the caller is a descendant of the host CLI. If undetected, nothing is buried — silently pointing to the wrong thing is worse than having no button.
- **Risk is concentrated in the lint rewrite.** The existing bash checks have accumulated a batch of fixes, and a rewrite is the easiest way to quietly drop them. [SPEC §5](SPEC.zh-CN.md) records the **actual behavior** of each rule line by line (there are three places inconsistent with its own documentation), and requires running a differential test before launch to align with the old script line by line.
- **Designed at a personal scale.** One reviewer, one folder repo; no plans for multi-tenancy.

## Fork to use

The folder repo name and local checkout path are configs, not constants:

```
ZHUPI_REVIEW_REPO=<owner>/<repo>     default charliezong18/review
ZHUPI_REVIEW_PATH=<path>             default ~/Developer/review
```

The conventions forced by the tools — bilingual pairs, cross-linked headers, five-paragraph PR bodies — are one person's house style. Just fork it and change them; they are rules in one module, not implicit assumptions scattered everywhere in the code.

## License

[MIT](LICENSE) © Charlie Zong
