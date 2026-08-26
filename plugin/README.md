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
| `commands/implement.md` | `/sloth:implement <issue> [order]` — claim → worktree → fix → verify → PR → reviewer loop → Code Review |
| `commands/review.md` | `/sloth:review <pr> [feedback-only]` — verdict block, inline comments, card back to In Progress |
| `commands/status.md` | `/sloth:status <issue> <comment-id>` — answer a mention when no session is running |
| `skills/board/SKILL.md` | Board reads and moves with the ids from the environment, wired-PR lookup, `retry` |
| `skills/session/SKILL.md` | `state.json`, the inbox, the time budget, the needs-help protocol, teardown |

## Install

Standalone, for trying the commands by hand:

```bash
git clone https://github.com/Juratbek/sloth.git
claude --plugin-dir /path/to/sloth/plugin        # loads it for this session only
```

Then `/sloth:implement 123`, `/sloth:review 456`, `/sloth:status 123 987654321`.

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
| `SLOTH_COL_APPROVED_ID` / `_NAME` | Approved by a human; the server runs the project's own review command on its PR (may be empty) |
| `SLOTH_RUNNER_ROOT` | The checkout sessions run from |
| `SLOTH_WORKTREES_DIR` | Where per-issue worktrees go — `issue-<n>` under it |
| `SLOTH_ORDER_LOGIN` | The one login whose comments are orders |
| `SLOTH_MODEL` | The model subagents run on (`opus`) |
| `SLOTH_START`, `SLOTH_DEADLINE` | Epoch seconds: run start, hard deadline |
| `SLOTH_BUDGET_MIN` | Minutes in a full budget (60) |
| `SLOTH_WAIT_HOURS` | How long a parked session waits (2) |
| `SLOTH_REVIEW_ROUNDS` | Max reviewer-agent rounds (4) |
| `SLOTH_BOT_PREFIX` | First line of every comment Sloth writes (`**Sloth:**`) |
| `SLOTH_MENTION` | The mention that triggers the server (`@sloth`) |

## What the session writes back

Inside `$SLOTH_SESSION_DIR`:

| File | Content |
|---|---|
| `state.json` | `{state:"working"\|"waiting"\|"done", since, step, note, branch, pr, servers}` — updated at every step change |
| `inbox/<commentId>.md` | Written by the **server**; read, acted on, then deleted by the session |
| `blocked` | Touched when the run is parked and must not be retried; removed on resume |
| `asked_at` | Epoch seconds of the question comment |
| `dev.pid`, `redis.pid`, `demo.db` | Pids / database name of anything the session started, for the server's cleanup |

The **last message of the transcript is the report** — the monitor shows it.

## Behaviour worth knowing

- One comment per question, numbered, with the context each answer needs.
- Every comment starts with `$SLOTH_BOT_PREFIX`; the session never writes `$SLOTH_MENTION` itself.
- Orders from `$SLOTH_ORDER_LOGIN` override everything, in any column, at any step.
- An open PR on the issue whose branch is `sloth/issue-<n>-*` is resumed, not duplicated.
- The reviewer subagent is spawned once and reused across rounds.
- No image, gif or video is ever required: verification and design fidelity are described in words.
