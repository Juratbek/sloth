# claude-bot-monitor

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
| launchd plist (optional) | `PICKUP_COLUMN`, `MAX_ACTIVE`, `MAX_ALIVE`, `MODEL` |
| `gh api` | issue/PR titles and rate-limit buckets |

Transcripts live where Claude Code puts them: `~/.claude/projects/<runner root with every non-alphanumeric
character replaced by '-'>`. That path is derived from `MONITOR_RUNNER_ROOT` unless you set it directly.

Inside a session directory the monitor understands: `pid` (liveness), `session_id` (links the directory to a
transcript), `state.json` (`state`, `step`, `note`, `branch`, `pr`, `servers`), `run.log` (tail), `inbox/*.md`
(pending answers), `retries`, `kills`, and a `blocked` marker file. A session directory with no matching
transcript is listed as an orphan.

A session's *kind* comes from its prompt: `/<command> <number>` where `<command>` is a key of
`MONITOR_COMMANDS`. The matching value is the GitHub path segment used for the link (`issues` or `pull`).

## Configuration

Read from the process environment first, then from a `.env` file in the repo root. Copy `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `MONITOR_REPO` | — | `owner/repo` for issue/PR links and title lookups. Empty ⇒ no links, no `gh` title calls |
| `MONITOR_RUNNER_ROOT` | cwd | Checkout the sessions run in; the transcripts path is derived from it |
| `MONITOR_TRANSCRIPTS_DIR` | derived | Override the derived transcripts directory |
| `MONITOR_SESSIONS_DIR` | `~/bot-sessions` | Where the watcher keeps its per-run directories |
| `MONITOR_STATE_DIR` | `~/.bot-state` | Watcher state (`seen/`, `reviewed/`, `paused_until`) |
| `MONITOR_WATCHER_LOG` | `~/bot-watcher.log` | Watcher log file |
| `MONITOR_PLIST` | — | launchd plist to read the watcher's env from |
| `MONITOR_COMMANDS` | `{"implement":"issues","review":"pull","issue-status":"issues"}` | Command → GitHub path segment |
| `MONITOR_TICK_COMMAND` | — | JSON argv array run by the Tick button (no shell). Unset ⇒ button hidden |
| `MONITOR_TICK_SECONDS` | `300` | Watcher tick interval, for the "next tick" pill |
| `MONITOR_TITLE` | `Claude bot monitor` | Header and document title |
| `MONITOR_PORT` | `4400` | Dev and preview port |

`PICKUP_COLUMN`, `MAX_ACTIVE`, `MAX_ALIVE` and `MODEL` are read from the plist if configured, else from the
environment / `.env`.

## Running

```bash
pnpm install
cp .env.example .env   # then edit
pnpm dev               # http://localhost:4400
pnpm build && pnpm start
pnpm lint              # tsc --noEmit
```

## API

`GET /api/overview`, `GET /api/sessions/:id`, `GET /api/sessions/:id/agents/:agentId`, `GET /api/usage?days=N`
and the `GET /api/events` SSE stream are all read-only.

The one write is `POST /api/tick`: it spawns `MONITOR_TICK_COMMAND` (e.g.
`["launchctl","kickstart","gui/501/com.example.watcher"]`) to make the watcher run immediately. With no tick
command configured the endpoint returns 404 and the button is not rendered.

## Conventions

Source files stay under 200 lines. `useEffect` is only used inside a dedicated hook that subscribes to
something outside React (`use-live-updates`, `use-follow-bottom`), with a comment saying why.
