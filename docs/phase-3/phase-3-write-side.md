**English** · [中文](phase-3-write-side.zh-CN.md)

# Phase 3: Write Side

The three tools (submit a folder / reply / inspect) have been moved into MCP. **510 tests, 37 mutations all killed.**
**But what you should look at in this folder is not "it's done", but three things found during the move** — one of which I changed the design based on my own judgment, one where I turned a tool from write to read-only, and one that I didn't dare decide myself.

(Sections one to five were written when submitting the folder, **Section six is the ledger of three rounds of review run afterwards, 13 items, all fixed**.
If you only read one section, read Section three; if you read two sections, add the three cross-system items at the beginning of Section six.)

## 1. The lock written in SPEC §4.2 does not exist on this machine

The design and the task description both said "flock, O_EXLOCK | O_NONBLOCK". In actual testing:

```
$ node -e "console.log(require('fs').constants.O_EXLOCK)"
undefined
$ which flock
flock not found
```

In Node v25.2.1's fs.constants **there is no O_EXLOCK** (O_* only has RDONLY / WRONLY / RDWR / CREAT / EXCL / NOCTTY / TRUNC / APPEND / DIRECTORY / NOFOLLOW / SYNC / DSYNC / SYMLINK / NONBLOCK), and macOS also does not have flock(1) to shell out to.

**What happens if we follow it**: O_CREAT | O_RDWR | undefined | O_NONBLOCK — undefined counts as 0 in a bitwise OR, so the lock flag silently disappears, resulting in a **lock that can never lock**. openSync succeeds as usual, all tests go green, and two sessions concurrently submit a folder and trample each other just the same. The "permanently-green" this project has fallen for five times, the sixth.

Changed to O_EXCL atomic lock file creation + recording pid/time inside + three liveness checks (content cannot be read / pid is dead / over five minutes). **Not deadlocking after a crash relies on the liveness check, not the kernel releasing the lock** — this difference is crucial, so a test was added to actually SIGKILL a lock-holding child process, rather than asserting "should be able to acquire".
There are also two tests where two real processes concurrently contend for the lock, asserting that the lock-holding windows do not overlap.

Contending for a stale lock uses rename-aside (when two processes contend concurrently, only one rename succeeds). After acquiring the lock, **read back to confirm the pid in the lock is your own**. The residual race condition is written at the top of the file, not hidden: A reads the stale lock → C preemptively acquires the lock → A moves away C's new lock, a microsecond window; the worst result is two git operations colliding, and git's own index lock will explicitly error out, rather than silently mangling the repository.

## 2. Halfway through implementing audit_folders --fix, I found neither thing could be done, so it became read-only

The old script audit-folders.sh --fix did two things, checking them one by one:

- **Padding the "return-to-session" mark** — The old script :38 pads the id of the **current session**. That is not the session that submitted this folder, it is making one up. This directly contradicts SPEC §4.4 "If you can't detect it, don't bury it, never invent it; silently pointing to the wrong thing is worse than nothing". The consequence is also not "close enough is fine": a wrongly pointed mark will have the "return-to-session" button send you into an irrelevant session.
- **Promoting draft to ready** — GitHub REST's PATCH /pulls/{n} **does not accept the draft field**, you can only use GraphQL's markPullRequestReadyForReview. And putting POST /graphql into the write whitelist means opening all mutations (deleting repositories, merging folders, modifying anything all go through that single endpoint), making the whitelist lose its meaning on the spot.

One is wrong, one is unsafe, so --fix was dropped entirely, and audit_folders is purely read-only, the draft item will give you a ready-made gh pr ready <n> -R charliezong18/review.

Collateral effect: PATCH /pulls/{n} has no users anymore, so it was deleted from the write whitelist.
**This server can now only send a total of two types of write requests**: creating a folder, and replying. Everything else is blocked by the runtime gate.

## 3. I didn't dare decide this one myself: MCP tools bypass three gates

