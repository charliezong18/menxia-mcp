**English** · [中文](OPEN-QUESTIONS.zh-CN.md)

# Open questions

**Rule: nothing here blocks.** Every open question ships with a default answer, and work proceeds on that default. Sweep the list whenever there is time and speak up only about the ones you want changed — no line-by-line oral exam. Answered questions move down to *Settled*.

## Open (proceeding on the default)

**How much effort is the session backlink worth?**
Default: leave it as is — embed it when detected, skip it when not, add no machinery for it. Charlie's ruling in review: "reply to the session if you can, and if you can't, the document itself is enough for any agent to pick the discussion up." That is, **the document being self-contained is the real fallback**; the button only saves a few steps. This demotes §4.4: ppid detection breaking in some future version is not an incident.

**Should the public repo be sanitized?**
Default: no. The spec names the private folder repo four times and carries one absolute home path in the MCP config example. Neither is a secret — the account is already public and both serve the text. Say the word if you would rather they were placeholders.

**Should the house-style rules be configurable?**
Default: hard-coded, with only the repo name and checkout path as environment variables. Making bilingual pairs, cross-link headers, and the five-section body configurable is speculative generality for a user base of one. Revisit if somebody actually forks it and asks.

**How long should the flock wait before giving up?**
Default: 30 seconds, then return a readable "another session is opening a folder" error. Long enough to ride out a normal submission, short enough that a stuck lock does not look like a hang.

**Delete the bash scripts at Phase 4, or keep them?**
Default: delete. Git history keeps them, and two live implementations of the same rules is exactly how the documentation drift in [SPEC §5.1](SPEC.md) happened in the first place.

**Should the English spec live in this repo, or only in the review repo?**
Default: both, as the `SPEC.md` / `SPEC.zh-CN.md` pair already here. The cost is keeping them in sync by hand after each round of annotations, which is real but small.

## Settled

| Question | Verdict | Date |
|---|---|---|
| Build an MCP server at all? | Yes — but not for the stated reason. "More locked down" is the hook's job; MCP buys cross-harness, structured reads, and typed inputs | 07-28 |
| Does MCP stop bypassing? | No. Routing is a separate problem with a separate fix, shipped first as Phase 0 | 07-28 |
| Tool scope | Six tools. Final approval (merge) deliberately excluded — that is the human's click | 07-28 |
| Wrap the scripts, or rewrite? | Full rewrite in TypeScript with tests; scripts retire at Phase 4 | 07-28 |
| Where does it live? | Its own public repo, paired with menxia as product + agent side | 07-28 |
| Language-direction check | Check by ratio: strip code blocks and inline code, then measure CJK share — error above 30% in the English file, below 30% in the Chinese one | 07-28 |
| Five-section body, block or warn? | Warn. The code was right and the documentation was wrong; the doc gets fixed at Phase 4 | 07-28 |
| Pass documents by path or by value? | By path. The server copies them in; the agent never touches the folder repo | 07-28 |
| GitHub authentication | Borrow `gh auth token` at startup; no second PAT to expire | 07-28 |
| Concurrency mechanism | File lock plus a throwaway worktree. A stdio server is one process per session, so it cannot serialize on its own | 07-28 |
| Session-backlink detection failing | Embed nothing. A silently wrong id is worse than a missing button | 07-28 |
| Installation | Absolute path in the MCP config. No `npm link` — that global single pointer broke production once already | 07-28 |
| Should agy be a consumer? | **No.** Focus on Claude; Codex is "maybe next, no rush." Cross-harness is therefore demoted from headline benefit to speculative ([SPEC §1](SPEC.md)), and Phase 1's agy-mounting criterion is deleted | 07-29 |
| Weight of the session backlink | Demoted. A self-contained document is the real fallback; the button only saves steps. Detection breaking is not an incident | 07-29 |
