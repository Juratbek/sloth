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
| 3 | Someone on the team mentions `@sloth` in a comment | Delivers it to the live session; with no session, an order (admin or developer) starts one and anything else gets a status reply. A login with no role is ignored |
| 4 | An unassigned issue in Code Review has an open, non-draft, unapproved wired PR **written by a human** | Runs `/sloth:review <pr>`, once per PR head. Sloth's own PRs were already vetted by their session's reviewer loop |
| 5 | An issue in Approved — assigned or not — has an open, non-draft wired PR and no `Fable: approved` label | Runs `/sloth:review <pr> final` on the `fable` model, once per PR head; the verdict is posted on the PR either way, and a pass labels the issue `Fable: approved`, which keeps it from being reviewed again |

The board is read every 5 minutes, comments every 2; **Tick now** runs both at once. **Pause**
stops Sloth from starting anything new (running sessions, inbox deliveries, status replies and
needs-help notifications carry on) and survives a restart.

- An **assignee on a card means a human owns it** — Sloth never works on it. The one exception is the
  final review in Approved (trigger 5): an assigned card is reviewed too, and a rejection sends it back
  to In Progress still assigned, so the owner keeps it. Sloth never assigns anyone and
  never requests a reviewer.
- **Roles** (`roles` in the config, the wizard's *Team* step): one **admin** orders Sloth anything —
  work, a move to any column, closing an issue. **Developers** order work within an issue — how to do
  it, address the review comments, start over, stop; an order that reaches beyond the issue becomes a
  question for the admin. **Testers** answer a parked card's questions and ask for status, but never
  order. A comment ending in `?` is always a status question. Sloth ignores logins with no role: no
  reply, and their comments do not count as answers. Every comment Sloth writes starts with `**Sloth:**`.
- **Columns** are roles mapped to the board's Status options: *pickup* (Sloth only reads it),
  *In Progress*, *needs help* (a stuck session parks the card here after asking its questions; an
  answer in the thread brings it back — `helpLogins` are mentioned in that question and `helpWebhook`
  is called, see *Configuration*),
  *Code Review* (trigger 4) and *Approved* (trigger 5 — a final review on the Fable model; a GitHub approval does not skip it,
  the verdict lands on the PR pass or fail, and a pass labels the issue `Fable: approved`).
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
└── state/                          seen/, reviewed/, approved/, notified/ dedupe markers; paused, paused_until
```

## The plugin

`plugin/` is the Claude Code plugin the sessions run: `/sloth:implement <issue>`, `/sloth:review <pr>`
and `/sloth:status <issue> <comment-id>`. Nothing needs installing — Sloth passes `--plugin-dir`. To
use it yourself: `claude plugin marketplace add Juratbek/sloth && claude plugin install sloth@sloth`.
The session protocol (environment variables, `state.json`, the inbox) is in [plugin/README.md](plugin/README.md).

## Configuration

`~/.sloth/config.json` (path overridable with `SLOTH_CONFIG`). The wizard asks about the board, the
columns, who to notify when a card needs help, `repo`, `runnerRoot`, the team (`roles`) and the caps; the rest defaults:

| Key | Default | Means |
|---|---|---|
| `runnersDir` / `worktreesDir` / `sessionsDir` / `stateDir` / `watcherLog` | under `~/.sloth/` | Where checkouts, worktrees, session directories, markers and the log live |
| `roles` | `{admin, developers, testers}` | The team: the one login that orders anything, the logins that order within an issue, the logins that answer and ask. A config from before roles keeps its `orderLogin` as the admin |
| `mention` / `botPrefix` | `@sloth` / `**Sloth:**` | The keyword that wakes Sloth; the first line of every comment it writes |
| `maxActive` / `maxAlive` | `3` / `5` | Session caps |
| `budgetMinutes` / `waitHours` | `60` / `2` | A session's time budget; how long a parked session waits for an answer |
| `reviewRounds` / `maxRetries` | `4` / `2` | Reviewer-agent rounds before asking for help; trigger-2 relaunches before parking |
| `boardSeconds` / `commentSeconds` | `300` / `120` | Poll intervals |
| `model` | `opus` | The model every session runs on — except trigger 5's |
| `chrome` | `true` | Start implement sessions with `--chrome`, so a tester subagent can click through the change in your Chrome |
| `helpLogins` | `[]` | GitHub logins `@`-mentioned in the comment that parks a card in *needs help*, so GitHub notifies them (not the login `gh` writes with — GitHub skips self-mentions) |
| `helpWebhook` | `""` | URL POSTed once per card that lands in *needs help* (`{text, content, repo, issue, title, url, column}` — Slack and Discord incoming webhooks read it as is) |
| `approvedModel` | `fable` | The model trigger 5's final reviews run on |
| `tunnel` | `["cloudflared", "tunnel", "--url", "http://localhost:{port}"]` | The command Sloth runs so the UI is reachable from outside (see *Remote access*); the first bare `https://` URL it prints is the address |
| `publicUrl` | — | Where the UI is already reachable — your own tunnel or domain. Set, no tunnel is started |

Environment: `SLOTH_CONFIG`, `SLOTH_PORT` (default `4400`), and `SLOTH_DRY_RUN=1` to log what every
tick *would* do without doing it. A `.env` in the project root works too.

## UI and API

The UI lists sessions (live / needs help / finished) with their transcript, subagents, token spend and
watcher state, plus a home panel with hourly spend, the queue and the log. It refreshes on a 15s poll
and an SSE stream. Transcripts are read from `~/.claude/projects/<runner root, non-alphanumerics as '-'>`.

Read: `GET /api/overview`, `/api/sessions/:id`, `/api/sessions/:id/agents/:agentId`, `/api/usage?days=N`,
`/api/events` (SSE). Write: `POST /api/tick` (`?dry=1`), `/api/pause`, `/api/resume`, `/api/setup/config`,
`/api/setup/clone`. Wizard reads: `GET /api/setup/env`, `/api/setup/projects`, `/api/setup/projects/:id/fields`,
`/api/setup/config`. `GET /api/remote` (the QR's link and the tunnel tool's state), `POST /api/remote/rotate`
(a new link) and `POST /api/remote/install` (brew installs the tool). Everything under `/api/setup/` and
`/api/remote` answers only from the machine Sloth runs on — a phone reads and ticks, it never reconfigures.

## Remote access

The **▦** button in the header shows a QR code; scanning it opens this Sloth on your phone, from
anywhere, and the layout fits a phone. Sloth keeps running on your machine — the QR only reaches it.

Behind the code: Sloth starts a tunnel when the server starts (`tunnel`, by default a Cloudflare quick
tunnel — no account needed; if `cloudflared` is missing the dialog offers to `brew install` it and shows
the QR once the tunnel is up) and guards everything it serves with one secret kept in
`state/remote-token`. Requests from the machine itself pass; the QR's link carries a **single-use code**
(good for a few minutes) that is exchanged once for a cookie — the secret itself never travels in a URL —
and the cookie signs the phone in for 30 days; anything else gets a 401. State-changing requests are
also rejected unless they are same-origin, so a page open on the machine cannot silently drive the API.
The wizard stays on the machine: a phone cannot rewrite the config. Only a page open on the machine can
see the code or mint a new one, and **New link** in the dialog rotates the secret and signs every phone
out. Treat the code like a password: whoever scans it reads every session and can tick and pause.

Sloth decides a request is "local" from its loopback socket, a `localhost` Host header and the absence
of any proxy header (`X-Forwarded-For`, `Forwarded`, …). If you front Sloth with **your own** reverse
proxy or tunnel, leave those forwarding headers in place — a proxy that strips them all and rewrites the
Host to `localhost` would make external requests look local. Note too that `pnpm start` runs Vite's
preview server; for a hardened deployment put Sloth behind a proxy that terminates TLS and forwards the
headers above.

A quick tunnel gets a new address on every start — the QR follows it. For a stable address run your
own tunnel (a named `cloudflared` tunnel on your domain, `jprq`, `ngrok`) and set `publicUrl`, or
put its command in `tunnel` so Sloth starts it — `"tunnel": ["jprq", "http", "{port}"]`, say. Keep the machine awake (`caffeinate -i pnpm start`):
watching stops when the process stops.

## Security

Sloth runs `claude … --dangerously-skip-permissions` in `runnerRoot` with **your** environment — your
`gh` token, your SSH keys, your PATH, your network. A git worktree isolates the *checkout*, not the
*host*. So treat every input that reaches a session as capable of running code as you:

- **Issue, PR and comment text is untrusted.** A card in the pickup column (anyone with board write
  access can put one there) starts an implement session that reads the issue and acts on it; an `@sloth`
  order or comment feeds text straight into the session. Only give board write access to people you
  trust with a shell on this machine.
- **Only the admin and the developers give orders**, and only the team's comments reach a session at
  all — but *any* unassigned pickup card is worked: the card, not the author, is the trigger. Keep the
  pickup column behind the same trust boundary as the repo.
- For a stronger boundary, run Sloth (or at least the sessions) in a VM or container with a **scoped**
  `GITHUB_TOKEN` rather than your personal `gh` login, so a prompt-injected run cannot reach beyond the
  one repo.

The remote-access guard (above) protects the monitor; it does not sandbox the sessions.

## Conventions

Source files stay under 200 lines. Every shell-out is `execFile` / `spawn` with an argv array — no
shell strings. `useEffect` only lives in a dedicated hook that subscribes to something outside React.
`pnpm lint` (tsc) and `pnpm build`. MIT licensed.
