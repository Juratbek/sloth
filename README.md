# Sloth

Sloth watches your GitHub project board and lets Claude Code do the work while you rest — this is the monitor UI.

A read-only dashboard for headless Claude Code sessions (`claude -p …`) launched by a watcher script.
Vite + React 19 + Tailwind 4 + TanStack Query; the API is a Vite plugin, so `pnpm dev` serves both.

## What it shows

- **Sessions** grouped as live / needs help / finished, with status, elapsed time, context size and token spend.
- **Chat** — the full transcript of a session: text, thinking, tool calls and (clipped) tool results.
- **Subagents** — every `Agent` / `Task` call, its prompt, model, spend, and its own transcript.
- **Watcher** — the session's working directory: step, branch, PR, retries, kills, inbox, `run.log` tail.
- **Home panel** — hourly token spend across all transcripts, the queue implied by the watcher log, and the log itself.
- **Top bar** — working/waiting counts against the caps, pickup column, last/next tick, GitHub rate-limit warnings.

Everything refreshes on a 15s poll plus an SSE stream that fires whenever a watched file changes.

## The data it reads

| Source | Used for |
|---|---|
| `<transcripts>/<session-id>.jsonl` | one session: messages, usage per request, tool counts |
| `<transcripts>/<session-id>/subagents/agent-<id>.jsonl` | one subagent's transcript |
| `<sessions>/{issue,review}-<n>/` | the watcher's per-run directory (see below) |
| `<watcher log>` | log tail, last tick time, queued targets |
| `<state>/seen`, `<state>/reviewed`, `<state>/paused_until` | watcher counters and pause window |
| `~/.sloth/config.json` | board, columns, repo, runner root, caps, model |
| launchd plist (optional) | legacy `PICKUP_COLUMN`, `MAX_ACTIVE`, `MAX_ALIVE`, `MODEL` |
| `gh api` | issue/PR titles and rate-limit buckets |

Transcripts live where Claude Code puts them: `~/.claude/projects/<runner root with every non-alphanumeric
character replaced by '-'>`. That path is derived from the configured runner root unless you set it directly.

Inside a session directory the monitor understands: `pid` (liveness), `session_id` (links the directory to a
transcript), `state.json` (`state`, `step`, `note`, `branch`, `pr`, `servers`), `run.log` (tail), `inbox/*.md`
(pending answers), `retries`, `kills`, and a `blocked` marker file. A session directory with no matching
transcript is listed as an orphan.

A session's *kind* comes from its prompt: `/<command> <number>` where `<command>` is a key of the command
map. The matching value is the GitHub path segment used for the link (`issues` or `pull`).

## Get started

```bash
git clone https://github.com/Juratbek/sloth.git && cd sloth
pnpm install
pnpm dev            # http://localhost:4400
```

The first time you open the UI there is no configuration, so Sloth shows a **Get started** wizard
instead of the monitor:

1. **Environment** — checks `claude --version`, `gh --version` and `gh auth status`. All three must pass.
2. **Project board** — pick one of your open GitHub Projects (v2) boards.
3. **Columns** — pick the column Sloth watches, plus the ones it moves cards to (In Progress,
   Needs help, Code Review). They are pre-filled by name where possible.
4. **Repository & runner** — pick the repository (from the board's linked repos or by typing
   `owner/repo`), the local checkout the sessions run from (with a "Clone it" button), and the
   session caps.
5. **Done** — writes the config file and opens the monitor.

The gear in the header re-opens the wizard, pre-filled, to change any of it later.

## Configuration

Configuration lives in `~/.sloth/config.json` (override the location with `SLOTH_CONFIG`):

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
      "needsHelp":  { "id": "…", "name": "Needs help" },
      "codeReview": { "id": "…", "name": "Code Review" }
    }
  },
  "runnerRoot": "/abs/path/to/checkout",
  "sessionsDir": "~/.sloth/sessions",
  "stateDir": "~/.sloth/state",
  "watcherLog": "~/.sloth/watcher.log",
  "maxActive": 3,
  "maxAlive": 5,
  "tickSeconds": 300,
  "tickCommand": null,
  "model": "opus"
}
```

`needsHelp` may be `null`; the other three columns are required. `tickCommand` is the argv array
(no shell) run by the "Tick now" button — unset ⇒ the button is hidden and `/api/tick` 404s.

### Environment overrides

Every value can be overridden from the process environment or a `.env` file in the repo root
(see `.env.example`). **An override always wins over the config file** — useful for pointing one
checkout at another watcher's directories.

| Variable | Overrides |
|---|---|
| `SLOTH_CONFIG` | Path of the config file itself (default `~/.sloth/config.json`) |
| `SLOTH_REPO` | `repo` |
| `SLOTH_RUNNER_ROOT` | `runnerRoot` |
| `SLOTH_TRANSCRIPTS_DIR` | The transcripts path derived from `runnerRoot` |
| `SLOTH_SESSIONS_DIR` | `sessionsDir` |
| `SLOTH_STATE_DIR` | `stateDir` |
| `SLOTH_WATCHER_LOG` | `watcherLog` |
| `SLOTH_TICK_COMMAND` / `SLOTH_TICK_SECONDS` | `tickCommand` / `tickSeconds` |
| `PICKUP_COLUMN`, `MAX_ACTIVE`, `MAX_ALIVE`, `MODEL` | The pickup column name, the caps, the model |
| `SLOTH_COMMANDS` | Command → GitHub path segment map (default `implement`/`review`/`issue-status`) |
| `SLOTH_TITLE` | Header and document title (default `Sloth · <repo name>`) |
| `SLOTH_PORT` | Dev and preview port (default `4400`) |
| `SLOTH_PLIST` | launchd plist to read `PICKUP_COLUMN` / `MAX_ACTIVE` / `MAX_ALIVE` / `MODEL` from, for watchers that predate the config file. The config file wins over it. |

## Running

```bash
pnpm dev               # http://localhost:4400
pnpm build && pnpm start
pnpm lint              # tsc --noEmit
```

## API

Monitor (read-only): `GET /api/overview`, `GET /api/sessions/:id`, `GET /api/sessions/:id/agents/:agentId`,
`GET /api/usage?days=N` and the `GET /api/events` SSE stream.

Setup (used by the wizard):

| Endpoint | Does |
|---|---|
| `GET /api/setup/env` | Runs `claude --version`, `gh --version`, `gh auth status`, `gh api user` |
| `GET /api/setup/projects` | Open Projects (v2) boards of the user and their orgs |
| `GET /api/setup/projects/:id/fields` | The board's Status options (in board order) and its linked repos |
| `POST /api/setup/clone` | `gh repo clone <owner/repo> <path>` |
| `GET /api/setup/config` | The saved config, or 404 when there is none |
| `POST /api/setup/config` | Validates and writes the config file, then reloads it |

Writes: `POST /api/setup/config`, `POST /api/setup/clone`, and `POST /api/tick` — which spawns the configured
tick command (e.g. `["launchctl","kickstart","gui/<uid>/com.example.watcher"]`) to make the watcher run
immediately. With no tick command configured that endpoint returns 404 and the button is not rendered.

Every shell-out uses `execFile` with an argv array — no shell.

## Conventions

Source files stay under 200 lines. `useEffect` is only used inside a dedicated hook that subscribes to
something outside React (`use-live-updates`, `use-follow-bottom`), with a comment saying why.
