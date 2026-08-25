# Sloth

Sloth watches your GitHub project board and lets Claude Code do the work while you rest.

Move a card into the watched column and, a few minutes later, a headless Claude Code session is
working on that issue in its own git worktree: it implements the change, exercises it, opens a PR,
reviews other people's PRs, and asks on the issue when it is stuck. Sloth is the process that
notices the card, starts the session, keeps it inside its time budget, and shows you what it is
doing.

One Sloth instance watches one board. Everything it owns lives under `~/.sloth/`.

```bash
git clone https://github.com/Juratbek/sloth.git && cd sloth
pnpm install
pnpm dev            # http://localhost:4400 — UI and watcher in one process
```

`pnpm start` (after `pnpm build`) runs the same thing against the built UI. Watching stops when the
process stops — there is no daemon, no cron entry, no launchd agent.

## Get started

The first time you open the UI there is no configuration, so Sloth shows a **Get started** wizard
instead of the monitor:

1. **Environment** — checks `claude --version`, `gh --version` and `gh auth status`. All three must pass.
2. **Project board** — pick one of your open GitHub Projects (v2) boards.
3. **Columns** — pick the column Sloth watches, plus the ones it moves cards to. A role with no
   matching column on the board says *will be created*, and Sloth adds that option to the Status
   field when you save.
4. **Repository & runner** — pick the repository, the checkout the sessions run from ("Clone it"
   clones into `~/.sloth/runners/<repo>`), who may give orders, and the session caps.
5. **Done** — writes `~/.sloth/config.json` and starts watching.

The gear in the header re-opens the wizard for the board and the columns; everything else is edited
in the config file.

## How it works

### Triggers

| # | When | What Sloth does |
|---|---|---|
| 1 | An unassigned issue sits in the watched column | Moves it to In Progress and starts `/sloth:implement <n>` |
| 2 | An unassigned issue sits in In Progress with no live session | Relaunches it — a reboot or a usage-limit retry — at most `maxRetries` times in a row |
| 3 | A comment mentions `@sloth` | Delivers it to the live session's inbox; with no session, an order starts one and anything else gets a status reply |
| 4 | An unassigned issue in Code Review has an open, non-draft, unapproved wired PR | Runs `/sloth:review <pr>`, once per PR head |

The board is read every 5 minutes, comments every 2. **Tick now** in the header runs both
immediately. Ticks never overlap.

An **assignee on a card means a human owns it** — Sloth never picks it up, in any column. Sloth
never assigns anyone and never requests a reviewer.

Only `orderLogin` can give orders; a comment from that login ending in `?` is a status question, not
an order. Status questions are answered for anyone. Every comment Sloth writes starts with
`**Sloth:**`, which is also how it knows not to answer itself.

### Columns

Four roles, all mapped to options of the board's Status field:

- **pickup** — the column you drop work into. Sloth only reads it.
- **In Progress** — where a card sits while a session works on it.
- **needs help** — where a session parks a card it cannot finish, after commenting its open questions.
- **Code Review** — where a finished PR's card waits, and where trigger 4 looks.

Missing columns are created after the pickup column, in that order. Creating one rewrites the whole
option list, so Sloth passes every existing option back with its id — no option is ever dropped.

### Sessions

A session is `claude -p "/sloth:implement 42" --plugin-dir <sloth>/plugin …`, detached, running in
the runner root. It survives a Sloth restart; on startup Sloth re-adopts live sessions from their
pid files. Sessions always run Sloth's own plugin commands, never the project's.

Caps: `maxActive` sessions in the working state, `maxAlive` including the ones waiting for an
answer. A trigger that finds no free slot logs `queued (slots full)` and is retried next tick.

Each session has a budget (`budgetMinutes`, default 60) it enforces itself. Sloth kills one that is
still working `budgetMinutes + 5` later, cleans up after it (servers, database, worktree), and parks
the issue on the second kill. A session that stops on a Claude usage limit pauses the whole watcher
for 30 minutes and never costs the card its place.

### Files

```
~/.sloth/
├── config.json                     the whole configuration
├── watcher.log                     one [ISO] line per event — the log the UI tails
├── runners/<repo>/                 the checkout the sessions run from
├── worktrees/<repo>/issue-42/      one worktree per issue
├── sessions/<repo>/
│   ├── issue-42/                   pid, session_id, run.log, state.json, inbox/, retries, kills, blocked
│   └── review-91/
└── state/
    ├── seen/<comment-id>           comments already acted on
    ├── reviewed/<pr>-<sha>         PR heads already reviewed
    └── paused_until                epoch seconds; set by a usage-limit exit
```

A session directory is the protocol between Sloth and the plugin. Sloth writes `pid` and
`session_id` and reads `state.json` (`state` = `working` / `waiting` / `done`, `since`, `step`,
`note`, `branch`, `pr`, `servers`), `retries`, `kills`, `blocked`, and `run.log`. It delivers
comments as `inbox/<comment-id>.md` with `author:` / `comment:` header lines; the session deletes
them once read.

## The plugin

`plugin/` is a Claude Code plugin with three commands, run by the sessions:

