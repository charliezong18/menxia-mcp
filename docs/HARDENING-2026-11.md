# Hardening pass — 2026-11

This pass covers error handling in every tool handler, idempotency on retry, and edge cases in the lint rules. Every failure mode below is reproduced by a test that uses fakes only. The network tests swap the transport through `setFetchForTests`, and the base URL points at loopback port 9 as a second safeguard. The git tests use a bare origin and a clone created in `tmpdir`. **No test talks to GitHub.**

**Compatibility.** Tool names and input schemas are unchanged. Outputs only gain fields. `open_folder` adds `outcome`, `complete` and `incomplete`. `reply_comment` can now return `alreadyPosted` and `recoveredFrom`. Every existing field keeps its meaning. Two tool descriptions gained one line each, saying that a retry is safe.

## Baseline (before the pass)

```
npm test   →  Test Files 1 failed | 20 passed (21)
              Tests      1 failed | 580 passed (581)
```

The one red test was `submit-integration.test.ts › open_folder：整条链 › 推分支 → 建折 → 回读自核`. Its outcome depends on the environment: it only passes when the test process is a descendant of a `happy` CLI, because session-id detection walks the process tree. In CI or a cloud container, detection returns `null`, an extra warning appears, and the strict `toEqual` on `warnings` fails. See F9.

## After

```
npm test   →  Test Files 24 passed (24)
              Tests      670 passed (670)
```

There are three new test files: `test/hardening-network.test.ts` (22 tests), `test/hardening-submit.test.ts` (38) and `test/hardening-lint.test.ts` (29). The fake server in `test/submit-integration.test.ts` gained one route (the comment list that reply de-duplication reads) and one injected dependency (F9).

I checked that the tests are real by running the lint tests against the original `src/lint.ts`. The six tests for L1–L4 fail, and the other 23 lint tests describe existing behaviour, so they pass on both versions. The submit and network tests need the new seams (`setFetchForTests`, the `deps` argument), so they can't run against the old code at all. Each fix test below asserts on an observable effect, such as the number of folders in the fake GitHub, the number of POSTs, or the branch sha on origin.

---

## Network layer (`src/github.ts`)

| # | Failure mode | Before | Fix | Tests (`test/hardening-network.test.ts`) |
|---|---|---|---|---|
| F1 | `EADDRNOTAVAIL` / `ENETUNREACH` / `EHOSTUNREACH` / `ENETDOWN` / `ECONNABORTED` / `UND_ERR_CONNECT_TIMEOUT` | None of these codes were in `NET_CODES`, and their messages (`connect EADDRNOTAVAIL 140.82.x.x:443 - Local (0.0.0.0:0)`) contain none of the keywords. Classification was correct only when Octokit's `TypeError('fetch failed')` happened to be within four links of the cause chain. Any other shape fell through to "出了点没预料到的问题". | Added the codes, plus the `TimeoutError`/`AbortError` names, to the classifier. | `F1 › classify: <CODE>（Octokit 包过一层）→ network`, `F1 › classify: <CODE>（只有 code、message 不含任何关键词）→ network` (fails before the fix), `F1 › get()：EADDRNOTAVAIL 一直不好 → 报「连不上 github.com」` |
| F2 | Timeouts / half-open connections | There was **no request timeout**. A peer that accepts the TCP connection but never answers hung the tool call forever. When an abort did happen, `TimeoutError` / `AbortError` was classified as `unknown`. | Every request now carries `AbortSignal.timeout(ZHUPI_HTTP_TIMEOUT_MS ‖ 30 s)`, composed with any caller signal through `AbortSignal.any`. Aborts are classified as `network`. | `F2 › classify: TimeoutError / AbortError → network`, `F2 › get()：对端只握手不回包 → 在超时预算内失败，归为 network` |
| F3 | Transient GET failures | A code comment said `get()` retries network errors. It never did: only 401 was retried. | GET gets one network retry, with its own budget separate from the 401 retry and a delay (`ZHUPI_HTTP_RETRY_DELAY_MS`, default 500 ms). 404, 403 and other errors are not retried. **`write()` still never retries network errors**: blindly re-sending a POST /pulls opens a second folder. Idempotency for writes lives in the handlers instead (F4–F7). | `F3 › 第一次 ECONNRESET、第二次好了 → 返回数据`, `F3 › 只重试一次`, `F3 › 404 不重试`, `F3′ › POST 遇到 EADDRNOTAVAIL → 只发一次` |
| F11 | 502 / 503 / 504 from GitHub's gateway | Classified as `unknown`. | Classified as `network`, so the error never tells the user to run `gh auth login`. Plain 500 stays `unknown`. | `F11 › HTTP 50x → network，话术不叫人去登录`, `F11 › 500 仍归 unknown` |
| — | Retry advice got truncated | `network` messages pass through `brief()` (160 chars), so any "safe to retry" text appended to the reason was cut off. | `network` gets an optional `hint` that is printed untruncated (`src/errors.ts`). | `network 错误的 hint 不被截断` |

