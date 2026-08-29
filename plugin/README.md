# Sloth plugin

The Claude Code plugin the Sloth server runs. It holds the generic commands a headless session executes:
claim an issue off a project board, implement it in an isolated worktree, review the result, hand the card
to a human — and ask on the issue when it needs one.

**Nothing here is project-specific.** How to install dependencies, how to run the app, how to write code,
what the commit convention is, how designs are read — all of that comes from the target repository's own
`CLAUDE.md`, rules and skills. The commands only say *when* to consult them.

## Contents

| Path | What |
|---|---|
| `commands/implement.md` | `/sloth:implement <issue> [order]` — claim → worktree → fix → verify → browser tester + screenshots → PR → reviewer loop → Code Review |
| `commands/review.md` | `/sloth:review <pr> [feedback-only\|final]` — verdict block, inline comments, card back to In Progress; `final` always posts the verdict on the PR and labels a passing issue `Fable: approved` |
| `commands/status.md` | `/sloth:status <issue> <comment-id>` — answer a mention when no session is running |
| `commands/stack.md` | `/sloth:stack <tool-id…>` — install the project's stack on the machine Sloth runs on and verify it answers |
| `skills/board/SKILL.md` | Board reads and moves with the ids from the environment, wired-PR lookup, `retry` |
| `skills/session/SKILL.md` | `state.json`, the inbox, the time budget, the needs-help protocol, teardown |

## Install

Standalone, for trying the commands by hand:

```bash
git clone https://github.com/Juratbek/sloth.git
claude --plugin-dir /path/to/sloth/plugin        # loads it for this session only
```

Then `/sloth:implement 123`, `/sloth:review 456`, `/sloth:status 123 987654321`, `/sloth:stack redis postgresql`.

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
| `SLOTH_ISSUE` / `SLOTH_PR` | The target issue (implement, status) or PR (review) |
| `SLOTH_REPO` | `owner/repo` |
| `SLOTH_PROJECT_ID`, `SLOTH_PROJECT_NUMBER`, `SLOTH_PROJECT_OWNER` | The board |
| `SLOTH_STATUS_FIELD_ID` | Its single-select Status field |
| `SLOTH_COL_PICKUP_ID` / `_NAME` | Column work is taken from |
| `SLOTH_COL_IN_PROGRESS_ID` / `_NAME` | Claimed / being worked on |
| `SLOTH_COL_NEEDS_HELP_ID` / `_NAME` | Parked, waiting for a human (may be empty) |
| `SLOTH_COL_CODE_REVIEW_ID` / `_NAME` | Handed to a human reviewer |
| `SLOTH_COL_APPROVED_ID` / `_NAME` | Approved by a human; the server gives its PR a final `/sloth:review` on the final-review model, Fable by default (may be empty) |
| `SLOTH_COL_DONE_ID` / `_NAME` | Where a closed issue's card ends up — the server moves it; a session never needs to (may be empty) |
| `SLOTH_COLUMNS` | Every Status column on the board as JSON `[{"id","name"}]`, Sloth's and the rest, so a session can move a card anywhere a human asks |
| `SLOTH_STACK` | The tools the project's app needs on this machine, space-separated (`postgresql redis node …`) |
| `SLOTH_STACK_INSTALL` | Only on a `/sloth:stack` run: the tools that run has to install — the same list as its arguments |
| `SLOTH_RUNNER_ROOT` | The checkout sessions run from |
| `SLOTH_WORKTREES_DIR` | Where per-issue worktrees go — `issue-<n>` under it |
| `SLOTH_ADMIN_LOGIN` | The admin — the one login whose orders have no limit (may be empty: nobody is admin) |
| `SLOTH_DEVELOPER_LOGINS` | Space-separated logins whose orders are followed within the issue they are on (may be empty) |
| `SLOTH_TESTER_LOGINS` | Space-separated logins that answer questions and ask for status, never order (may be empty) |
| `SLOTH_MODEL` | The model this session runs on; a subagent with no model of its own runs on it too |
| `SLOTH_TESTER_MODEL` | The model the browser tester subagent runs on (`opus`) |
| `SLOTH_REVIEWER_MODEL` | The model the reviewer subagent runs on (`opus`) |
| `SLOTH_ORCHESTRATOR` | `1` when the implement session is an orchestrator (`orchestrator` in the config): it runs on the orchestrator model and hands every code change to an implementor subagent |
| `SLOTH_IMPLEMENTOR_MODEL` | The model the implementor subagent runs on in orchestrator mode — the config's `models.implement` (`opus`) |
| `SLOTH_CHROME` | `1` when the server attached a headless Chrome through Playwright MCP (`browser_*` tools); implement then tests the change in it and screenshots it |
| `SLOTH_SCREENSHOTS_DIR` | Where the tester saves its PNGs — `$SLOTH_SESSION_DIR/screenshots`, also Playwright's output dir |
| `SLOTH_ASSETS_BRANCH` | The branch screenshots are pushed to so the PR can embed them (`sloth-assets`); never a code branch |
| `SLOTH_PREVIEW_HOURS` | How long a finished implement run's app stays up behind a public link on its PR; `0` means previews are off, always tear down |
| `SLOTH_START`, `SLOTH_DEADLINE` | Epoch seconds: run start, hard deadline |
| `SLOTH_BUDGET_MIN` | Minutes in a full budget (60) |
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
| `inbox/<commentId>.md` | Written by the **server** — `author:`, `role:` (`admin` / `developer` / `tester`) and `comment:` header lines, then the body; read, acted on, then deleted by the session |
| `blocked` | Touched when the run is parked and must not be retried; removed on resume |
| `asked_at` | Epoch seconds of the question comment |
| `dev.pid`, `redis.pid`, `demo.db` | Pids / database name of anything the session started, for the server's cleanup |
| `screenshots/*.png` | The tester's screenshots of the screens it verified; pushed to `$SLOTH_ASSETS_BRANCH` by `publish_shots` (`session` skill) and embedded in the PR's `## Screenshots` |
| `preview.json` | `{url, login}` — an implement run that handed its PR over with `SLOTH_PREVIEW_HOURS` above 0 leaves its app running and names the one local URL it answers on and how to sign in; the server tunnels it, posts the link on the PR and tears the run down after that many hours |

