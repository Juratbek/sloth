---
description: Implement a GitHub issue end-to-end in an isolated worktree — claim the card, fix, verify, test it in the browser, open a PR, pass a reviewer-agent loop, hand the card to Code Review; when blocked, ask on the issue and wait for the answer
argument-hint: <issue-number|url> [extra instructions or an order]
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Skill, Agent, ToolSearch, SendMessage
---

# Implement a GitHub issue

Implement the issue in `$ARGUMENTS` **autonomously**: isolated worktree, real verification, a PR that passes
a reviewer-agent loop, card in `$SLOTH_COL_CODE_REVIEW_NAME`.

Nobody is watching this session. Never ask in chat, never guess: whenever you need a human — the issue is
ambiguous, it contradicts the project's docs, a design cannot be matched, verification will not pass, the
open PR on the issue is not yours, the review loop stalls, time runs out — go to **Step Q**.

Read the **`session`** skill (state file, inbox, budget, needs-help, comment rules) and the **`board`**
skill (ids, moves, wired PR, `retry`) before Step 0, and follow them for the whole run.

**Everything project-specific comes from the project**, never from this command: `CLAUDE.md` / `AGENTS.md`,
the repo's rules, its skills, its docs. This command only says *when* to consult them.

## Step 0 — Parse, claim

`$ARGUMENTS` holds, in any order:

- **Issue (required)** — a number or an issue URL → `ISSUE` (bare number; `$SLOTH_ISSUE` when set). Missing → stop and report.
- **Order (optional)** — text introduced by `Order from <login>`, forwarded by the server. It overrides the
  default "implement the issue" scope ("address the review comments", "start over with approach X", "stop").
- **Extra instructions (optional)** — remaining free text; fold it into the work.

```bash
ISSUE=${SLOTH_ISSUE:?}; SESSION_DIR=${SLOTH_SESSION_DIR:?}; mkdir -p "$SESSION_DIR/inbox"
START=${SLOTH_START:-$(date +%s)}; SINCE=$START
# set_state working 0 "reading the issue"     (session skill)
```

**A board order comes first.** If the order — or, when the arguments point at an answer in the thread,
the latest comment by `$SLOTH_ORDER_LOGIN` — says where the card should go instead of being worked on
("move it to Planning", "not in this sprint, back to Backlog", "close it"), do exactly that and nothing
else: move the card to that column via `$SLOTH_COLUMNS` (`board` skill), or close the issue, comment
`$SLOTH_BOT_PREFIX done — card in <column>`, `set_state done`, report, and stop. No worktree, no claim.
The same words from anyone else are a question for `$SLOTH_ORDER_LOGIN` → Step Q.

Then **claim the card**: move it to `$SLOTH_COL_IN_PROGRESS_NAME` (`$SLOTH_COL_IN_PROGRESS_ID`, `item-add` +
`item-edit` per `board`, wrapped in `retry`) before reading further, so a second run cannot take the issue.
Keep `ITEM_ID` and `ISSUE_URL`.

## Step 1 — Read and scope

```bash
gh issue view "$ISSUE" --repo "$SLOTH_REPO" --json number,title,body,labels,url,state,assignees
gh issue view "$ISSUE" --repo "$SLOTH_REPO" --json comments \
  --jq '.comments[] | "\(.author.login) (\(.createdAt)):\n\(.body)\n---"'
```

- **The comment thread is part of the requirements.** Earlier questions and their answers are binding;
  never re-ask what the thread already answers.
- **Project conventions first.** Read the repo's `CLAUDE.md` / `AGENTS.md`, the rules it points at, and the
  skills available in this session. Implement the way the project says, not the way you would by default.
- **Behaviour specs.** If the repo documents the behaviour (a `docs/` tree or equivalent), implement to
  match it. If the issue contradicts it, that is Step Q. Never edit those docs in this PR.
- **Design references.** The issue involves a design when it attaches design images, links or names a
  design file/screen, carries a design label, or says something "does not match the design". Download the
  attachments and look at them:
  ```bash
  curl -sL -H "Authorization: Bearer $(gh auth token)" "<attachment URL>" -o "$SESSION_DIR/design-1.png"
  ```
  then `Read` each file. If the project has a rule or skill for reading its design files, follow it.
- **Existing PR.** Look up the wired PR (`board`). If one is open **and it is Sloth's** (its head branch is
  `sloth/issue-$ISSUE-*`, or `state.json` names it), this run is a **review round-trip**: reuse that branch
  (Step 2), read the PR's review comments and unresolved threads, fix each one — or reply with the reasoning
  when it is wrong — and continue from Step 4. An open PR that is **not** Sloth's, with no order saying what
  to do about it, is Step Q.
