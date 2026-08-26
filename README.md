# Sloth

Sloth watches a GitHub project board and lets Claude Code do the work while you rest. Move a card
into the watched column and a headless Claude Code session implements the issue in its own git
worktree, opens a PR, and asks on the issue when it is stuck; Sloth starts the sessions, keeps them
inside their time budget and shows you what they are doing.

```bash
git clone https://github.com/Juratbek/sloth.git && cd sloth
pnpm install
pnpm dev            # http://localhost:4400 — UI and watcher in one process
```

One Sloth watches one board. Everything it owns lives under `~/.sloth/`. Watching stops when the
process stops — there is no daemon. The first time you open the UI a **Get started** wizard checks
`claude` and `gh`, lets you pick the board, its columns, the repository and the checkout the sessions
run from, then writes `~/.sloth/config.json`. The gear in the header re-opens it.

## How it works

The short version; the tick-by-tick account is in [docs/how-it-works.md](docs/how-it-works.md).

| # | When | What Sloth does |
|---|---|---|
| 1 | An unassigned issue sits in the watched column | Moves it to In Progress and starts `/sloth:implement <n>` |
| 2 | An unassigned issue sits in In Progress with no live session | Relaunches it, at most `maxRetries` times in a row |
| 3 | A comment mentions `@sloth` | Delivers it to the live session; with no session, an order starts one and anything else gets a status reply |
| 4 | An unassigned issue in Code Review has an open, non-draft, unapproved wired PR **written by a human** | Runs `/sloth:review <pr>`, once per PR head. Sloth's own PRs were already vetted by their session's reviewer loop |
| 5 | An unassigned issue in Approved has an open, non-draft wired PR | Runs `/sloth:review <pr>` on the `fable` model, once per PR head |

The board is read every 5 minutes, comments every 2; **Tick now** runs both at once. **Pause**
stops Sloth from starting anything new (running sessions, inbox deliveries and status replies carry
on) and survives a restart.

- An **assignee on a card means a human owns it** — Sloth never touches it. Sloth never assigns
  anyone and never requests a reviewer.
- Only `orderLogin` gives orders; a comment from that login ending in `?` is a status question.
  Every comment Sloth writes starts with `**Sloth:**`.
- **Columns** are roles mapped to the board's Status options: *pickup* (Sloth only reads it),
  *In Progress*, *needs help* (a stuck session parks the card here after asking its questions),
  *Code Review* (trigger 4) and *Approved* (trigger 5 — a final review on the Fable model; a GitHub approval does not skip it).
  Missing columns are created after the pickup column, without dropping any existing option.
- **Sessions** are detached `claude -p … --plugin-dir <sloth>/plugin` runs in the runner checkout.
  They survive a Sloth restart. `maxActive` may work at once, `maxAlive` including the ones waiting
  for an answer; a trigger with no free slot is retried next tick. A session past
  `budgetMinutes + 5` is killed, cleaned up, and its card parked. A Claude usage
  limit pauses the watcher for 30 minutes without costing the card its place.

```
~/.sloth/
├── config.json                     the whole configuration
├── watcher.log                     one line per event — the log the UI tails
├── runners/<repo>/                 the checkout the sessions run from
├── worktrees/<repo>/issue-42/      one worktree per issue
├── sessions/<repo>/                issue-42/, review-91/, approved-91/ — pid, state.json, inbox/, run.log …
└── state/                          seen/, reviewed/, approved/ dedupe markers; paused, paused_until
```

## The plugin

`plugin/` is the Claude Code plugin the sessions run: `/sloth:implement <issue>`, `/sloth:review <pr>`
and `/sloth:status <issue> <comment-id>`. Nothing needs installing — Sloth passes `--plugin-dir`. To
use it yourself: `claude plugin marketplace add Juratbek/sloth && claude plugin install sloth@sloth`.
The session protocol (environment variables, `state.json`, the inbox) is in [plugin/README.md](plugin/README.md).

## Configuration

`~/.sloth/config.json` (path overridable with `SLOTH_CONFIG`). The wizard asks about the board, the
columns, `repo`, `runnerRoot`, `orderLogin` and the caps; the rest defaults:

| Key | Default | Means |
|---|---|---|
| `runnersDir` / `worktreesDir` / `sessionsDir` / `stateDir` / `watcherLog` | under `~/.sloth/` | Where checkouts, worktrees, session directories, markers and the log live |
| `mention` / `botPrefix` | `@sloth` / `**Sloth:**` | The keyword that wakes Sloth; the first line of every comment it writes |
| `maxActive` / `maxAlive` | `3` / `5` | Session caps |
| `budgetMinutes` / `waitHours` | `60` / `2` | A session's time budget; how long a parked session waits for an answer |
| `reviewRounds` / `maxRetries` | `4` / `2` | Reviewer-agent rounds before asking for help; trigger-2 relaunches before parking |
| `boardSeconds` / `commentSeconds` | `300` / `120` | Poll intervals |
| `model` | `opus` | The model every session runs on — except trigger 5's |
| `chrome` | `true` | Start implement sessions with `--chrome`, so a tester subagent can click through the change in your Chrome |
| `approvedModel` | `fable` | The model trigger 5's final reviews run on |

Environment: `SLOTH_CONFIG`, `SLOTH_PORT` (default `4400`), and `SLOTH_DRY_RUN=1` to log what every
tick *would* do without doing it.

## UI and API

The UI lists sessions (live / needs help / finished) with their transcript, subagents, token spend and
watcher state, plus a home panel with hourly spend, the queue and the log. It refreshes on a 15s poll
and an SSE stream. Transcripts are read from `~/.claude/projects/<runner root, non-alphanumerics as '-'>`.

Read: `GET /api/overview`, `/api/sessions/:id`, `/api/sessions/:id/agents/:agentId`, `/api/usage?days=N`,
`/api/events` (SSE). Write: `POST /api/tick` (`?dry=1`), `/api/pause`, `/api/resume`, `/api/setup/config`,
`/api/setup/clone`. Wizard reads: `GET /api/setup/env`, `/api/setup/projects`, `/api/setup/projects/:id/fields`,
`/api/setup/config`.

## Conventions

Source files stay under 200 lines. Every shell-out is `execFile` / `spawn` with an argv array — no
shell strings. `useEffect` only lives in a dedicated hook that subscribes to something outside React.
`pnpm lint` (tsc) and `pnpm build`. MIT licensed.