## `open_folder` (`src/submit.ts`, `src/worktree.ts`)

Hazards are ordered by where they occur in the flow: stage, lint, push, then `POST /pulls`, labels and verify-marker.

| # | Failure mode | Before | Fix | Tests (`test/hardening-submit.test.ts`) |
|---|---|---|---|---|
| F4 | Push succeeded, `POST /pulls` hit a network error, caller retries | The error told the caller to run `gh pr create` by hand. **The PreToolUse guard blocks exactly that command**, so the only exit was blocked or bypassed every gate. A retry with the same inputs failed with "分支在远端已经存在". | `stageFolder` checks with `remoteMatches()` whether the remote branch is *this same submission*: every file's `git hash-object` equals the blob on `origin/<branch>`, and the branch changes no other files (`docs/.monolingual` excepted). If so, it **doesn't push again**, re-runs the lint gate against `origin/<branch>`, and returns `resumed: true`. `open_folder` then claims an existing open folder or creates one, giving `outcome: 'resumed'`. If the content differs, the old error is kept: that's a new version, not a retry. The error text now says that an unchanged retry is safe. | `F4 › 第一次报「原样重试」；第二次 outcome=resumed，origin 分支 sha 不变，全程只有一折`, `F4 › 内容变了就不是重试：照旧拒，且一个写请求都没发`, `F4 › 续推时同样过 lint 闸门` |
| F5 | `POST /pulls` *reached GitHub* but the response was lost (timeout, reset, 5xx), or a concurrent retry gets 422 "A pull request already exists" | Reported as a failure, which invited another submission. | After any POST failure, look up the open folder for `head=<owner>:<branch>` and check `head.ref` locally as well. If one exists, claim it (`outcome: 'existing'`) with a warning saying nothing was duplicated. A full repeat of a call that already succeeded also gives `existing`, with zero POST /pulls. If the lookup fails too, the error says the branch is pushed and that an unchanged retry won't open a second folder. | `F5 › 回包丢了（服务端已建）→ outcome=existing，只有一折`, `F5 › 上次其实全成功了…第二次零个 POST /pulls`, `F5 › 并发重试撞上 422「already exists」→ 认领那一折`, `F5 › 建折失败、回头查也查不了 → 明说分支已推、原样重试安全` |
| F6 | Partial failure: folder created, labels not applied (or the marker read-back failed) | Only one free-text warning, so a caller couldn't tell "done" from "half done" without parsing prose. | Structured fields `complete: boolean` and `incomplete: [{ step: 'labels' \| 'verifyMarker', error, remedy }]`. The remedy says to retry `open_folder` unchanged: F5 claims the existing folder, and the label POST adds labels idempotently. The old warning text is still emitted. A read-back failure never throws: the folder is fine. | `F6 › label 那一步断网 → complete=false…；重试 → 补上，仍是一折`, `F6 › 回读核标记那一步断网 → 不抛`, `F6 › 全部顺利 → complete=true、incomplete=[]（旧字段一个不少）` |
| F8 | Invalid input that used to fail *after* side effects | `branch` was not validated: `-f` / `--force` look like git options, `main` is the base, and spaces or `..` failed as an opaque "git worktree add 失败". A title over 256 chars or a body over 65 536 chars passed the push and only failed at the 422 from `POST /pulls`, leaving an orphan branch. | `branchProblem()` applies git ref-format rules before any git or network call. Chinese names stay allowed (#31). Title and built body length are checked before staging. Reply length is checked before any request. | `F8 › branchProblem(<bad>) → 报` ×10, `F8 › branchProblem(<good>) → 放行` ×4, `F8 › 坏分支名：origin 零变化、零请求`, `F8 › 文件名推出来的 slug 带空格 → 在 git 之前说清楚`, `F8 › 标题超 256 / body 超 65536 → 推之前拒`, `F8 › 经 handleTool 走一遍（入参 schema 不变，新校验照样生效）` |

## `reply_comment` (`src/submit.ts`)

| # | Failure mode | Before | Fix | Tests (`test/hardening-submit.test.ts`) |
|---|---|---|---|---|
| F7 | Retry after a network error on POST …/replies | The POST may already have landed. A retry posted a **second identical reply** on the thread. | Before writing, read the folder's review comments and look for a reply on the same root with the identical (prefixed) body. If one exists, return it with `alreadyPosted: true`. After a POST failure (`network`/`unknown`), look again: if the reply is there, return it with `recoveredFrom`; if not, fail with "an unchanged retry is safe". Duplicate detection skips folders with more than 100 comments (the read side already refuses those) instead of blocking the reply. Any other read failure happens **before** any write. | `F7 › 回包丢了（其实发出去了）→ alreadyPosted，串上只有一条`, `F7 › 真没发出去 → 报错并明说重试安全；重试 → 发一条`, `F7 › 上次成功了又调一次 → 不发第二条`, `F7 › 同一串上不同的话照发`, `F7 › 对 reply 的 reply 也查重：归位到根之后再比`, `F7 › 查重那一步断网 → 在写之前失败，一条都没发` |
| F10 | `commentId` belongs to a different folder than `pr` | The POST went out and GitHub answered with a 404 or attached the reply in the wrong place. | Compare the comment's `pull_request_url` with `pr` before writing, and name the folder the comment is actually on. | `F10 › 批注在 #13，调用写的是 #12 → badInput，零写请求` |
| — | Too-long reply | 422 from GitHub. | Rejected before any request. | `F8 › 回话超长 → 写之前拒` |

`list_folders`, `read_comments`, `lint_folder`, `audit_folders` and `mark_handled` are read-only or write only to local files, so they are retry-safe by construction. They benefit from F1–F3 and F11 (classification, timeout, GET retry) and needed no handler changes.

## Lint rules (`src/lint.ts`)

| # | Rule | Edge case | Before | Fix / pinned behaviour | Tests (`test/hardening-lint.test.ts`) |
|---|---|---|---|---|---|
| L1 | 1 (bilingual pair) | Translation suffix written as `a.zh-cn.md` (menxia's `lang.js` matches case-insensitively) | Treated as an independent English document. The error said to add `a.zh-cn.zh-CN.md`, pointing the wrong way. | A hard finding that names the suffix case. The mis-cased file no longer becomes its own slug. | `L1 · 译本后缀写成 .zh-cn.md → 直说是后缀大小写` |
| L5 | 1 (bilingual pair) | `.md` files under `docs/assets/` | Unpinned. | Pinned: they need a `.zh-CN.md` twin in both directions. Headers are relative to `docs/assets/`. Their image refs resolve against `docs/assets/`, so `assets/p.png` points at `docs/assets/assets/p.png`. `.mmd`/`.png` files stay outside the rule. End-to-end through `open_folder`: an asset `.md` with no twin is blocked before the push, and with its twin it passes. | `L5 › docs/assets/notes.md 没有 notes.zh-CN.md → 规则 1 硬伤`, `L5 › 只有 …notes.zh-CN.md → 也报（双向）`, `L5 › 对子齐…→ 干净`, `L5 › assets 里 md 引用的图按 docs/assets/ 解析`, `L5 › .mmd / .png…不进双语规则`, and in `hardening-submit.test.ts`: `L5 › 只给 assets/notes.md → 体例不合格（缺中文版），origin 零变化`, `L5 › 带上 notes.zh-CN.md → 过` |
| — | 2 (cross-link header) | BOM + CRLF; header pushed to line 2; link with a title or `./`; link to a different document; subdirectory documents; two slugs with the same name in different directories | — | Pinned (characterization). | `规则 1/2 · 双语互链头的边界 › …` (7 tests) |
| L4 | 4 (assets layout) | `![x](<assets/a b.png>)`, the CommonMark form for names with spaces | Not extracted at all, so a **missing image went unreported**. | Accept `<…>` destinations. | `L4 · 尖括号目标…也要提取` |
| L4 | 4 | `![x](assets/p.png?raw=true)` | Reported as a missing image even though the file exists. | Strip the query string before comparing. | `L4 · ?raw=true 查询串不是文件名` |
| — | 4 | Root `../assets/<proj>/` versus `docs/assets/`, refs inside code blocks, `../../` climbing above the repo root | — | Pinned: the two layouts never collapse into one key, and code blocks are ignored. | `规则 4 · assets 两种布局不塌成一个键 › …` (4 tests) |
| L3 | 5 (CJK ratio warning) | Chinese translation full of `[文字](https://long/url)` links or `[x]: https://…` reference definitions | Latin letters from the URLs diluted the ratio, so an index page that reads entirely as Chinese got "中日韩字符只占 20%". | Absolute-URL link targets, bare URLs and HTML tags are excluded from the ratio. Relative targets (`a.md`) still count, so existing boundary samples don't drift. | `L3 · 中文版里的长 URL 链接不稀释占比`, `L3 · 引用式链接定义…也不计入` |
| L2 | 5 | Translation that is only images and code below the mandatory header | Warned about a ratio below 30%, a number that came entirely from the header boilerplate. | Rule 5 is skipped when there's no prose to judge (`hasProse`: header line and image syntax excluded). | `L2 · 只有图 / 只有代码的文档判不了语言 → 不报 0%` |
| — | 5 | Exactly 30% (no warning on either side), 29% (warns on zh), 31% (warns on en), Japanese kana, English inside code blocks, `.payload` English side | — | Pinned thresholds and exemptions. | `规则 5 · CJK 占比警告的边界 › 恰好 30%…`, `29%…`, `英文版恰好 30% 不报、31% 报`, `日文假名也算 CJK`, `代码块里的英文不算`, `.payload 的英文版是中文 → 不报` |

## Test infrastructure

| # | Item | Fix | Test |
|---|---|---|---|
| F9 | Baseline red test that depends on the environment | `openFolder(input, ref, deps)` takes an optional `deps.detectSessionId`. The integration test injects it. Detection itself stays covered by `session.test.ts`. | `submit-integration.test.ts › 推分支 → 建折 → 回读自核` |
| — | Transport seam | `setFetchForTests(fetch \| null)` in `github.ts`. The read-only and write-allowlist gates sit on the Octokit hook *before* fetch, so swapping fetch can't bypass them (`write-gate.test.ts` and `readonly-gate.test.ts` are unchanged and green). | All of `hardening-network` and `hardening-submit` |

## Known limits (not fixed here)

- **The residual window in duplicate checks.** Two *concurrent* `reply_comment` calls with the same body can both pass the pre-check before either posts. The check protects sequential retries, which is the failure mode that was observed. Concurrent folder creation is covered by GitHub's own 422 plus the lookup in F5.
- **Resume compares bytes.** If the local `src` file was rewritten with CRLF or a git filter (`autocrlf`, clean filters) changed the blob between attempts, the retry counts as a different submission and gets the old "branch already exists" error. That direction is safe.
- **Duplicate detection gives up above 100 comments on a folder**, matching the read side's page guard. It doesn't block the reply.