- Locate the code with Grep/Glob/Read, or an `Explore`-style subagent on `$SLOTH_MODEL`.

## Step 2 — Worktree off the default branch

```bash
BASE=$(gh repo view "$SLOTH_REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
git -C "$SLOTH_RUNNER_ROOT" fetch origin "$BASE"
BRANCH="sloth/issue-$ISSUE-<kebab-slug>"
WT="$SLOTH_WORKTREES_DIR/issue-$ISSUE"
git -C "$SLOTH_RUNNER_ROOT" worktree add -b "$BRANCH" "$WT" "origin/$BASE"
cd "$WT"
```

Reuse an existing `$WT` on a resumed run. For a review round-trip check the PR's branch out instead:
`git -C "$SLOTH_RUNNER_ROOT" fetch origin "$BRANCH" && git -C "$SLOTH_RUNNER_ROOT" worktree add "$WT" "$BRANCH"`.
From here on work **only inside `$WT`** — never the checkout at `$SLOTH_RUNNER_ROOT`.

Install dependencies the way the repo does — `CLAUDE.md` wins; otherwise detect from the lockfile:
`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`,
`package-lock.json` → `npm ci`, `bun.lockb` → `bun install`, or the language's equivalent
(`uv sync` / `poetry install` / `pip install -e .`, `go mod download`, `bundle install`, `cargo fetch`).
No manifest → nothing to install.

## Step 3 — Implement

Scope tightly to the issue plus any order or extra instructions. Follow the project's rules and conventions
exactly. Do not add tests unless the issue asks or the repo requires them with the change.

**A referenced design is the spec** — not the issue text, not the current screen. Reproduce every value:
layout, spacing, sizes, colors, typography, radii, borders, icons, copy, and each state shown. Reuse the
project's design tokens and components; where none matches, use the design's exact value. Before Step 5,
walk the design node by node against your markup and **name each value you matched** — any difference is a
bug to fix, not a note. That written comparison becomes the PR's `## Design fidelity`. A design you cannot
reach (missing asset, contradictory, screen absent) is Step Q, not a PR.

## Step 4 — Verify

Run what the project declares, in this order of preference:

1. **A project skill that runs or verifies the app.** Check the skills available in this session for one
   that brings the app up (a dev-environment / run / demo skill). Use it, then drive the exact behaviour the
   issue describes and confirm it works and the old behaviour is gone. Record every pid it starts into
   `$SESSION_DIR/dev.pid` / `redis.pid` and any database name into `$SESSION_DIR/demo.db`, and set
   `SERVERS=running` in `state.json` — the server cleans these up.
2. **Otherwise the repo's declared checks**: the `test`, `lint`, `build`, `typecheck` scripts in
   `package.json` (or `Makefile` / `pyproject.toml` / `go test ./...` / `cargo test`), scoped to what you
   changed. Then exercise the change as far as the session allows — `curl` the endpoint, query the database,
   run the CLI, read the rendered markup from the dev server, drive a headless browser if one is installed.

Record the exact commands and their output: they become the PR's `## Verification`, which states precisely
**what was verified and what was not**. A failing check you cannot fix is Step Q — do not push over it.

## Step 4.5 — Test it in the browser (tester subagent)

