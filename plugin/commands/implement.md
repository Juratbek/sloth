---
description: Implement a GitHub issue end-to-end in an isolated worktree — claim the card, fix, verify, test and screenshot it in a headless Chrome, open a PR, pass a reviewer-agent loop, hand the card to Code Review; when blocked, ask on the issue and wait for the answer
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

**Orchestrator mode** (`SLOTH_ORCHESTRATOR=1`): this session is the orchestrator and **never edits code
itself** — no `Edit`, no `Write`, no fix-up in the worktree. Every change to the code is made by **one
implementor subagent** on `$SLOTH_IMPLEMENTOR_MODEL` (spawned in Step 3, reused for every fix), while this
session keeps everything else: the issue and its thread, the board, the worktree and its git, verification
(Step 4), the tester (Step 4.5), the commits and the PR (Step 5), the reviewer loop (Step 5.5), Step Q. The
implementor never talks to GitHub or the board. Steps that read differently in this mode say so below;
with `SLOTH_ORCHESTRATOR=0` (or unset) ignore them and do the work yourself.

## Step 0 — Parse, claim

`$ARGUMENTS` holds, in any order:

- **Issue (required)** — a number or an issue URL → `ISSUE` (bare number; `$SLOTH_ISSUE` when set). Missing → stop and report.
- **Order (optional)** — text introduced by `Order from <login> (<role>, issue comment <id>)` or
  `Order from <login> (<role>, PR #<n> comment <id>)`, forwarded by the server; `<role>` is `admin` or
  `developer`. It overrides the default "implement the issue" scope ("address the review comments", "start
  over with approach X", "stop") — within the limits of the role, below. An order given on the PR is
  acknowledged and answered on that PR; everything else about the run still goes on the issue.
- **Extra instructions (optional)** — remaining free text; fold it into the work.

```bash
ISSUE=${SLOTH_ISSUE:?}; SESSION_DIR=${SLOTH_SESSION_DIR:?}; mkdir -p "$SESSION_DIR/inbox"
START=${SLOTH_START:-$(date +%s)}; SINCE=$START
# set_state working 0 "reading the issue"     (session skill)
```

**A board order comes first.** If the admin's order — or, when the arguments point at an answer in the
thread, the latest comment by `$SLOTH_ADMIN_LOGIN` — says where the card should go instead of being worked
on ("move it to Planning", "not in this sprint, back to Backlog", "close it"), do exactly that and nothing
else: move the card to that column via `$SLOTH_COLUMNS` (`board` skill), or close the issue, comment
`$SLOTH_BOT_PREFIX done — card in <column>`, `set_state done`, report, and stop. No worktree, no claim.

**A developer's order stays inside the issue.** It may say how the work is done — the approach, what to
change, address the review comments, start over, stop — and is followed like the admin's. When it asks
for something beyond that — where the card goes (any move outside Sloth's own flow), closing the issue,
other issues or branches, the repository's settings — do not carry it out: it is a question for the admin
→ Step Q, with the order quoted and `@$SLOTH_ADMIN_LOGIN` mentioned; the admin's answer decides. The same
words from anyone else in the thread are handled the same way.

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
- Locate the code with Grep/Glob/Read, or an `Explore`-style subagent on `$SLOTH_MODEL`. **Orchestrator:**
  read only what you need to brief the implementor and to judge its work — the issue, the thread, the
  project's rules, the design; locating and reading the code is the implementor's job.

## Step 2 — Reset the worktree slot to the default branch

`$SLOTH_WORKTREE` is a worktree Sloth leased to this run from its pool — a checkout an earlier run used,
kept so its installed dependencies carry over. Reset it to a fresh branch; never create or remove a worktree.

```bash
BASE=$(gh repo view "$SLOTH_REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
BRANCH="sloth/issue-$ISSUE-<kebab-slug>"
WT="$SLOTH_WORKTREE"
git -C "$WT" fetch origin "$BASE"
git -C "$WT" checkout -q --ignore-other-worktrees -B "$BRANCH" "origin/$BASE"
git -C "$WT" clean -fdx -e node_modules -e .turbo -e .venv -e .cache   # the previous run's files go; dependencies and caches stay
cd "$WT"
```

For a review round-trip check the PR's branch out instead: `git -C "$WT" fetch origin "$BRANCH" &&
git -C "$WT" checkout -q --ignore-other-worktrees -B "$BRANCH" "origin/$BRANCH"`, then the same `clean`.
From here on work **only inside `$WT`** — never the checkout at `$SLOTH_RUNNER_ROOT`, never another slot.

Install dependencies the way the repo does — `CLAUDE.md` wins; otherwise detect from the lockfile:
`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`,
`package-lock.json` → `npm ci`, `bun.lockb` → `bun install`, or the language's equivalent
(`uv sync` / `poetry install` / `pip install -e .`, `go mod download`, `bundle install`, `cargo fetch`).
No manifest → nothing to install. In a reused slot this is seconds when the lockfile is unchanged — but
then the install runs **no `postinstall`**, so run the project's generate steps yourself (a Prisma client,
GraphQL or API codegen: whatever `CLAUDE.md` or the manifests' `postinstall` / `generate` scripts name),
or the slot serves code generated for the branch the last run was on. **Install once per run**: re-run it
only when the lockfile changed since — a "Lockfile is up to date" install is a minute wasted.

## Step 3 — Implement

Scope tightly to the issue plus any order or extra instructions. Follow the project's rules and conventions
exactly. Do not add tests unless the issue asks or the repo requires them with the change.

**A referenced design is the spec** — not the issue text, not the current screen. Reproduce every value:
layout, spacing, sizes, colors, typography, radii, borders, icons, copy, and each state shown. Reuse the
project's design tokens and components; where none matches, use the design's exact value. Before Step 5,
walk the design node by node against your markup and **name each value you matched** — any difference is a
bug to fix, not a note. That written comparison becomes the PR's `## Design fidelity`. A design you cannot
reach (missing asset, contradictory, screen absent) is Step Q, not a PR.

### Step 3, orchestrator — the implementor subagent

Spawn **one** implementor subagent (`Agent`, `subagent_type: "general-purpose"`,
`model: "$SLOTH_IMPLEMENTOR_MODEL"`, `run_in_background: false`) and **reuse it for every later change**
via `SendMessage` — a Step 4 failure, a tester finding, a reviewer finding, a review round-trip's comments,
an order that changes the scope. Never a fresh implementor per fix: it already holds the code in context.

Its brief carries everything it cannot read for itself, and nothing it can:

- the worktree `$WT` — it works only there, on the branch already checked out, and never touches
  `$SLOTH_RUNNER_ROOT`, a shared database or a port another session uses;
- the issue's number and title, its body and the binding parts of the thread (answers, orders, extra
  instructions), quoted — it has no `gh` access to the issue and must not use any;
- the paths of any downloaded design files, and that the design is the spec (the paragraph above);
- where the project's rules are (`CLAUDE.md` / `AGENTS.md`, the rules and skills they point at) — it reads
  and follows them itself;
- the scope: tightly the issue, no unrelated cleanup, no tests unless the issue or the repo asks;
- the time it has: `$SLOTH_DEADLINE` minus what Steps 4–6 need (`session` skill);
- what to return: the files changed and why, the exact checks it ran (the repo's `test` / `lint` / `build`
  / `typecheck` scripts scoped to its change, per Step 4) with their outcome, the design-fidelity walk when
  there is a design, and anything it could not do or found ambiguous — **as a question for you, never a
  guess**. It writes no commits, no comments, no PR, no board moves: those are yours.

Read its report, not its transcript. A failed check it could not fix, or a question it raised, is your Step
Q — with the implementor's words, not a paraphrase. An answer from the thread goes back to it verbatim.

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

**A warm stack** (`SLOTH_WARM=1`, `session` skill): the slot's servers, Redis and database from the
previous run are already up — their pids and name already in `$SESSION_DIR`. Skip createdb, redis-server,
the build and the server starts: sync the schema onto the existing database, reseed, `FLUSHALL` Redis —
the watch-mode servers pick your checkout up themselves. `SLOTH_WARM_SAME=1` (a retry on the same head):
skip even that and go straight to the behaviour. A reset step fails → kill the pids in
`$SESSION_DIR/dev.pid` / `redis.pid` yourself and boot cold as the run skill says.

**Do not repeat work.** While the dev servers run in watch mode, never build just to check — the watcher
recompiles on save; read its output instead. When a build or typecheck *is* needed, scope it to what
changed (`turbo … --filter=<pkg>`, the package's own script), never the whole repo.

Record the exact commands and their output: they become the PR's `## Verification`, which states precisely
**what was verified and what was not**. A failing check you cannot fix is Step Q — do not push over it.

**Orchestrator:** the declared checks (2) are the implementor's — take them from its report and do not
re-run them unless the report is missing one. Bringing the app up and exercising the behaviour (1) is yours:
that is how you judge the work. Anything that fails goes back to the implementor via `SendMessage` — the
failing command and its output verbatim — and it reports again; you never patch it yourself.

## Step 4.5 — Test it in the browser (tester subagent)

When `SLOTH_CHROME=1` and the change has a screen a user can reach, spawn **one** tester subagent
(`Agent`, `subagent_type: "general-purpose"`, `model: "$SLOTH_TESTER_MODEL"`, `run_in_background: false`) and
reuse it for every re-test via `SendMessage`. The app is already up from Step 4: give the tester its URL,
how to log in (from the project's run skill), the exact behaviour the issue describes, the old behaviour that
must be gone, and `$SLOTH_SCREENSHOTS_DIR`. Its task:

1. Load the browser tools with **one** `ToolSearch` call for the `browser_*` Playwright tools:
   `browser_navigate, browser_snapshot, browser_click, browser_type, browser_fill_form, browser_press_key,
   browser_select_option, browser_wait_for, browser_take_screenshot, browser_console_messages,
   browser_network_requests, browser_handle_dialog, browser_close`. If they are missing, report
   `browser tools unavailable` and stop — Step 4 stays the verification.
2. The browser is **this session's own** headless Chrome: an empty profile, nobody else in it, nothing logged
   in. Log in the way the run skill says. Act from `browser_snapshot` refs (`[ref=eN]`), never from pixels; a
   `confirm` / `alert` is answered with `browser_handle_dialog`, not avoided.
3. Drive the issue's behaviour as the user would: the new behaviour works, the old one is gone, the
   surrounding flow still works. After each screen read `browser_console_messages` and
   `browser_network_requests`; uncaught exceptions and failed app requests are findings.
4. **Screenshot every screen it verifies** — `browser_take_screenshot` with
   `filename: "$SLOTH_SCREENSHOTS_DIR/NN-<kebab-what>.png"`: an **absolute** path (a relative one lands in the
   process's working directory, where nothing will find it), a two-digit order, then lowercase letters, digits
   and dashes only. The screen the issue is about in its new state, each state the issue names, and the flow
   around it — at least one, rarely more than six. One screenshot per state, not one per click.
5. `browser_close`. Return raw data: the steps taken, pass / fail for each, every finding with what was seen,
   what could not be tested and why, and the list of screenshot files, each with a one-line caption saying
   what it shows.

A finding is a bug: fix it (**orchestrator:** hand it to the implementor verbatim), re-run the affected
checks of Step 4, and ask the tester to re-test — **and to re-screenshot what changed**, deleting the stale
PNGs first (`rm -f`) so the set in `$SLOTH_SCREENSHOTS_DIR` is only what is true now.

**Then stop the app** — unless `SLOTH_PREVIEW_HOURS` is above `0`, when it stays up for the hand-off in
Step 6, or `SLOTH_WARM_SLOTS=1`, when it stays up for the next run to inherit (`session` skill). The dev
servers are the run's biggest cost in memory, and the commit, the PR and the reviewer rounds
do not need them: kill every pid in `$SESSION_DIR/dev.pid` and `redis.pid` (their process groups too —
`kill -- -<pid>` then `kill <pid>`), empty both files, `SERVERS=stopped`. Keep the database. A re-test in
Step 5.5 brings the app back up the same way, on the same database. Its report is the
browser part of the PR's `## Verification`; its files become the PR's `## Screenshots` (Step 5). A tester that
cannot reach the screen at all is a failed Step 4 (Step Q when you cannot fix it). Skip this step only when
the change has no screen — an API-only fix, a script — and say so in the PR.

## Step 5 — Commit, push, draft PR

Commit in the repo's style — `CLAUDE.md`'s convention if it defines one, otherwise `fix: <what changed>`.
Then:

```bash
git push -u origin "$BRANCH"
# with PNGs in $SLOTH_SCREENSHOTS_DIR — publish_shots is in the `session` skill; not into $BASE, that is the base branch
SHOTS=$(publish_shots "$SLOTH_SCREENSHOTS_DIR")
gh pr create --repo "$SLOTH_REPO" --base "$BASE" --head "$BRANCH" --draft \
  --title "<type>: <what changed>" --body-file "$SESSION_DIR/pr-body.md"
```

Body: `Closes #ISSUE`, the root cause, what changed, `## Verification` (Step 4's commands and what they
showed, the tester's browser run from Step 4.5, plus anything left unverified), then `## Screenshots`
directly after it, and, for a design-driven fix, `## Design fidelity`. **No reviewer
request, no assignee** — a human picks it up from the board. Record `PR` / `PR_URL` in `state.json`.

`## Screenshots` is **never absent**. One of three:

- The tester saved PNGs — one `![<caption>]($SHOTS/<file>?raw=true)` per screenshot, in file order, with its
  caption from Step 4.5 as the line above the image or as the alt text. Never a file that was not taken.
- The change has no screen (API-only, a script) — the single line `No screen changed — nothing to show.`
- `SLOTH_CHROME=0`, no browser was attached — the single line `No browser attached to this session.`

## Step 5.5 — Reviewer-agent loop (max `$SLOTH_REVIEW_ROUNDS`)

Spawn **one** reviewer subagent (`Agent`, `model: "$SLOTH_REVIEWER_MODEL"`, `run_in_background: false`) and **reuse
it every round** via `SendMessage` — never a fresh reviewer per round. Its task: run
`/sloth:review <PR_URL> feedback-only` exactly as that command says (no PR comments, no board moves) and
report the verdict block verbatim.

1. Round 1 via `Agent`; later rounds via `SendMessage`: "The PR has been updated — re-run the feedback-only review".
2. `OK to merge: yes` → Step 6.
3. Otherwise fix every bug and unmet requirement it lists (**orchestrator:** send the verdict block to the
   implementor verbatim and wait for its report), re-run Step 4, commit, push. Re-run the
   behavioural part of Step 4 and the tester (Step 4.5) only when the behaviour they exercised changed.
   When a fix changed **what a screen shows**, the tester re-screenshots it, the new set is published again
   (`SHOTS=$(publish_shots "$SLOTH_SCREENSHOTS_DIR")`, `session` skill — it writes a fresh timestamped
   directory) and the PR body is re-written to those URLs:
   `gh pr edit "$PR_URL" --body-file "$SESSION_DIR/pr-body.md"`. A body left pointing at the old set is wrong.
4. `$SLOTH_REVIEW_ROUNDS` rounds without a pass → Step Q with the remaining findings; the PR stays a draft.

Check the clock before each round (`session` skill). Without time for a round plus Step 6, go to Step Q.

## Step 6 — Ready for review → Code Review

```bash
retry gh pr ready "$PR_URL"
retry gh project item-edit --id "$ITEM_ID" --project-id "$SLOTH_PROJECT_ID" \
  --field-id "$SLOTH_STATUS_FIELD_ID" --single-select-option-id "$SLOTH_COL_CODE_REVIEW_ID"
```

The server reviews the PR there (`/sloth:review … final`, another agent on its own model) and moves the card
on: to `$SLOTH_COL_APPROVED_NAME` for a human to test, or back to `$SLOTH_COL_IN_PROGRESS_NAME` with the
findings as review comments — a new run of this command then addresses them (Step 1, *Existing PR*). Never
move the card to `$SLOTH_COL_APPROVED_NAME` yourself.

With `SLOTH_PREVIEW_HOURS` above `0`, hand the running app over too: write `preview.json` as the **`session`**
skill's *Teardown* says — the app's one local URL and how to sign in, both from the project's run skill — and
leave the servers, database and worktree up. The server tunnels the app, posts the link on the PR and cleans up
after `SLOTH_PREVIEW_HOURS` hours. A project whose app cannot answer on one port gets no preview: tear down in Step 7.

## Step Q — Ask on the issue, then wait

Follow the needs-help protocol in the **`session`** skill: one numbered comment with every open question and
the done / left summary, card to `$SLOTH_COL_NEEDS_HELP_NAME`, `state: waiting`, wait up to
`$SLOTH_WAIT_HOURS` (inbox every minute, thread every 10), stop this session's servers after 30 idle
minutes but keep the code, resume with `max(remaining, 30 min)` when an answer arrives, exit after the
wait window. Never open or finish a PR built on a guess.

## Step 7 — Clean up, report

Teardown per the `session` skill: with `SLOTH_WARM_SLOTS=1` leave the servers and database running —
the server keeps them warm for the next run; otherwise stop this session's processes (if any are still
up) and drop its database. Either way `set_state done`; the worktree slot stays for the server to
return. After a preview hand-off (Step 6) skip the stopping and removing — only `set_state done`
with `SERVERS=preview`; the server takes the environment down later. The branch stays on the remote.

Finish with the report — it is the transcript's last message and the monitor shows it: branch, PR URL, files
changed, what Step 4 and the tester verified and what they did not, how many screenshots the PR carries, review rounds, where the card ended up. For a blocked run:
the question comment URL, whether an answer arrived, where the card is, and what is left.

## Rules

- **Fully autonomous** — never ask in chat, never guess; when blocked, Step Q and wait.
- **Respect `$SLOTH_DEADLINE`** and keep `state.json` current; the server kills stale `working` sessions.
- **Check the inbox at every step boundary.** Orders override everything here — the admin's without limit, a
  developer's within the issue (`session` skill).
- Every comment starts with `$SLOTH_BOT_PREFIX`; **never write `$SLOTH_MENTION` in your own comments.**
  The tester runs on `$SLOTH_TESTER_MODEL`, the reviewer on `$SLOTH_REVIEWER_MODEL`, the implementor (orchestrator
  mode only) on `$SLOTH_IMPLEMENTOR_MODEL`, any other subagent on `$SLOTH_MODEL`.
- **Orchestrator mode never edits code in this session**: one implementor subagent, spawned once and reused,
  makes every change; this session reads, verifies, tests, reviews, commits, and talks to GitHub and the board.
- **The comment thread is part of the spec** — never re-ask what it answers.
- **A referenced design is matched exactly**; a difference is a bug, an unreachable design is a question.
- **A PR that changes a screen shows it**: the tester's screenshots, pushed with `publish_shots`, in
  `## Screenshots`. Never a screenshot that was not taken.
- **Never touch the checkout at `$SLOTH_RUNNER_ROOT`, a shared database, or a port another session uses.**
- **Test in the browser when there is one** (Step 4.5): the tester subagent's run — and a PNG of every screen
  it verified — is part of every PR that touches a screen.
- Do not push on a failed Step 4; do not hand a PR over before the reviewer loop passes; the PR ends
  ready for review, with `Closes #ISSUE`, no reviewer and no assignee.
- Always clean up (Step 7), whether the run succeeds, waits out, or stops early — a preview hand-off (Step 6)
  is the one ending where the server cleans up instead.
