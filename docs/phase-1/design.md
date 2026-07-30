**English** · [中文](design.zh-CN.md)

# Phase 1 design — read-only tools

> Second of three stages. The previous stage, [requirements](requirements.md), received final approval on 2026-07-29 (#19, zero annotations).
> This document answers **how to build it**, and does not restate what counts as correct. Task breakdown comes next.

## 0. First: the requirements hit a wall

R4 says "**an annotation with no reply from us = unanswered**." While writing this design, testing revealed:

**The agent and Charlie use the same GitHub account.** `gh auth token` yields `charliezong18`, so "his annotation" and "my reply" carry **identical** author fields in the API (verified on #18: both conversation comments are `charliezong18`).

**"Us" does not exist in the data.** R4 is not wrong; it assumed a premise that does not hold. §3 is the heart of this design and exists to solve it.

---

## 1. Module boundaries

Phase 1 builds a subset of [SPEC §4.5](../../SPEC.md), plus one module the spec does not have.

| Module | Responsibility | Any IO? |
|---|---|---|
| `src/index.ts` | MCP server wiring, registration and input validation for the two tools. **No business logic** | no |
| `src/config.ts` | Reads `ZHUPI_REVIEW_REPO`, defaulting to `charliezong18/review` | no |
| `src/github.ts` | Octokit wrapper plus authentication. **The only place that touches the network** | yes |
| `src/threads.ts` | **Pure functions**: flat comment list → reconstructed threads + answered determination | no |
| `src/errors.ts` | Failures → sentences that are actionable for the model (R6) | no |

`threads.ts` having no IO is deliberate: it carries all of R4's semantics, it is the only module needing dense unit tests, and keeping the network outside is what makes it testable at all.

**None of `lint.ts` / `worktree.ts` / `body.ts` / `session.ts` from SPEC §4.5 are built in this phase.**

---

## 2. Data flow: both tools share one path

```
readFolder(pr) ──▶ { inline[], conversation[], counts }
                      │
      ┌───────────────┴───────────────┐
      ▼                               ▼
 list_folders                    read_comments
 (projects down to counts)       (returns everything)
```

**Sharing is deliberate.** R2 requires the unanswered count to match a hand count "per R4" — if the two tools each computed it, the logic would eventually diverge, and once it does, `list_folders` claiming 3 unanswered while `read_comments` lists 2 is a contradiction that is very hard to notice.

**The N+1 trade-off**: `list_folders` needs unanswered counts, which means reading every folder's comments. About 10 open folders → roughly 1 + 2×10 = 21 REST calls. **Accepted**, because this is personal scale, not on a hot path, and switching to a single GraphQL query would introduce schema maintenance. Revisit at hundreds of folders.

---

## 3. Implementing R4 — the part of this design most worth attacking

With a shared account, "who wrote it" is dead as a signal. The two data shapes need different answers.

### 3.1 Inline annotations: use **thread structure**, not authorship

- A root annotation has an empty `in_reply_to_id`
- A reply has `in_reply_to_id` pointing at a root
- **Rule: a root annotation with at least one reply beneath it → answered**

**This rule never looks at the author, so the shared account does not affect it.** Verified on #17: 4 inline comments, 2 of them replies — the thread structure is real and in use.

**Known failure**: Charlie replying to himself (adding a note) reads as answered. Acceptable — when he adds a note he is usually already waiting on me anyway, and the cost is missing one item, not answering wrongly.

### 3.2 Conversation comments: no threads, so **ordering**, as an approximation

- **Rule: if any conversation comment exists after his, treat it as answered**

**This is an approximation, not a determination.** It is right most of the time because the actual rhythm alternates: he posts one, I reply one.

**Known failure**: he posts two in a row → the first reads as answered. **That is a real miss, and it hides his first point from me** — considerably worse than the failure in 3.1.

**So conversation `answered` is not two-state but three-state:**

| Value | Meaning |
|---|---|
| `false` | No conversation comment after it — definitely unanswered |
| `"inferred"` | Something follows it; **presumed answered, but the shared account makes this unprovable** |
| `true` | Never returned in this phase (waits for the marker in §3.3) |

**Expose the uncertainty rather than dressing it up as certainty.** A caller seeing `inferred` knows to glance at the original; seeing `false` knows it must be handled.

### 3.3 The real fix belongs to Phase 3

When `reply_comment` posts a conversation comment, it embeds an invisible marker (`<!-- zhupi-mcp:reply -->`, following the session-backlink precedent). From then on conversation comments can be determined exactly, and three states collapse back to two.

Phase 1 is read-only and cannot place markers, hence the approximation. **Historical conversation comments will always depend on ordering** — that is not retroactively fixable, and is written down here so nobody later chases it as a bug.

---

## 4. Return shapes

### `list_folders`

```
input:  state?: "open" | "merged"     default open
output: {
  folders: [{
    number, title, headRefName,
    unanswered: { needsReply, unclear, hasFollowUp }
  }]
}
```

The unanswered count is split three ways rather than summed: `inline` is certain, `conversation` is certainly unanswered, `inferred` is the unsure remainder. **Splitting the total keeps the uncertain part from contaminating the certain part.**

### `read_comments`

```
input:  pr?: number                   omit = sweep all open folders
output: {
  folders: [{
    number, title, headRefName, headSha,
    inline: [{
      id, path, line, quote, body, createdAt,
      replies: [{ id, body, createdAt }],
      answered: boolean
    }],
    conversation: [{ id, body, author, createdAt, answered: false | "inferred" }],
    counts: number
  }]
}
```

**Inline uses nested `replies` rather than a flat array plus `inReplyToId`.** The server reconstructs the thread so the model receives a tree. This directly implements R3's "no further parsing or inference," and **it tightens the flat shape in [SPEC §3.5](../../SPEC.md)**, which still expected the model to assemble the tree from `inReplyToId` itself.

**The quote**: take the last line of the `diff_hunk` GitHub already attaches to each comment — that line is the anchored source text. **Known limit: one line only.** Charlie may have highlighted half a sentence or spanned several; what comes back is the whole line. Good enough, because the annotation body usually carries its own context, and `path:line` is there when it does not.

---

## 5. Authentication (R5)

**Fetch lazily, not at startup.** Run `gh auth token` the first time it is actually needed and cache the result in memory. On 401, refetch once; on a second 401, return the §6 message.

Fetching at startup would make sessions that mount the server but never use it depend on `gh` being available — and the server starts in every Claude Code session, so that cost would be paid for nothing.

---

## 6. Errors (R6)

Four cases, one sentence each, **carrying no token and no stack trace**:

| Case | Return |
|---|---|
| gh auth unavailable | "Cannot obtain GitHub authentication. Run `gh auth login` and retry." |
| Repo missing or no access | "Cannot read `<repo>`. Check the repo name and that the current gh account has access." |
| Folder number missing | "`<repo>` has no #`<n>`. Use `list_folders` to see the existing folder numbers." |
| Network failure | "Cannot reach github.com: `<reason>`. Retry once the network is back." |

---

## 7. Guaranteeing read-only (R7)

Not by good intentions — by two mechanisms:

1. **`github.ts` exposes GET methods only**, wrapping no POST/PATCH/PUT/DELETE.
2. **A test that can fail**: scan `src/` and fail if any non-GET Octokit call appears.

The second matters most: R7 is a requirement about something *not happening*, and **things that do not happen cannot be verified by observation** — only by a test that actively goes looking.

---

## 8. Test strategy

| Target | How |
|---|---|
| `threads.ts` | Pure unit tests: inline answered / unanswered / self-reply; **conversation: two in a row must both stay `pending`** (§10.7); empty input |
| `errors.ts` | One case per mapping |
| Read-only guard | §7, mechanism 2 |
| Real machine | Run against **#18** → with nothing recorded, `needsReply` must be **2** (**changed by §10.7**: the old criterion said 0, which is exactly the under-report that was fixed); run against **#19** (merged, zero annotations) |

`github.ts` gets no coverage push — it is thin and IO-heavy, and stands on the real-machine run.

---

## 9. Non-goals

No caching, no pagination tuning, no GraphQL, no request concurrency control. All four are problems that appear at hundreds of folders; building them now buys complexity for a scale that does not exist.

---

## 10. Revision v3 (night of 2026-07-29, after three rounds of code review)

**The conclusions of §3 and §4 changed again.** What follows was surfaced during implementation by independent review agents using real data and local probes. The body above is left as v2; this section supersedes it.

**Exception: §8's "real-machine ground truth" is a criterion, not narrative, so it was edited in place.** Review round 2 pointed out that the previous revision only declared "§3 and §4 changed", leaving §8 — the section marked "pinned, an empty result does not count as passing" — in direct contradiction with current behaviour, and that is the section a new session is most likely to copy as its acceptance standard.

### 10.1 Authorship: there is a second marker

zhupi has a **fallback path** (`zhupi/src/ui.js:545-553`): when a draft was written against an older revision (`stale = d.ref !== ref`) or its line cannot be anchored, those annotations do not become inline comments — they are folded into the review body, prefixed with "以下朱批锚定不到可批注行（或写于旧版本），并入总批：".

Two consequences, both severe and silent:

- **One fallback is enough** to strip the "御笔朱批 · N 条" marker from the whole review body → every *successfully anchored* annotation in that batch reads as not-from-desk → `answered=true` → invisible;
- **If all fall back**, the review carries zero comments and his words exist only in the body → the tool reports "nothing to do here".

And "an overnight draft plus a revision pushed by the agent" is the most common shape of all. So `isDeskBody` recognizes both markers, and the fallback body's content is lifted out as a conversation item (zhupi's own wording is "folded into the overall comment") — **and it is definitely his**, so authorship needs no guessing there.

### 10.2 "Answered" is no longer a determinate value

§3.1 claims `answered: boolean`, **a determination and not a guess**. That claim was wrong: when he replies inside a thread from the GitHub web UI, it is byte-identical in shape to an agent reply (both are empty-body reviews). The v2 rule therefore marks the thread answered — **he speaks and the tool gets quieter**, which is the worst failure mode available.

Now: any desk-rooted thread **that has replies** goes into `unclear` plus `attention`, with the preview taken from the **last reply** ("our reply: fixed" versus "no, I meant the second paragraph" are trivially distinguishable). The measured cost is small: 2 extra attention items across 9 folders.

### 10.3 counts renamed and redefined

`unanswered / unknown / inferred` → `needsReply / unclear / hasFollowUp`. `inferred` ("presumed answered") was judged to be **lying** — when he posts two comments in a row, the first one lands there too.

### 10.4 attention[] and updatedAt added

Numbers alone cannot answer "which folders are waiting on me": #9's counts read 0/1/0 while the body of that item is "文档是不是有点旧了。" — a real question of his that nobody answered. A model seeing all zeros skips it. Each pending item now carries an 80-character preview, and folders are sorted by most recent activity (the only folder with a pending reply, #7, sorted last under creation order).

### 10.5 The enforcement mechanism for §7 changed

The text-scanning guard described in §7 **never once matched this project** — the real call is `oc.request(route, params)`: the variable is not named `octokit` and the route is a variable, so none of the three rules ever fired. Worse, `octokit.request('GET /x', { method: 'POST' })` **really does send a POST** (Octokit's options override the method; a reviewer proved it against a local server).

Now: the Octokit instance is sealed in a module closure and never exported, `hook.wrap` asserts the final `method === 'GET'`, and `sanitizeParams` strips `method/url/baseUrl/request/headers`. Text scanning is demoted to an auxiliary lint. Round three tried twelve bypasses; all were blocked.

### 10.6 Field-level corrections to §4

- "`line` is 100% null in practice" — **not true at repo level**; #7's annotation has `line: 7`. #17 is all-null because that folder's annotations are outdated. The value logic is unchanged (`line ?? original_line`), but `outdated` now trusts GitHub's own signal first.
- `quote` must pick a side: for `LEFT` (an annotation anchored on a deleted line) the `-` lines must be kept and the `+` lines dropped, otherwise it quotes a sentence he never highlighted.
- Orphaned replies (root deleted or truncated away) become standalone threads rather than being silently dropped.

### 10.7 Overall-comment `answered` now comes from a local record (review#29 + review round 1)

§3.2's "infer from position in the conversation" is **dead**. It only held while the
conversation area was a two-party channel; once the agent stopped posting folder-level
summaries it became a one-way inbox, so `i < len-1 → answered` silently marked the
first of two consecutive comments from him as answered (**under-report**).

Current: `answered` is only `handled` / `pending`, read from the local
`~/.zhupi-mcp/processed.json`. `counts.hasFollowUp` is removed — it counted the
artefacts of that broken inference.

R7 is restated precisely as "**no remote writes**": `processed.ts` is the only write
path in the project, and `guard.ts` pins "no fs write under `src/` except that file".

Round one of review found three more high-severity issues on top; all are now fixed:
1. **The record is `id → the updated_at seen at the time`, not the id alone.** Editing an
   already-handled comment in place leaves the id unchanged, so an id-only key makes the
   new sentence never surface — the very under-report this section exists to kill, in a new shape.
2. **`load` must distinguish "file absent" from "unreadable".** The latter refuses to write:
   saving from a failed-read empty baseline permanently erases every folder's record
   (measured at 2.5% under concurrency). `save` is now temp + rename; `commit` re-reads and merges.
3. **`seed` is now two-step.** It would also mark **his own annotations** that zhupi folded
   into the conversation area (measured on #9), and it was invisible and irreversible.
   Without `confirm` it only previews, and `undo` was added.
