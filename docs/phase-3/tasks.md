**English** · [中文](tasks.zh-CN.md)

# Phase 3 Task Breakdown — Write Side

> Upstream: [SPEC §3.1/§3.3/§3.6 · §4.2](../../SPEC.zh-CN.md) (#18 already sealed (squash-merged)) · [MILESTONES acceptance criterion](../../MILESTONES.zh-CN.md)
> **Execute one by one**, pass the acceptance criterion for each before touching the next.

Phase 0–2 are entirely read-only or only write locally. **This phase writes to someone else's repository for the first time**, and the three existing security gates (Octokit read-only hook, `guard.ts` fs / git allowlist, hook route guard) in this project were initially designed around "no writing to remote". Therefore, the first two tasks of this phase are not features, but **refining the gates from "prohibited" to "only allowing these specific ones"** — the direction is relaxing, and relaxing is the direction where this project has stumbled the most (Phase 2 second round of review: the heaviest of the six new issues was the permanently-green exchanged by swapping `&&` to `;`).

## Four Conflicts at the Starting Point

Keep a ledger before writing code, lest we discover premises are invalid halfway through.

| # | Conflict | Disposition | Logged At |
|---|---|---|---|
| C1 | The runtime hook assertion in `github.ts:45` is `method === 'GET'`, non-GET throws unconditionally | **Do not split**. Add a `write()`, go through an exact `(METHOD, route)` allowlist; the Octokit instance remains sealed in the closure as usual | T1 |
| C2 | `FS_WRITE_ALLOWED_FILE` in `guard.ts` is a **single value** (`processed.ts`), rule ⑥ completely prohibits git writes in `src/` | Expand to Set + git exemption per file, **pair each new member with a reverse test stating "the allowlist can only be this long"** | T2 |
| C3 | **SPEC §3.6 hard-clashes with `guard-reply-body.sh` hard convention ①**: SPEC says emit a conversation comment if `commentId` is omitted; the guard (erected 2026-07-30 10:54) says the agent is never allowed to emit a conversation comment, empirical test shows 7 out of 13 needsReply are the agent's own words (over-reporting by 77%) | The guard is newer than SPEC, and backed by empirical data. `reply_comment` **only does inline, `commentId` is required**; amend SPEC §3.6 | T7 |
| C4 | The scope of `open_folder` is **strictly larger** than `open-folder.sh` | The old script only does lint + creates PR; creating branches / copying files / commit / push are now all in the prose of SKILL.md (:71–:76). **This section has no portable implementation**, must be written from scratch — and this project has measured its own prose omission rate at 37.5% | T4 |

The weight of C4 is most easily underestimated: SPEC §5.1 "port according to implementation, not documentation" is the discipline of Phase 2, but moving into this phase half of the route **has no implementation to copy**. That half must be treated as new code — paired with its own tests, you cannot rely on the confidence that "the old script has always run this way".

## Dependency Order

```
T0 PARITY glued lines (already fixed)
T1 write() allowlist ──┐
T2 guard allowlist     ├──► T4 worktree.ts ──► T6 open_folder ──┬──► T9 scar list
T3 session.ts ──────┘         │                              ├──► T10 concurrency empirical test
                              └──► T5 body.ts ───────────────┴──► T11 end-to-end submit a folder for real
T7 reply_comment (only depends on T1/T2)                                   T12 three rounds of review + documentation debt
T8 audit_folders (depends on T1/T2 + Phase 2 lint core)
```

The rationale for doing T1/T2 first: they are the **gates**. Writing features first and then turning back to open the gates is equivalent to having a period where the gate is closed and the code is bypassing it — anything written during that period was not seen by the guard.

## T0 · `open-folder.sh` PARITY glued lines — fixed (2026-07-30)

`parity_row` uses `$(printf ... '\n')` to assemble lines, command substitution **strips trailing newlines**; `parity_flush` uses `printf '%s'` and does not append them — thus everything from the second line onwards glues to the end of the previous line. Empirical testing shows that the two real submit a folder actions #34 #35 appear as one line on the ledger, and `/^\|\s*\d{4}-/` in `parity.ts` only recognizes the one at the start of the line, **under-counting "continuous consistency" by half**. This count underpins the irreversible decision to "delete `folder-lint.sh`".

Fix: append the newline during flush; if there is no newline at the end of the file, append one first (the existing files are exactly in this state).

**Do not manually split the existing line.** Under-counting is the conservative direction, and "do not manually edit this table" is a rule written in the ledger itself (manual traces will invalidate the `unknown` evaluation, which is the real danger). The cost is losing 1 out of 10 times, we accept it.

**Acceptance criterion**: `eval` these two functions from the real source code, write three lines consecutively to a file "without a trailing newline", `summarize()` must read `rows=4 / unknown=0`, and the `SKIP_LINT` line breaks the streak. ✅ Already passed

## T1 · `github.ts` open a write path — allowlist, not opening the gate

The current `installReadOnlyGate` is the **only** trustworthy gate (the first round of review demonstrated with a local server: text scanning cannot stop aliases / template routes / native fetch). It must not be dismantled on the write side.

Approach:
- Add `installWriteGate(oc, allow)` — assert in the hook that `(method, normalized route)` is in the allowlist, **throw if not**
- The allowlist is a **literal constant**, Phase 3 has only four:
  - `POST /repos/{owner}/{repo}/pulls` (create folder)
  - `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` (append body / graduate draft)
  - `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies` (reply)
  - `GET` (the write instance also needs to read back for self-verification, but going through the same table is simpler: allow all GETs)
- **Cache separately** for the write instance and the read instance, the read instance continues to only go through `installReadOnlyGate`

**Acceptance criterion**: Boot a local server, verify four things —
① POSTs within the allowlist actually go out;
② `DELETE /repos/{owner}/{repo}` (delete repo) outside the allowlist is blocked;
③ `write('POST /...pulls', { method: 'DELETE' })` is blocked (Octokit options override method, this is a fake gate shape proven in the first round of review, the write side must verify it again);
④ **The read instance still cannot send out a single non-GET** — do not let the write side changes loosen the read side gate.

## T2 · `guard.ts` allowlist expansion + reverse tests

Three places to relax:

| Rule | Current Status | Change To | New Member |
|---|---|---|---|
| ②′②″ fs | Single value `src/processed.ts` | `Set` (2 items) | `src/worktree.ts` (copy documentation into worktree + lock file) |
| ⑥ git write | `src/` fully prohibited | Exempt by file (1 item) | `src/worktree.ts` (`worktree add/remove`, `add`, `commit`, `push`) |
| ③ route must start with GET | Fully prohibited | **Untouched** | See below |

`body.ts` **does not enter the fs allowlist**: the body is a string, hand it directly to Octokit. The old script writes a temporary file only because `gh pr create --body-file` requires a path — replacing the API eliminates that reason, conveniently adding it to the allowlist is a free vulnerability.

Rule ③ is untouched, but **it did not see T1**: it only matches the literal `octokit.request('POST …')`, while the real code in `github.ts` is `oc.request(route, safe)`, where route is a variable. Empirical testing shows that after writing T1, not a single one of the 44 guard tests failed — the largest change in security posture for this project, and the guard remained silent the whole time. The guard's own comments admit it has downgraded to an auxiliary lint, so "how large is the write surface" is guarded by the **length assertion** of `WRITE_ALLOWED` (written in `write-gate.test.ts`).

**Relaxed guards must be paired with reverse tests, otherwise they are decorations.** Add two for each place:
- Forward: legal syntax in new members does not report violations
- **Reverse: writing the same code in files outside the allowlist must report** — and assert **the length of the allowlist itself**. If the length is not pinned, casually adding a member to the Set in the future **will not turn any tests red**: the tests above verify "blocked outside the allowlist", and adding a member is precisely moving the file **inside** the allowlist.
- Match by **full relative path**, not basename — otherwise stuffing the file into `src/sub/worktree.ts` exempts everything. The second round of review caught this exact pitfall on `OCTOKIT_ALLOWED_FILE`.
- Supplement the interception list with `mkdtempSync` / `openSync` (previously unmentioned, yet temporary worktrees rely exactly on them)

**Acceptance criterion**: All three mutations must fail — ① stealthily adding a member to the fs allowlist; ② changing the exemption to match by basename; ③ fully opening the git exemption globally. **Actually perform the mutation**, do not just claim it.
✅ Already passed (failed 4 / 2 / 3 respectively)

## T3 · `session.ts` — ppid crawl

Port `happy-session-id.sh` (39 lines of python). **The line in the original script "after a hit, verify again that this pid is actually running happy right now" must be preserved verbatim** (SPEC §4.4) — `sessions.json` only accumulates and never cleans up, empirical testing shows all 114 entries marked running, and the hostPid of stale records has long been recycled by the OS for other processes.

Strategy: return `null` if undetectable, **never invent**.

**Acceptance criterion**: Three test cases — ① fake `sessions.json` + fake ps chain, hits; ② hostPid collides but the process name is not happy (stale record), returns null; ③ `sessions.json` does not exist, returns null without throwing. Test with injected `ps` / file reading functions, do not rely on the real process tree.

## T4 · `worktree.ts` — the only module that touches the folder repo

This is the most dangerous piece of this phase, and also the section **with no implementation to copy** (C4).

Workflow (entirely under lock):
```
acquire lock → fetch origin → mkdtemp → git worktree add <tmp> -b <slug> origin/main
     → copy docs/<basename> and docs/assets/<basename> → git add → git commit
     → [lint gate: see below] → git push -u origin <slug>
     → hand over to T6 to create PR → git worktree remove (regardless of success or failure)
```

**Lock: `O_EXLOCK | O_NONBLOCK` + backoff retry, do not use PID files.**
The lock file is placed outside the repo (`~/.zhupi-mcp/review.lock`). The reason for choosing it is that **the kernel automatically releases the lock when the process dies** — the PID file approach leaves a permanent deadlock when the session is killed, and "closing a batch of Happy sessions" happened just this morning. `O_EXLOCK` is BSD semantics (macOS has it, Linux does not), this project only runs on macOS, this must be written in the comments, do not let future readers think it is cross-platform.

**The lint gate is placed after commit, before push** (deliberate improvement, registered in SPEC §5.4): `snapshot.ts` reads **committed** content (`git show <ref>:<path>`), so it must be committed first to be tested; and stopping before push when it fails — nothing is pushed up, simply delete the worktree and local branch, and the remote remains pristine. The old script could not do this: the branch had long been pushed up manually when it ran.

**Places that must fail rather than make do:**
- Branch already exists → explicitly report an error, do not overwrite (repeated submit a folder is a real incident, this is how the #30 merge description came about)
- Cannot fetch `origin/main` → abort (the branch base point is house style rule 4)
- Target of the copy already exists → report an error, do not silently overwrite

**Acceptance criterion**:
① Create a fake folder repo in `/tmp` (`git init --bare` + clone), run the full workflow, assert that the remote really gained a branch, and the content is byte-for-byte equal to the source file;
② When lint fails: **zero changes** on the remote, no residual worktree locally, no residual branch;
③ After an intermediate kill (simulating a closed session), the next lock acquisition **does not timeout** — you must actually kill a child process for this, you cannot rely on deduction;
④ Two processes enter simultaneously, the second gets a readable error "another session is submit a folder" or queues successfully, neither hangs dead, nor do both enter.

## T5 · `body.ts` — five-part assembly + tag welding + read-back self-verification

- Assemble five parts according to the `body` structure in SPEC §3.1 (destination / direct link / TLDR / awaiting your decision / how to use)
- Missing items **only warn, do not block** (SPEC §5.3 #6: the documentation and script comments both say "block", which is false, follow the code)
- Weld `<!-- happy-session: <id> -->` at the end; if `session.ts` returns null, omit it, never invent
- After creating the PR, **GET back the body to confirm the tag actually landed in it** (the old script has this, `gh` had a precedent of silently swallowing the body)
- If read-back fails, **return anyway** — the PR is already created, hiding it is worse (the orange branch in the SPEC §3.1 diagram)

**Acceptance criterion**: ① One test case each for all five parts present / missing one part, the latter is a warn not an error;
② When the tag is null, the body does not have a single extra line;
③ When the read-back body lacks the tag, the return body carries an actionable sentence on how to fix it (not throwing an exception).

## T6 · `open_folder` wiring

String together T3/T4/T5, plus PARITY ledger writing — **the landing point of the ledger is after the PR is built**, not after lint (the conclusion of the old script's first round of review: rejected folders and retries are not "one submit a folder", empirically 2 folders and 0 real PRs can accumulate 6 lines). The abort path records "submit a folder aborted (not counted)".

Returns: PR number, **the annotation desk (menxia) deep link**, lint report. **Do not use the github.com PR link as the primary output** (stepped on this 2026-07-27: he will read it as "asked you to send the annotation desk (menxia) but you sent a PR").

**Acceptance criterion**: ① Runs end-to-end successfully on a fake folder repo, `PARITY.md` gains exactly one row with a real folder number;
② When lint fails, the ledger records "submit a folder aborted" and **does not enter the continuous count** (assert the streak remains unchanged using `summarize()`).

## T7 · `reply_comment` — only do inline

The landing of C3. `commentId` is **required**, the conversation comment path is not implemented.

The `**回话**` prefix (hard convention ③) is **welded into the tool**: if the first line lacks it, automatically append it, do not reject. The rationale is the established philosophy of this project — "what is written in documentation can still be skipped, so weld it into the action itself" (SPEC §3.1); and empirical data supports it: 0 out of 12 replies across the repo carry the prefix, prose cannot govern it, the guard changed it to rejection, the tool side can do it more thoroughly. **Same line, do not leave blank lines** (the annotation desk (menxia) already has a `reply · <login>` label, a bolded "reply" occupying its own line is a three-layer repetition in the 300px wide annotation column).

**Acceptance criterion**: ① No prefix on the first line → append it and on the **same line**; ② First line already has it → do not append repeatedly;
③ Omitting `commentId` → report an executable error pointing to "summarize in chat", instead of silently emitting a conversation comment.

## T8 · `audit_folders`

The read side reuses the Phase 2 lint core (R7 has already landed in Phase 2); this phase supplements the two items unique to it that hit the network: return-to-session tag, draft status.

**`--fix` does not supplement the return-to-session tag** (deliberate improvement, registered §5.4). What the old script `audit-folders.sh:38` supplements is the id of the **current session** — that is not the session that submitted this folder, it is **invented**, which directly contradicts SPEC §4.4 "if undetectable, do not bury, never invent; silently pointing to errors is worse than nothing". `--fix` only retains graduating drafts (that item has no correctness risk).

**Acceptance criterion**: On a fake folder repo, after running `--fix` on a folder missing the tag, the body has **zero changes** and the report explicitly states "not supplemented, reason"; draft folders successfully graduate.

## T9 · scar list (Phase 3 Edition)

Name them after incidents, hardcode the medical records in the comments. Cover at least:
PARITY glued lines (T0) · write allowlist overridden by params verb (T1) · guard allowlist quietly lengthening (T2) · stale hostPid pointing to wrong session (T3) · deadlock after crash (T4) · pushed branch despite failing lint (T4) · reported success despite tag not landing in body (T5) · ledger counting on rejected folders (T6) · reply prefix occupying its own line (T7) · `--fix` supplementing an invented session id (T8).

**Acceptance criterion**: Each item **must fail when the corresponding implementation is broken** — actually perform the mutation, do not just claim it. Phase 2's kill rate was 53/59 (90%), this edition shall not be lower than that.

## T10 · concurrency empirical test (One of the MILESTONES acceptance criterion)

Two real sessions submit a folder **simultaneously**. Must **see flock take effect** — not an assumption.

**Acceptance criterion**: Can see the second process waiting for the lock in the logs (timestamps overlap, lock acquisition moments are staggered), the contents of the two folders are individually intact, branches do not cross, both lines in `PARITY.md` are present and not glued. Close these two folders after testing.

## T11 · end-to-end submit a folder for real (MILESTONES acceptance criterion two and three)

**dogfood**: The first folder submitted using `open_folder` is Phase 3's own delivery document.

**Acceptance criterion**: ① The real PR is built, the annotation desk (menxia) deep link can be opened;
② **The tag is verified by reading back from the online PR body** (not just considered done after local assembly);
③ The agent never touches `~/Developer/review` throughout the entire process.

## T12 · Three rounds of review + documentation debt

Shift perspectives for three rounds, **at least one round looking outside the repo** (Phase 2's third round read the menxia source code, unearthing three misalignments between the rules and the product's actual behavior — that round was the most valuable).

Documentation: SPEC §3.6 amends conversation comment (C3) · §5.4 registers three deliberate improvements (lint location / `--fix` not supplementing tag / reply prefix welded shut) · MILESTONES append a line (never rewrite old entries) · README tool surface supplement three items · `PARITY.md` log a note for T0.

**Acceptance criterion**: Leave no drift of "documentation says pending implementation while code is already implemented" or vice versa.

## Do not do

Delete old scripts (Phase 4, and PARITY continuous streak hasn't arrived yet) · SKILL.md slimming and hook redirect (Phase 4) · `dryRun` of `open_folder` (BACKLOG B4) · auto-infer images (B3) · one folder multiple documents (B1) · dispatch translation for bilingual gaps (B2) · merged pagination (around mid-August)
