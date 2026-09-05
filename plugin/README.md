# Sloth plugin

The Claude Code plugin the Sloth server runs. It holds the generic commands a headless session executes:
claim an issue off a project board, implement it in a worktree of its own, review the result, hand the card
to a human — and ask on the issue when it needs one.

**Nothing here is project-specific.** How to install dependencies, how to run the app, how to write code,
what the commit convention is, how designs are read — all of that comes from the target repository's own
`CLAUDE.md`, rules and skills. The commands only say *when* to consult them.

## Contents

| Path | What |
|---|---|
| `commands/implement.md` | `/sloth:implement <issue> [order]` — claim → refine with the author when the card cannot be built without guessing (`## Spec` in the body) → worktree → fix → verify → browser tester + screenshots → e2e tests per criterion (`e2e` on) → PR → reviewer loop → Code Review |
| `commands/review.md` | `/sloth:review <pr> [feedback-only\|final]` — verdict block, inline comments, card back to In Progress; `final` (the server's review of every Code Review card) always posts the verdict on the PR, and a pass labels the issue `Fable: approved` and moves the card to Approved for a human to test |
| `commands/status.md` | `/sloth:status <issue> <comment-id>` — answer a mention when no session is running |
| `commands/qa.md` | `/sloth:qa <issue>` — the daily QA sweep's test of one card: check the QA branch out, boot the app, test the merged fix in the browser, post the findings on the issue, write the verdict for the server |
| `commands/stack.md` | `/sloth:stack <tool-id…>` — install the project's stack on the machine Sloth runs on and verify it answers |
| `agents/e2e-writer.md` | The `sloth:e2e-writer` subagent implement spawns while `SLOTH_E2E=1`: one Playwright test per acceptance criterion, into the project's own suite, derived from the criteria and never bent to the code |
| `skills/board/SKILL.md` | Board reads and moves with the ids from the environment, wired-PR lookup, `retry` |
| `skills/session/SKILL.md` | `state.json`, the inbox, the time budget, the needs-help protocol, teardown |

## Install

Standalone, for trying the commands by hand:

```bash
git clone https://github.com/Juratbek/sloth.git
claude --plugin-dir /path/to/sloth/plugin        # loads it for this session only
```

Then `/sloth:implement 123`, `/sloth:review 456`, `/sloth:status 123 987654321`, `/sloth:qa 123`, `/sloth:stack redis postgresql`.

Permanently, once the repository root carries a marketplace entry
(`.claude-plugin/marketplace.json` with `{"name":"sloth", …, "plugins":[{"name":"sloth","source":"./plugin"}]}` —
a marketplace must sit at the repository root, not inside `plugin/`):

```bash
claude plugin marketplace add Juratbek/sloth
claude plugin install sloth@sloth
claude plugin list                                # confirm it is enabled
```

Validate a local checkout after editing it:

```bash
claude plugin validate /path/to/sloth/plugin --strict
```

The Sloth server passes the plugin explicitly on every session it starts, so nothing needs to be installed
for the server to work:

```bash
claude -p "/sloth:implement 123" --plugin-dir <sloth>/plugin \
  --session-id <uuid> --model opus --dangerously-skip-permissions
```

with `cwd` set to the project's runner checkout.

## What the session needs from its environment

The server sets these on every session; the commands read them and never hard-code an id.

| Variable | Meaning |
|---|---|
| `SLOTH_SESSION_DIR` | This run's directory — `state.json`, `inbox/`, pids, markers |
| `SLOTH_REVIEW_COMMENT` | A status reply only: the question was a comment on a line of `$SLOTH_PR`'s diff, with this id; the answer goes into that review thread |
| `SLOTH_ISSUE` / `SLOTH_PR` | The target issue (implement, status) or PR (review) |
| `SLOTH_REPO` | `owner/repo` |
| `SLOTH_BOARD` | `github` (a Projects v2 board) or `trello` (a Trello board — its lists are the columns, and the `board` skill's Trello section says how a session reads and moves a card there) |
| `SLOTH_BOARD_API` | Sloth's own board API on this machine, `http://127.0.0.1:<port>/api/board`: a card's column and a move, for a board that is not GitHub's |
| `SLOTH_PROJECT_ID`, `SLOTH_PROJECT_NUMBER`, `SLOTH_PROJECT_OWNER` | The board (on Trello: the board id, `0`, the member) |
| `SLOTH_STATUS_FIELD_ID` | Its single-select Status field (on Trello: the board id again) |
| `SLOTH_COL_PICKUP_ID` / `_NAME` | Column work is taken from |
| `SLOTH_COL_IN_PROGRESS_ID` / `_NAME` | Claimed / being worked on |
| `SLOTH_COL_NEEDS_HELP_ID` / `_NAME` | Parked, waiting for a human (may be empty) |
| `SLOTH_COL_CODE_REVIEW_ID` / `_NAME` | Handed over: the server gives every PR here `/sloth:review … final` on the review model, Fable by default |
| `SLOTH_COL_APPROVED_ID` / `_NAME` | Passed that review; a human tests it here. Only a passing review moves a card in — the server then posts the preview link on the issue (may be empty) |
| `SLOTH_COL_QA_ID` / `_NAME` | The merged fixes the daily QA sweep tests (`/sloth:qa`); the server moves a card out on the verdict (may be empty) |
| `SLOTH_COL_DONE_ID` / `_NAME` | Where a closed issue's card ends up, and a card that passed the QA sweep — the server moves it; a session never needs to (may be empty) |
| `SLOTH_COLUMNS` | Every Status column on the board as JSON `[{"id","name"}]`, Sloth's and the rest, so a session can move a card anywhere a human asks |
| `SLOTH_QA_BRANCH` | The branch the QA sweep tests; empty means the repository's default branch |
| `SLOTH_STACK` | The tools the project's app needs on this machine, space-separated (`postgresql redis node …`) |
| `SLOTH_STACK_INSTALL` | Only on a `/sloth:stack` run: the tools that run has to install — the same list as its arguments |
| `SLOTH_RUNNER_ROOT` | The checkout sessions run from |
| `SLOTH_WORKTREES_DIR` | Where Sloth's pool of worktrees lives — `slot-1 … slot-N` under it |
| `SLOTH_WORKTREE` | The slot leased to this run; the session resets it to its branch and leaves it, the server returns it to the pool |
| `SLOTH_ADMIN_LOGIN` | The admin — the one login whose orders have no limit (may be empty: nobody is admin) |
| `SLOTH_DEVELOPER_LOGINS` | Space-separated logins whose orders are followed within the issue they are on (may be empty) |
| `SLOTH_TESTER_LOGINS` | Space-separated logins that answer questions and ask for status, never order (may be empty) |
| `SLOTH_MODEL` | The model this session runs on; a subagent with no model of its own runs on it too |
| `SLOTH_TESTER_MODEL` | The model the browser tester subagent runs on (`opus`) |
| `SLOTH_REVIEWER_MODEL` | The model the reviewer subagent runs on (`opus`) |
| `SLOTH_E2E` | `1` when the `e2e` switch is on: implement spawns the e2e-writer subagent after the tester and the QA sweep runs the PR's added spec files. The review reads the PR's own `E2E` line, not this variable |
| `SLOTH_E2E_MODEL` | The model the e2e-writer subagent runs on (`opus`) |
| `SLOTH_ORCHESTRATOR` | `1` when the implement session is an orchestrator (`orchestrator` in the config): it runs on the orchestrator model and hands every code change to an implementor subagent |
| `SLOTH_IMPLEMENTOR_MODEL` | The model the implementor subagent runs on in orchestrator mode — the config's `models.implement` (`opus`) |
| `SLOTH_CHROME` | `1` when the server attached a headless Chrome through Playwright MCP (`browser_*` tools); implement then tests the change in it and screenshots it |
| `SLOTH_SCREENSHOTS_DIR` | Where the tester saves its PNGs — `$SLOTH_SESSION_DIR/screenshots`, also Playwright's output dir |
| `SLOTH_ASSETS_BRANCH` | The branch screenshots are pushed to so the PR can embed them (`sloth-assets`); never a code branch |
| `SLOTH_PREVIEW_HOURS` | How long a finished implement run's app stays up behind a public link on its PR; `0` means previews are off, always tear down |
| `SLOTH_START`, `SLOTH_DEADLINE` | Epoch seconds: run start, hard deadline |
| `SLOTH_BUDGET_MIN` | Minutes in a full budget (60; a QA test gets `qa.budgetMinutes`) |
| `SLOTH_WAIT_HOURS` | How long a parked session waits (2) |
| `SLOTH_REVIEW_ROUNDS` | Max reviewer-agent rounds (4) |
| `SLOTH_BOT_PREFIX` | First line of every comment Sloth writes (`**Sloth:**`) |
| `SLOTH_MENTION` | The mention that triggers the server (`@sloth`) |
| `SLOTH_HELP_MENTIONS` | `@login @login…` to put on the last line of a needs-help comment, so GitHub notifies them (may be empty) |

## What the session writes back

Inside `$SLOTH_SESSION_DIR`:

| File | Content |
|---|---|
| `state.json` | `{state:"working"\|"waiting"\|"done", since, step, note, branch, pr, servers}` — updated at every step change |
| `inbox/<commentId>.md` | Written by the **server** — `author:`, `role:` (`admin` / `developer` / `tester`) and `comment:` header lines, `pr:` when written on the PR and `thread: review` + `path:` + `line:` when written on a line of its diff (then the file is `review-<commentId>.md`), then the body; read, acted on, then deleted by the session |
| `blocked` | Touched when the run is parked and must not be retried; removed on resume |
| `asked_at` | Epoch seconds of the question comment |
| `dev.pid`, `redis.pid`, `demo.db` | Pids / database name of anything the session started, for the server's cleanup |
| `screenshots/*.png` | The tester's screenshots of the screens it verified; pushed to `$SLOTH_ASSETS_BRANCH` by `publish_shots` (`session` skill) and embedded in the PR's `## Screenshots` |
| `preview.json` | `{url, login}` — an implement run that handed its PR over with `SLOTH_PREVIEW_HOURS` above 0 leaves its app running and names the one local URL it answers on and how to sign in; the server tunnels it, posts the link on the PR and tears the run down after that many hours |
| `verdict` | A `/sloth:qa` run's one word — `passed`, `failed` or `inconclusive` — written after its comment on the issue; the server moves the card on it (Done, In Progress, or nowhere) |

The **last message of the transcript is the report** — the monitor shows it.

## Behaviour worth knowing

- One comment per question, numbered, with the context each answer needs; it ends with `cc $SLOTH_HELP_MENTIONS`
  when the server configured people to notify.
- Every comment starts with `$SLOTH_BOT_PREFIX`; the session never writes `$SLOTH_MENTION` itself.
- Orders override everything, in any column, at any step: the admin's without limit, a developer's within the issue. A tester answers and asks; a login with no role never reaches a session — the server drops those comments.
- An open PR on the issue whose branch is `sloth/issue-<n>-*` is resumed, not duplicated.
- The reviewer subagent is spawned once and reused across rounds.
- Sloth writes no code comments: names carry the meaning, a stretch that needs explaining becomes a well-named
  function; only toolchain directives and comments the project's `CLAUDE.md` requires are allowed. The reviewer
  treats a comment the diff adds as a bug (`commands/implement.md` Step 3, `commands/review.md` Assess 2).
- With `SLOTH_ORCHESTRATOR=1` the implement session never edits code: one implementor subagent (spawned once, reused
  for every fix) makes every change, while the session keeps the issue, the board, verification, the tester, the
  reviewer loop and the PR.
- With `SLOTH_CHROME=1` the implement session spawns one tester subagent that drives the change in a headless
  Chrome of its own — its own empty profile, nobody else's browser — with the snapshot, console and network
  checked, saves a PNG per screen it verified into `$SLOTH_SCREENSHOTS_DIR`, and fixes what it finds before the PR.
- With `SLOTH_E2E=1` the implement session spawns the `sloth:e2e-writer` agent once the tester passed, or with no tester attached: one Playwright
  test per acceptance criterion of the card's `## Spec` (of the issue's own behaviour without one), in the project's
  e2e suite, run against the session's app, committed with the code. A red test is handed to the implementor as a
  bug. A project without a Playwright setup gets none — Sloth adds no framework. The PR's `E2E` line says what
  happened either way, and the review holds a PR that counts tests to one per criterion.
- With `SLOTH_PREVIEW_HOURS` above 0 an implement run that reaches Code Review leaves its app, database and worktree up and
  writes `preview.json`; the server does the teardown, hours later. Every other ending tears down in the session.
- A card in Code Review is reviewed by the server (`/sloth:review … final`), Sloth's PR or a human's: a pass moves it to
  Approved, where a human tests it from the preview link; a fail moves it back to In Progress with the findings, and a
  new `/sloth:implement` run on the issue addresses them on the same branch. The review waits until the implement
  session that handed the card over has ended — one owner per card — and the verdict it posts on the PR is the record:
  a card left in Code Review with a verdict on its head and nobody on it is put where the verdict says.
- A `/sloth:qa` run is the daily QA sweep's test of one card: its slot reset to `$SLOTH_QA_BRANCH` at its current
  head (never the issue's own implement slot), the app booted the way the project's run skill says, and the tester
  subagent driving the merged fix as the user the issue is about. It comments the result on the issue —
  steps, what was seen, screenshots — and writes `verdict`; it moves no card and never asks for help: what it
  cannot test is `inconclusive`, and the card stays for a human.
- A `/sloth:stack` run is not a board run: no issue, no card, no worktree, no git. It installs, starts the
  services, verifies each tool answers and reports — with `sudo -n` for `apt-get`, `service` / `systemctl`
  and `createuser` only (the Stack page writes that rule), never a password, never another command.
- A Sloth PR that changes a screen carries `## Screenshots` — the tester's PNGs, pushed to `$SLOTH_ASSETS_BRANCH`
  and embedded — and the reviewer sends back one that does not. A change with no screen says so in that section.
