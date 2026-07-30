**English** · [中文](phase-3-write-side.zh-CN.md)

# Phase 3: Write Side

The three tools for submit a folder / reply / inspection are moved into MCP. 483 tests, 24 mutations all killed.
**But what I want you to see in this folder is not "migration completed", but three things found during the migration** — one of which I changed the design based on my own judgment, one where I turned a tool from write to read-only, and one I did not dare to decide myself.

## 1. The lock described in SPEC §4.2 does not exist on this machine

The design and task doc both wrote "`flock`, `O_EXLOCK | O_NONBLOCK`". Actual testing:

```
$ node -e "console.log(require('fs').constants.O_EXLOCK)"
undefined
$ which flock
flock not found
```

In Node v25.2.1's `fs.constants` **there is no `O_EXLOCK`** (`O_*` only has RDONLY / WRONLY / RDWR / CREAT / EXCL / NOCTTY / TRUNC / APPEND / DIRECTORY / NOFOLLOW / SYNC / DSYNC / SYMLINK / NONBLOCK), and macOS does not have `flock(1)` to shell out to either.

**What happens if written as is**: `O_CREAT | O_RDWR | undefined | O_NONBLOCK` — `undefined` is treated as 0 in bitwise OR, so the lock flag silently disappears, resulting in a **lock that can never be locked**. `openSync` succeeds as usual, all tests go permanently-green, and two sessions simultaneously submit a folder still step on each other. The sixth time this project fell for a "permanently-green", the sixth time.

Changed to atomic lock file creation with `O_EXCL` + recording pid/time inside + three liveness checks (content unreadable / pid dead / exceeds five minutes). **Deadlock prevention after a crash relies on liveness checks, not the kernel releasing the lock** — this difference is crucial, so a test was configured to actually `SIGKILL` a lock-holding child process, rather than asserting "should be able to acquire it". There are also tests where two actual processes concurrently fight for the lock, asserting that their lock-holding windows do not overlap.

Fighting for a stale lock takes the rename-aside path (two processes fighting together only one rename succeeds), and after getting the lock **reads back to confirm the pid in the lock is its own**. The residual race condition is written upfront and not hidden: A reads the stale lock → C preemptively gets the lock → A moves C's new lock away, a microsecond-level window; the worst result is two git operations colliding, and git's own index lock will explicitly report an error, not a silent repository corruption.

## 2. Realized halfway through implementing `audit_folders --fix` that neither of its two tasks can be done, so it became read-only

The old script `audit-folders.sh --fix` did two things. Checking them one by one:

- **Backfilling the "return-to-session" tag** — What the old script `:38` backfilled was the id of the **current session**. That is not the session that did the submit a folder, it is making one up. This directly contradicts SPEC §4.4 "Do not bury it if cannot be probed, absolutely do not fabricate; silently pointing to the wrong thing is worse than having nothing". The consequence is also not "good enough": a wrongly pointed tag will make the "return-to-session" button send you into an irrelevant session.
- **Promoting draft to ready** — GitHub REST's `PATCH /pulls/{n}` **does not accept the `draft` field**, it can only take the GraphQL `markPullRequestReadyForReview`. But putting `POST /graphql` into the write whitelist equals opening up all mutations (deleting repositories, merging folders, modifying anything all go through that single endpoint), and the whitelist instantly loses its meaning.

One is wrong, one is unsafe, so `--fix` was entirely dropped, `audit_folders` is purely read-only, and for the draft item it will give you the ready-made `gh pr ready <n> -R charliezong18/review`.

Collateral effect: `PATCH /pulls/{n}` has no users anymore, deleted from the write whitelist.
**This server can now only send two types of write requests in total**: create folder, reply. Everything else is blocked by runtime gates.

## 3. This one I didn't dare to decide myself: MCP tools bypass three gates

`guard-pr-create.sh` / `guard-reply-body.sh` / `guard-closed-folder.sh` are all **PreToolUse(Bash)** hooks. MCP tool calls are not Bash calls, **none of them take effect**.

That is to say, if nothing is done, the net effect of Phase 3 is "moving submit a folder from a path with three gates to a new path with no gates".

I patched two of them myself inside the tools:

| Which hook it originally relied on | Now |
|---|---|
| No reply allowed for sealed/closed folders (`guard-closed-folder`) | `reply_comment` first GETs once to check state, rejects immediately if not open |
| Inline reply first line must be stamped with `**回话**` (hard convention ③) | Hardcoded: automatically prepended if missing, on the same line |
| No conversation comment allowed (hard convention ①) | The tool **fundamentally lacks this capability** on its surface — `commentId` is required |
| Naked `gh pr create` bypassing the house style gate (`guard-pr-create`) | Not applicable: the new tool itself is that gate |

But this only patched the "few that I could think of". The `BACKLOG` has long recorded a more fundamental one (Phase 2 first round review ⑤): **the submit a folder gate is for "preventing slip-ups, not preventing bypasses"**, testing found 6 bypasses (wrapping in a script layer, `xargs`, `eval`, python `subprocess`, `git push` + web PR creation, non Claude Code runtime). The original text says:

> The only way to truly close this is: move the criteria down to the repository side (add CI on main to validate house style on PRs).
> That is the scope of Phase 3/4, and **must first be confirmed with Charlie** — adding CI will change his submit a folder experience.

Phase 3 widened one "proper path" (MCP), but not a single bypass was reduced. Whether this should be done now, and how to do it without annoying you, see item 2 below.

## 4. Two leaking holes fixed along the way

**`PARITY.md` lines stuck together.** `open-folder.sh`'s `parity_row` used `$(printf ... '\n')` to construct lines, but command substitution strips the trailing newline; `parity_flush` also used `printf '%s'` without appending one. So from the second line onwards everything stuck to the end of the previous line, and `parity.ts`'s `/^\|\s*\d{4}-/` only recognized the one at the start of the line — **#34 #35 two actual submit a folder only counted once on the ledger**. And that count supports the irreversible decision to "delete `folder-lint.sh`". Fixed (the newline is appended during flush instead); the lines that are already stuck are not split manually, undercounting is conservative.

**The guard intercepted its own error prompts.** On the write side every error must carry a recovery command (`gh pr edit <n> …`), and `guard.ts` treated these prompt texts as commands to be executed. SPEC §7 recorded the root cause "≠ this command should be executed when appearing in a string" three times, this is the fourth time. Also found along the way that pattern ④ originally had a hole: the array-split syntax like `run('gh', ['pr','create'])` could never be matched by it. Both places fixed.

## 5. Mutation campaign

All 24 non-equivalent mutations were killed (Phase 2 baseline 53/59 = 90%). The campaign itself caught two places **claiming to have defenses but no tests**:

- `sanitizeParams` in `get()` has zero coverage — deleting it entirely keeps all tests permanently-green
- The "read back to confirm it is its own" lock has zero coverage — it defends against microsecond-level race conditions, cannot be hit concurrently, opened a test seam to directly insert that move

Along with a self-mockery: in the first round of mutations "write not filtering params" showed as **surviving**, I almost logged it down as a vulnerability. Actually it was my `perl -0pi -e 's/.../.../'` missing `/g`, only replacing the first occurrence — and the first occurrence is in `get()` not `write()`. **Mutation tools themselves also lie**, the conclusion of surviving must first be verified whether the mutation actually mutated that spot.