guard-pr-create.sh / guard-reply-body.sh / guard-closed-folder.sh are all **PreToolUse(Bash)** hooks. MCP tool calls are not Bash calls, **none of them take effect**.

In other words, if nothing is done, the net effect of Phase 3 is "moving submit a folder from a path with three gates to a new path with no gates".

I patched two items inside the tools myself:

| What hook it relied on before | Now |
|---|---|
| Replying to a sealed/closed folder is not allowed (guard-closed-folder) | reply_comment first GETs once to check state, rejects immediately if not open |
| Inline reply first line is stamped with **回话** (hard convention ③) | Hardcoded: if missing, auto-pad it, on the same line |
| Sending conversation comment is not allowed (hard convention ①) | Tool interface **simply does not have this capability** — commentId is required |
| Bare gh pr create bypasses house style gate (guard-pr-create) | N/A: the new tool itself is that gate |

But this only patched "the few I could think of". The BACKLOG has long recorded a more fundamental one (Phase 2 first round review ⑤): **The submit a folder gate is "against slip of the hand, not against bypassing"**, tested with 6 bypass paths (wrapping a script layer, xargs, eval, python subprocess, git push + creating PR on web, non-Claude Code runtime). The original text says:

> To truly close it, there is only one way: moving the criteria down to the repository side (adding CI on main to validate PR house style).
> That is the scope of Phase 3/4, and **must first be confirmed with Charlie** — adding CI will change his folder submission experience.

Phase 3 widened one "proper path" (MCP), but not a single bypass path was reduced. Whether this should be done now, and how to do it without annoying you, see item 2 below.

## 4. Two leaking holes fixed along the way

**Lines in PARITY.md stuck together.** open-folder.sh's parity_row uses $(printf ... '\n') to assemble lines, and command substitution strips trailing newlines; parity_flush then uses printf '%s' without padding. Thus, from the second line onwards, everything stuck to the end of the previous line, and parity.ts's /^\|\s*\d{4}-/ only recognized the one at the start of the line — **#34 #35 two actual folder submissions only counted as one on the ledger**. And that count supported the irreversible decision to "delete folder-lint.sh". Fixed (newline padding moved to flush); the already stuck line will not be manually split, the undercounting direction is conservative.

**The guard intercepted its own error prompt.** The write side must attach a recovery command (gh pr edit <n> …) to every error, and guard.ts treated these prompt texts as commands to be executed. SPEC §7 noted the root cause "string contains ≠ this command will be executed" three times, this is the fourth time. Also found that pattern ④ inherently had a hole: it never matched the array-splitting syntax like run('gh', ['pr','create']). Both places were fixed.

## 5. Mutation campaign

All 24 non-equivalent mutations were killed (Phase 2 baseline 53/59 = 90%). The campaign itself caught two places **claiming to have defenses but lacking tests**:

- sanitizeParams in get() had zero coverage — deleting it keeps all tests green
- The lock's "read back to confirm it is yours" had zero coverage — it defends against a microsecond race condition, concurrent running couldn't collide into it, so a test seam was opened to insert that move directly

Along with a self-mockery: in the first round of mutations, "write does not strip params" showed **survived**, and I almost logged it as a vulnerability. Actually, my perl -0pi -e 's/.../.../' forgot to include /g, and only replaced the first instance — and the first instance was in get() not write(). **The mutation tool itself also lies**, the conclusion of survival must first verify if the mutation actually mutated there.

---

## 6. Three more rounds of review run after submitting the folder (v2 patch)

This folder was submitted first, and the three rounds of review were run after that. **Dug out 13 items, all fixed, 510 tests.**
Sorted by value, the first three items are not "code written wrong", they are **the new implementation's actual behavior not matching another system**.

### The cross-system round (reading zhupi and review-loop source code) — again the most valuable round