When `SLOTH_CHROME=1` and the change has a screen a user can reach, spawn **one** tester subagent
(`Agent`, `subagent_type: "general-purpose"`, `model: "$SLOTH_MODEL"`, `run_in_background: false`) and
reuse it for every re-test via `SendMessage`. The app is already up from Step 4: give the tester its URL,
how to log in (from the project's run skill), the exact behaviour the issue describes, and the old behaviour
that must be gone. Its task:

1. Load the browser tools with **one** `ToolSearch` call: `tabs_context_mcp, tabs_create_mcp, navigate,
   computer, read_page, find, read_console_messages, read_network_requests, tabs_close_mcp`. If they are
   missing, report `browser tools unavailable` and stop — Step 4 stays the verification.
2. Open a **new** tab at the URL and pass that tab id in every call — other sessions share this Chrome.
   Screenshot before each click and confirm it is your app on your screen; never click anything that opens
   a JS dialog (`confirm` / `alert`), it freezes the browser for everyone.
3. Drive the issue's behaviour as the user would: the new behaviour works, the old one is gone, the
   surrounding flow still works. After each screen read the console and the network log; uncaught
   exceptions and failed app requests are findings.
4. Close the tab. Return raw data: the steps taken, pass / fail for each, every finding with what was seen,
   and what could not be tested and why.

A finding is a bug: fix it, re-run the affected checks of Step 4, and ask the tester to re-test. Its report
is the browser part of the PR's `## Verification` — in words; **no image, gif or video is ever required**.
A tester that cannot reach the screen at all is a failed Step 4 (Step Q when you cannot fix it). Skip this
step only when the change has no screen — an API-only fix, a script — and say so in the PR.

## Step 5 — Commit, push, draft PR

Commit in the repo's style — `CLAUDE.md`'s convention if it defines one, otherwise `fix: <what changed>`.
Then:

```bash
git push -u origin "$BRANCH"
gh pr create --repo "$SLOTH_REPO" --base "$BASE" --head "$BRANCH" --draft \
  --title "<type>: <what changed>" --body-file "$SESSION_DIR/pr-body.md"
```

Body: `Closes #ISSUE`, the root cause, what changed, `## Verification` (Step 4's commands and what they
showed, the tester's browser run from Step 4.5, plus anything left unverified) and, for a design-driven fix, `## Design fidelity`. **No reviewer
request, no assignee** — a human picks it up from the board. Record `PR` / `PR_URL` in `state.json`.

## Step 5.5 — Reviewer-agent loop (max `$SLOTH_REVIEW_ROUNDS`)

Spawn **one** reviewer subagent (`Agent`, `model: "$SLOTH_MODEL"`, `run_in_background: false`) and **reuse
it every round** via `SendMessage` — never a fresh reviewer per round. Its task: run
`/sloth:review <PR_URL> feedback-only` exactly as that command says (no PR comments, no board moves) and
report the verdict block verbatim.

1. Round 1 via `Agent`; later rounds via `SendMessage`: "The PR has been updated — re-run the feedback-only review".
2. `OK to merge: yes` → Step 6.
3. Otherwise fix every bug and unmet requirement it lists, re-run Step 4, commit, push. Re-run the
   behavioural part of Step 4 and the tester (Step 4.5) only when the behaviour they exercised changed.
4. `$SLOTH_REVIEW_ROUNDS` rounds without a pass → Step Q with the remaining findings; the PR stays a draft.

Check the clock before each round (`session` skill). Without time for a round plus Step 6, go to Step Q.

## Step 6 — Ready for review → Code Review

```bash
retry gh pr ready "$PR_URL"
retry gh project item-edit --id "$ITEM_ID" --project-id "$SLOTH_PROJECT_ID" \
  --field-id "$SLOTH_STATUS_FIELD_ID" --single-select-option-id "$SLOTH_COL_CODE_REVIEW_ID"
```

## Step Q — Ask on the issue, then wait

Follow the needs-help protocol in the **`session`** skill: one numbered comment with every open question and
the done / left summary, card to `$SLOTH_COL_NEEDS_HELP_NAME`, `state: waiting`, wait up to
`$SLOTH_WAIT_HOURS` (inbox every minute, thread every 10), stop this session's servers after 30 idle
minutes but keep the code, resume with `max(remaining, 30 min)` when an answer arrives, exit after the
wait window. Never open or finish a PR built on a guess.

## Step 7 — Clean up, report

Teardown per the `session` skill: stop this session's processes and database, remove the worktree,
`set_state done`. The branch stays on the remote.

Finish with the report — it is the transcript's last message and the monitor shows it: branch, PR URL, files
changed, what Step 4 and the tester verified and what they did not, review rounds, where the card ended up. For a blocked run:
the question comment URL, whether an answer arrived, where the card is, and what is left.

## Rules

- **Fully autonomous** — never ask in chat, never guess; when blocked, Step Q and wait.
- **Respect `$SLOTH_DEADLINE`** and keep `state.json` current; the server kills stale `working` sessions.
- **Check the inbox at every step boundary.** Orders from `$SLOTH_ORDER_LOGIN` override everything here.
- Every comment starts with `$SLOTH_BOT_PREFIX`; **never write `$SLOTH_MENTION` in your own comments.**
  Every subagent runs on `$SLOTH_MODEL`.
- **The comment thread is part of the spec** — never re-ask what it answers.
- **A referenced design is matched exactly**; a difference is a bug, an unreachable design is a question.
  The PR describes the match in words — images, gifs and videos are never required.
- **Never touch the checkout at `$SLOTH_RUNNER_ROOT`, a shared database, or a port another session uses.**
- **Test in the browser when there is one** (Step 4.5): the tester subagent's run is part of every PR that
  touches a screen.
- Do not push on a failed Step 4; do not hand a PR to a human before the reviewer loop passes; the PR ends
  ready for review, with `Closes #ISSUE`, no reviewer and no assignee.
- Always clean up (Step 7), whether the run succeeds, waits out, or stops early.