| Command | Does |
|---|---|
| `/sloth:implement <issue>` | Implements the issue in its own worktree and opens the PR |
| `/sloth:review <pr>` | Reviews one PR version against its issue |
| `/sloth:status <issue> <comment-id>` | Answers a status question on the issue |

The runner passes `--plugin-dir <sloth>/plugin`, so nothing needs installing. To use the commands
yourself: `claude plugin marketplace add Juratbek/sloth` then `claude plugin install sloth@sloth`.

Sessions read their whole world from the environment: `SLOTH_SESSION_DIR`, `SLOTH_ISSUE` /
`SLOTH_PR`, `SLOTH_REPO`, `SLOTH_PROJECT_*`, `SLOTH_STATUS_FIELD_ID`, `SLOTH_COL_*_ID` / `_NAME`,
`SLOTH_RUNNER_ROOT`, `SLOTH_WORKTREES_DIR`, `SLOTH_ORDER_LOGIN`, `SLOTH_MODEL`, `SLOTH_START`,
`SLOTH_DEADLINE`, `SLOTH_BUDGET_MIN`, `SLOTH_WAIT_HOURS`, `SLOTH_REVIEW_ROUNDS`,
`SLOTH_BOT_PREFIX`, `SLOTH_MENTION`.

## Configuration

`~/.sloth/config.json` (override the path with `SLOTH_CONFIG`). The wizard writes it; the values it
does not ask about default as below.

```json
{
  "version": 1,
  "repo": "owner/repo",
  "project": { "id": "PVT_…", "number": 8, "owner": "login", "title": "Board" },
  "statusField": {
    "id": "PVTSSF_…",
    "columns": {
      "pickup":     { "id": "…", "name": "Todo" },
      "inProgress": { "id": "…", "name": "In Progress" },
      "needsHelp":  { "id": "…", "name": "Sloth needs help" },
      "codeReview": { "id": "…", "name": "Code Review" }
    }
  },
  "runnerRoot": "~/.sloth/runners/repo",
  "orderLogin": "your-github-login"
}
```

| Key | Default | Means |
|---|---|---|
| `runnerRoot` | `~/.sloth/runners/<repo>` | The checkout sessions run in |
| `runnersDir` | `~/.sloth/runners` | Where "Clone it" puts checkouts |
| `worktreesDir` | `~/.sloth/worktrees/<repo>` | One worktree per issue lives here |
| `sessionsDir` | `~/.sloth/sessions/<repo>` | Session directories |
| `stateDir` | `~/.sloth/state` | `seen/`, `reviewed/`, `paused_until` |
| `watcherLog` | `~/.sloth/watcher.log` | The log the UI tails |
| `orderLogin` | the login found in the wizard | The only login whose `@sloth` comments are orders |
| `mention` | `@sloth` | The keyword that wakes Sloth, case-insensitive |
| `botPrefix` | `**Sloth:**` | Every comment Sloth writes starts with this |
| `maxActive` / `maxAlive` | `3` / `5` | Session caps |
| `budgetMinutes` | `60` | A session's time budget |
| `waitHours` | `2` | How long a parked session waits for an answer |
| `reviewRounds` | `4` | Reviewer-agent rounds before the session asks for help |
| `maxRetries` | `2` | Trigger-2 relaunches before the card is parked |
| `boardSeconds` / `commentSeconds` | `300` / `120` | Poll intervals |
| `model` | `opus` | The model every session runs on |

Only two environment variables are read: `SLOTH_CONFIG` (config path) and `SLOTH_PORT` (default
`4400`). `SLOTH_DRY_RUN=1` makes every tick log what it *would* do without touching anything.

## What the UI shows

- **Sessions** grouped as live / needs help / finished, with status, elapsed time, context size and token spend.
- **Chat** — the full transcript of a session: text, thinking, tool calls and (clipped) tool results.
- **Subagents** — every `Agent` / `Task` call, its prompt, model, spend, and its own transcript.
- **Watcher** — the session's directory: step, branch, PR, retries, kills, inbox, `run.log` tail.
- **Home panel** — hourly token spend across all transcripts, the queue implied by the log, and the log itself.
- **Top bar** — working/waiting counts against the caps, the watched column, the next board and comment ticks, GitHub rate-limit warnings.

Everything refreshes on a 15s poll plus an SSE stream that fires whenever a watched file changes.
Transcripts are read where Claude Code puts them: `~/.claude/projects/<runner root with every
non-alphanumeric character replaced by '-'>`.

## API

Read-only: `GET /api/overview`, `GET /api/sessions/:id`, `GET /api/sessions/:id/agents/:agentId`,
`GET /api/usage?days=N`, and the `GET /api/events` SSE stream.

Writes: `POST /api/tick` (`?dry=1` for a dry run), `POST /api/setup/config`, `POST /api/setup/clone`.

Setup, used by the wizard: `GET /api/setup/env`, `GET /api/setup/projects`,
`GET /api/setup/projects/:id/fields`, `GET /api/setup/config`.

Every shell-out uses `execFile` / `spawn` with an argv array — no shell strings, anywhere.

## Conventions

Source files stay under 200 lines. `useEffect` is only used inside a dedicated hook that subscribes
to something outside React (`use-live-updates`, `use-follow-bottom`), with a comment saying why.

```bash
pnpm lint              # tsc --noEmit
pnpm build
```

MIT licensed.