- **The format of the "return-to-session" mark doesn't match on both sides.** zhupi link.js:80 recognizes /^[a-z0-9]{16,40}$/i, while what I wrote here is [A-Za-z0-9_-]+ — **validation is looser than it**. The consequence is not theoretical: sessionId is an overridable input parameter, passing in a UUID with hyphens, read-back self-check will report **ok**, not a single warning will be issued, while the button on the annotation desk **silently does not appear**. This is exactly the thing this feature claims to defend against, I just defended against "making one up myself", but didn't defend against "format is wrong but looks like one".
- **Images were flattened.** I always land them in docs/assets/<basename>, while what actually exists on main in the repository is docs/assets/shots/*.png, and docs/zhupi-readme.md references assets/shots/setup.png. zhupi resolves relative to the document's own directory (render.js:27), and after flattening, that reference becomes a broken image — **and rule 4 will charge the bill to the document's head**, making people go correct the text; after correction, what is said in the same piece in two folders will be different.
- **The reply prefix will destroy block-level markdown.** zhupi passes the entire reply body through markdown-it (cards.js:48), adding a line of fence before **回话** = inline code span, and code blocks blur into a paragraph of text. The old guard's approach was to **reject** (letting the agent rewrite it itself), the hardcoded approach must catch this class itself. Honestly: among the 18 existing replies, the number where the first line is a block-level construct is **0**, this is prevention not fixing an accident.

### The second round (test shape vs production shape) — Two timings that will invalidate the lock

Both were **deduced**, not collided into; a microsecond window couldn't be collided into by concurrent running, so a test seam was opened for each to insert that move directly. Defenses without tests equal a comment.

- **After holding the lock times out and is snatched away, own release deletes someone else's lock.** I hold the lock for over 5 minutes (a slow push), B judges me stale, snatches the lock and enters the critical section; when I wrap up, a brainless rmSync **deletes B's valid lock** — so C and B are inside simultaneously. The slower the push, the easier it happens, and slow pushes are exactly what need the lock most.
- **When snatching a stale lock, didn't verify which one was moved into hand.** B judges stale → is scheduled away → A successfully snatches the lock and enters the critical section → B wakes up and executes rename, what is moved away is A's newly created **valid** lock (rename succeeds just the same) → B also enters.

The other two: git child process **did not time out** (on real machines commit.gpgsign=true waiting for pinentry, hooks in the repository waiting for input, will all cause the server to hang forever **and the lock is still in hand**, other sessions die along with it); crash residue was claimed to "change a slug" (branch exists locally, does not exist remotely, the only source is last time crashing before push, at that time the remote was entirely clean, the correct action is to clear it and start over, rather than bypassing a crash residue).

### The first round (regressions I introduced)

- **The guard narrowed too much.** In order not to intercept its own error prompt text, I required gh to be tightly preceded by a quote; so '  gh pr create' and 'GH_TOKEN=x gh pr create' both passed through. Narrowing itself was not wrong, the mistake was only copying the old guard's "must start with gh at the beginning of the segment", without copying its step of **first stripping prefixes**.
- **node:fs/promises's async names leaked entirely** — the intercept list is all *Sync, and I just extracted FS_IMPORT_ALLOWED to let session.ts access fs, this hole fell right on the newly opened opening.
- **ZHUPI_GITHUB_BASEURL would send real tokens to any URL.** This seam has only one use (pointing to the local server started by tests), locking it down to loopback is a three-line job.

### A matter of method: my mutation script lied to itself twice

The mutation campaign had 37 items in total, all killed. But during the process, it **twice reported "mutation didn't take effect at all" as "survived"**:
The first time perl -0pi -e 's///' missed /g, only replacing the first instance — and the first instance was not in the function I wanted to test;
The second time judging "whether the mutation took effect" used git diff --quiet, which compares against HEAD, while the working tree was full of uncommitted changes, so it forever said "changed".

The first time almost made me write a non-existent hole into the report, the second time made three real mutations be misjudged as survived.
**The conclusion of survival must first verify that the mutation actually mutated there** — the criterion was changed to cmp with the backup file.
This item and the "permanently-green test" are the same disease: **the tool used for falsification has not been falsified itself.**