The **last message of the transcript is the report** — the monitor shows it.

## Behaviour worth knowing

- One comment per question, numbered, with the context each answer needs; it ends with `cc $SLOTH_HELP_MENTIONS`
  when the server configured people to notify.
- Every comment starts with `$SLOTH_BOT_PREFIX`; the session never writes `$SLOTH_MENTION` itself.
- Orders override everything, in any column, at any step: the admin's without limit, a developer's within the issue. A tester answers and asks; a login with no role never reaches a session — the server drops those comments.
- An open PR on the issue whose branch is `sloth/issue-<n>-*` is resumed, not duplicated.
- The reviewer subagent is spawned once and reused across rounds.
- With `SLOTH_ORCHESTRATOR=1` the implement session never edits code: one implementor subagent (spawned once, reused
  for every fix) makes every change, while the session keeps the issue, the board, verification, the tester, the
  reviewer loop and the PR.
- With `SLOTH_CHROME=1` the implement session spawns one tester subagent that drives the change in a headless
  Chrome of its own — its own empty profile, nobody else's browser — with the snapshot, console and network
  checked, saves a PNG per screen it verified into `$SLOTH_SCREENSHOTS_DIR`, and fixes what it finds before the PR.
- With `SLOTH_PREVIEW_HOURS` above 0 an implement run that reaches Code Review leaves its app, database and worktree up and
  writes `preview.json`; the server does the teardown, hours later. Every other ending tears down in the session.
- A `/sloth:stack` run is not a board run: no issue, no card, no worktree, no git. It installs, starts the
  services, verifies each tool answers and reports — with `sudo -n` for `apt-get`, `service` / `systemctl`
  and `createuser` only (the Stack page writes that rule), never a password, never another command.
- A Sloth PR that changes a screen carries `## Screenshots` — the tester's PNGs, pushed to `$SLOTH_ASSETS_BRANCH`
  and embedded — and the reviewer sends back one that does not. A change with no screen says so in that section.
