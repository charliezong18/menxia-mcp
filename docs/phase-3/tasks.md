**English** · [中文](tasks.zh-CN.md)

# Phase 3 Task Breakdown — Write Side

> Upstream: [SPEC §3.1/§3.3/§3.6 · §4.2](../../SPEC.zh-CN.md) (#18 sealed) · [MILESTONES acceptance criterion](../../MILESTONES.zh-CN.md)
> **Execute one by one**, pass the acceptance criterion for each before moving to the next.

Phase 0–2 were entirely read-only or only wrote locally. **This phase writes to someone else's repo for the first time**, and the three safety gates already in this project (Octokit read-only hook, `guard.ts` fs / git allowlist, hook route guard) were originally designed for "no remote writing". Therefore, the first two tasks of this phase are not features, they are **refining the gates from "forbidden" to "only these are allowed"** — the direction is relaxing, and relaxing is the direction where this project has stumbled the most (Phase 2 second round review: the most severe of the six new issues was the constant green bought by swapping `&&` for `;`).

## Four Conflicts at the Starting Point

Keep a ledger before writing code, lest we discover halfway through that the premises do not hold.

| # | Conflict | Disposal | Logged in |
|---|---|---|---|
| C1 | The runtime hook assertion at `github.ts:45` requires `method === 'GET'`, everything non-GET throws | **Do not dismantle**. Add a `write()`, follow an exact `(METHOD, route)` allowlist; the Octokit instance remains encapsulated in the closure as before | T1 |
| C2 | `FS_WRITE_ALLOWED_FILE` in `guard.ts` is a **single value** (`processed.ts`), rule ⑥ completely bans git writes in `src/` | Expand to Set + git exemption per file, **each new member gets a reverse test of "the allowlist can only be this long"** | T2 |
| C3 | **SPEC §3.6 clashes directly with `guard-reply-body.sh` hard convention ①**: SPEC says to send a conversation comment if `commentId` is omitted; the guard (established 2026-07-30 10:54) says the agent is absolutely not allowed to send conversation comments, actual measurement shows 7 out of 13 needsReply are the agent's own words (77% over-reporting) | The guard is newer than SPEC, and has actual measurement data. `reply_comment` **only does inline, `commentId` is required**; change SPEC §3.6 | T7 |
| C4 | The scope of `open_folder` is **strictly greater** than `open-folder.sh` | The old script only does lint + PR creation; branching / copying files / commit / push are now all in the prose of SKILL.md (:71–:76). **There is no portable implementation for this segment**, it must be newly written — and this project itself measured the missed execution rate of prose at 37.5% | T4 |

The weight of C4 is the easiest to underestimate: SPEC §5.1 "port according to implementation, not according to documentation" was the discipline of Phase 2, and in this phase half the road segment **has no implementation to copy**. That half must be treated as new code — with its own tests, you cannot rely on the confidence that "the old script has always run this way".

## Dependency Sequence

```
T0 PARITY sticky line (fixed)
T1 write() allowlist ──┐
T2 guard allowlist     ├──► T4 worktree.ts ──► T6 open_folder ──┬──► T9 scar list
T3 session.ts ─────────┘         │                              ├──► T10 concurrency actual measurement
                                 └──► T5 body.ts ───────────────┴──► T11 end-to-end real submit a folder
T7 reply_comment (only depends on T1/T2)                                   T12 three-round review + documentation debt repayment
T8 audit_folders (depends on T1/T2 + Phase 2 lint core)
```

The reason to do T1/T2 first: they are **gates**. Writing features first and then coming back to open the gate means for a period of time the gate is closed while the code is bypassing it — anything written during that time has not been seen by the guard.

## T0 · PARITY sticky line in `open-folder.sh` — Fixed (2026-07-30)

`parity_row` uses `$(printf ... '\n')` to assemble lines, command substitution **strips the trailing newline**; `parity_flush` uses `printf '%s'` and doesn't append one — thus from the second line onwards everything sticks to the end of the previous line. Actual measurement of #34 #35 two real folder submissions on the ledger shows they are one line, `/^\|\s*\d{4}-/` in `parity.ts` only recognizes the one at the beginning of the line, **"continuous parity" is undercounted by half**. And this count is what supports the irreversible decision to "delete `folder-lint.sh`".

Fix: append the newline during flush; if there is no newline at the end of the file, append one first (the existing files are exactly in this state).

**Do not manually split the existing line.** The direction of undercounting is conservative, and "do not manually edit this table" is a rule written in the ledger itself (manual traces will invalidate the `unknown` determination, which is the real danger). The cost is losing 1 out of 10 times, we accept it.

**Acceptance criterion**: `eval` these two functions from the real source code, write three lines continuously to a file with "no trailing newline", `summarize()` must read out `rows=4 / unknown=0`, and the `SKIP_LINT 跳过` line breaks the streak. ✅ Passed

## T1 · Open a write path in `github.ts` — Allowlist, not opening the gate

The current `installReadOnlyGate` is the **only** trusted gate (empirical proof using a local server in the first round of review: text scanning cannot block aliases / template routes / native fetch). The write side must not dismantle it.

Approach:
- Add `installWriteGate(oc, allow)` — assert in the hook that `(method, normalized route)` is in the allowlist, **throw if not**
- The allowlist is a **literal constant**, Phase 3 only has four entries:
  - `POST /repos/{owner}/{repo}/pulls` (create folder)
  - `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` (append body / promote draft)
  - `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies` (reply)
  - `GET` (the write instance must also be able to read back for self-verification, but going through the same table is simpler: allow all GET)
- Write instance and read instance are **cached separately**, the read instance still only goes through `installReadOnlyGate`

**Acceptance criterion**: Start a local server, verify four things —
① POST within the allowlist is truly sent;
② `DELETE /repos/{owner}/{repo}` (delete repo) outside the allowlist is blocked;
③ `write('POST /...pulls', { method: 'DELETE' })` is blocked (Octokit options override method, this is a fake gate shape empirically proven in the first round of review, the write side needs to re-verify it);
④ **The read instance still cannot send a single non-GET** — do not let the write side's modifications loosen the read side's gate.

## T2 · `guard.ts` allowlist expansion + reverse test

Relax three places:

| Rule | Current Status | Change to | New Members |
|---|---|---|---|
| ②′②″ fs | Single value `src/processed.ts` | `Set` | `src/worktree.ts` (copy docs into worktree), `src/body.ts` (body drops to temp file) |
| ⑥ git write | Entire `src/` banned | Exempt by file | `src/worktree.ts` (`worktree add/remove`, `add`, `commit`, `push`) |
| ③ route must start with GET | Entirely banned | Allow write routes within the allowlist | The table in T1 within `src/github.ts` |

**A relaxed guard must be equipped with a reverse test, otherwise it is decoration.** Add two lines for each place:
- Positive: legal syntax in new members does not report violations
- **Reverse: identical code written in files outside the allowlist must report** — and assert **the length of the allowlist itself** (`FS_WRITE_ALLOWED.size === 3`). If the length is not pinned, casually adding a member to the Set later will not turn any test red, meaning this gate is equivalent to non-existent.

**Acceptance criterion**: Remove `worktree.ts` from the allowlist, `npm test` must turn red; add a non-existent filename to the allowlist, the length assertion must turn red. **Both must truly be mutated once**, not just claimed.

## T3 · `session.ts` — ppid crawl

Port `happy-session-id.sh` (39 lines of python). **The sentence in the original script "after a hit, verify again that this pid is actually running happy" must be preserved as is** (SPEC §4.4) — `sessions.json` only accumulates and does not clear, actual measurement of 114 entries shows all marked running, the hostPid of stale records has long been recycled by the OS for other processes.

Strategy: return `null` if unable to probe, **never fabricate**.

**Acceptance criterion**: Three test cases — ① Fake `sessions.json` + fake ps chain, hit; ② hostPid collides but process name is not happy (stale record), returns null; ③ `sessions.json` does not exist, returns null without throwing. Test using injected `ps` / file reading functions, do not rely on the real process tree.

## T4 · `worktree.ts` — The only module touching the folder repo

This is the most dangerous piece of this phase, and also the segment **with no implementation to copy** (C4).

Flow (entirely under lock):
```
Acquire lock → fetch origin → mkdtemp → git worktree add <tmp> -b <slug> origin/main
     → copy docs/<basename> and docs/assets/<basename> → git add → git commit
     → [lint gate: see below] → git push -u origin <slug>
     → hand over to T6 to create PR → git worktree remove (regardless of success or failure)
```

**Lock: `O_EXLOCK | O_NONBLOCK` + backoff retry, do not use PID file.**
Place the lock file outside the repo (`~/.zhupi-mcp/review.lock`). The reason for choosing it is **when the process dies the kernel automatically releases the lock** — the PID file solution leaves a permanent deadlock when a session is killed, and the event of "Happy closing a batch of sessions" just happened this morning. `O_EXLOCK` is BSD semantics (macOS has it, Linux does not), this project only runs on macOS, this point must be written into the comments, lest future people think it is cross-platform.

**The lint gate is placed after commit, before push** (deliberate improvement, registered in SPEC §5.4):
`snapshot.ts` reads the **committed** content (`git show <ref>:<path>`), so it must be committed first to be tested; and when it is unqualified, stop before push — nothing was pushed up, just delete the worktree and the local branch, the remote is completely clean. The old script could not do this: when it ran, the branch had long been pushed up manually.

**Places that must fail rather than make do**:
- Branch already exists → explicit error, overwrite not allowed (repeated submit a folder is a real accident, this is how the #30 merge explanation came to be)
- `origin/main` cannot be retrieved → abort (branch base point is house style rule 4)
- Target of copy already exists → error, no silent overwrite

**Acceptance criterion**:
① Create a fake folder repo in `/tmp` (`git init --bare` + clone), run the full flow, assert the remote truly has an extra branch, and the content is byte-identical to the source file;
② When lint is unqualified: **zero change** on remote, no residual worktree locally, no residual branch;
③ After a kill midway (simulating session being closed), the next lock acquisition **does not timeout** — this point requires truly killing a child process, not relying on reasoning;
④ Two processes enter simultaneously, the second one gets a readable error of "另一个 session 在呈折" or queues successfully, neither hangs, nor do both enter.

## T5 · `body.ts` — Five-part assembly + marker soldering + read back self-verification

- Assemble the five parts (destination / direct link / TLDR / awaiting your decision / how to use) according to the `body` structure of SPEC §3.1
- Missing items **only warn, do not block** (SPEC §5.3 #6: documentation and script comments both say "block", this is false, follow the code)
- Solder `<!-- happy-session: <id> -->` at the end; if `session.ts` returns null, omit it, never fabricate
- After creating the PR, **GET the body back to confirm the marker truly landed in it** (the old script has this rule, `gh` has a precedent of silently swallowing the body)
- If read back fails, **return anyway** — the PR has already been created, hiding it is worse (the orange branch in the SPEC §3.1 diagram)

**Acceptance criterion**: ① One test case each for all five parts present / missing one part, the latter is a warn not an error;
② When the marker is null, the body does not have an extra line;
③ When the body retrieved from read back does not have the marker, return an actionable sentence in the return body instructing how to fix it (instead of throwing an exception).

## T6 · `open_folder` wiring

String together T3/T4/T5, and add PARITY ledger writing — **the drop point for the ledger is after the PR is created**, not after lint (conclusion from the first round of review of the old script: rejected folders and retries are not "one submission", actual measurement of 2 folders and 0 real PRs can accumulate 6 lines). The abort path logs "呈折中止（不计入）".

Returns: PR number, **the annotation desk (zhupi) deep link**, lint report. **Do not treat the github.com PR link as the main output** (stepped on this 2026-07-27: he will read it as "asked you to issue a vermilion annotation but you issued a PR").

**Acceptance criterion**: ① Runs end-to-end successfully on a fake folder repo, `PARITY.md` has exactly one extra line and carries a real folder number;
② When lint is unqualified, the ledger logs "呈折中止" and **does not enter the continuous count** (assert streak remains unchanged using `summarize()`).

## T7 · `reply_comment` — Only does inline

The landing of C3. `commentId` is **required**, the conversation comment path is not implemented.

The `**回话**` prefix (hard convention ③) is **soldered into the tool**: if the first line doesn't have it, automatically append it, it is not a rejection.
The reason is the established philosophy of this project — "even if written in the documentation, it can still be skipped, so solder it into the action itself" (SPEC §3.1); and actual measurement data supports it: across the repo 12 replies have **0** with the prefix, prose cannot govern it, the guard changed it to rejection, the tool side can do it more thoroughly. **Same line, do not leave an empty line** (the annotation desk (zhupi) already has a `回话 · <login>` tag, a bolded "回话" occupying its own line is three layers of repetition in a 300px wide annotation column).

**Acceptance criterion**: ① No prefix on first line → append it and on the **same line**; ② First line already has it → do not append repeatedly;
③ Omit `commentId` → report an executable error pointing to "小结在聊天里说", rather than silently sending a conversation comment.

## T8 · `audit_folders`

The read side reuses the lint core from Phase 2 (R7 has already landed in Phase 2); this phase supplements its unique two items requiring network calls: return-to-session marker, draft status.

**`--fix` does not append the return-to-session marker** (deliberate improvement, registered §5.4). What the old script `audit-folders.sh:38` appended was the id of the **current session** — that is not the session that submitted this folder, it **fabricated** one, directly contradicting SPEC §4.4 "if unable to probe, do not plant, never fabricate; silently pointing to an error is worse than nothing".
`--fix` only retains draft promotion (that item has no correctness risk).

**Acceptance criterion**: On a fake folder repo, after running `--fix` on a folder missing the marker, the body has **zero changes** and the report explicitly states "不补，理由"; draft folder promotion is successful.

## T9 · Scar list (Phase 3 edition)

Named by accident, medical history hardcoded in comments. Cover at least:
PARITY sticky line (T0) · write allowlist overridden by params on verb (T1) · guard allowlist quietly grows longer (T2) · stale hostPid pointing to wrong session (T3) · deadlock after crash (T4) · pushed branch despite unqualified lint (T4) · marker did not land in body but reported success (T5) · ledger counts even on rejected folders (T6) · reply prefix occupying its own line (T7) · `--fix` appended a fabricated session id (T8).

**Acceptance criterion**: For each item, **it must turn red when the corresponding implementation is broken** — truly perform mutation once, not just claim. The kill rate of Phase 2 was 53/59 (90%), this edition will be no lower than that.

## T10 · Concurrency actual measurement (MILESTONES acceptance criterion 1)

Two real sessions submit a folder **simultaneously**. Must **see flock take effect** — not an assumption.

**Acceptance criterion**: The second process can be seen waiting for the lock in the logs (timestamps overlap, moments of acquiring the lock are staggered), the contents of both folders are each intact, branches are not crossed, both lines in `PARITY.md` are present and not stuck together. After testing, close these two folders.

## T11 · End-to-end real submit a folder (MILESTONES acceptance criterion 2 & 3)

**dogfood**: The first folder submitted using `open_folder` is Phase 3's own delivery document.

**Acceptance criterion**: ① Real PR is created, the annotation desk (zhupi) deep link can be opened;
② **Marker is confirmed by reading back from the online PR body** (not just considered done after local assembly);
③ Throughout the entire process the agent does not touch `~/Developer/review` even once.

## T12 · Three-round review + documentation debt repayment

Three rounds shifting perspectives, **at least one round looking outside the repo** (the third round of Phase 2 read the zhupi source code, digging out three rules misaligned with actual product behavior — that round was the most valuable).

Documentation: SPEC §3.6 change conversation comment (C3) · §5.4 register three deliberate improvements (lint location / `--fix` not appending marker / reply prefix soldered dead) · MILESTONES append a line (never rewrite old entries) · README tool side supplement three · `PARITY.md` log an entry for T0.

**Acceptance criterion**: Leave no drift of "documentation says pending implementation but code is already implemented" or vice versa.

## Do not do

Delete old scripts (Phase 4, and PARITY continuous count hasn't reached it yet) · SKILL.md slimming and hook retargeting (Phase 4) · `open_folder`'s `dryRun` (BACKLOG B4) · image automatic inference (B3) · one folder multiple articles (B1) · dispatch translation for bilingual gaps (B2) · merged pagination (around mid-August)
