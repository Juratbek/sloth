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
run from, then writes `~/.sloth/config.json`. The gear in the header opens **Settings**, where every value in
that file — the board, the team, the caps, which model each agent runs on — can be changed; the wizard can be
re-run from there. Its **About** section shows the version and commit Sloth runs, how far behind `origin` it is,
and an **Update** button: `git pull --ff-only`, `pnpm install`, `pnpm build`, then Sloth restarts itself with the
same command line (running sessions are not touched; a `caffeinate` or `pnpm` wrapper exits with the old process).

## How it works

The short version; the tick-by-tick account is in [docs/how-it-works.md](docs/how-it-works.md).

| # | When | What Sloth does |
|---|---|---|
| 1 | An unassigned issue sits in the watched column | Moves it to In Progress and starts `/sloth:implement <n>`, most important card first (`priorityField`) |
| 2 | An unassigned issue sits in In Progress with no live session | Relaunches it, at most `maxRetries` times in a row |
| 3 | Someone on the team mentions `@sloth` in a comment — on an issue, or on the PR that closes it | Delivers it to the live session; with no session, an order (admin or developer) starts one and anything else gets a status reply, on the thread it was written in. A login with no role is ignored; a PR linked to no issue gets told so |
| 4 | An unassigned issue in Code Review has an open, non-draft, unapproved wired PR **written by a human** | Runs `/sloth:review <pr>`, once per PR head. Sloth's own PRs were already vetted by their session's reviewer loop |
| 5 | An issue in Approved — assigned or not — has an open, non-draft wired PR and no `Fable: approved` label for its current head | Runs `/sloth:review <pr> final` on the final-review model (`models.final`, `fable` by default), once per PR head; the verdict is posted on the PR either way, and a pass labels the issue `Fable: approved`, which keeps that head from being reviewed again. Pending checks wait a tick; red ones are row 7's |
| 6 | An issue Sloth was working on is **closed** | Moves the card to Done, takes its preview, servers, database and worktree down, and deletes the `sloth/issue-<n>-…` branch of the PR that closed it. A PR closed *without* being merged parks its still-open issue instead |
| 7 | The checks on a PR **Sloth wrote** are red, its card unassigned in Code Review or Approved | Sends the session back to the branch to make them pass — once per commit, keeping the PR. A human's PR is left to its author |
| 8 | A PR that passed its final review is green and merges cleanly | Merges it with the `autoMerge` method. Off by default: merging stays a human's call until you ask for it |

The board is read every 5 minutes, comments every 2; **Tick now** runs both at once. **Pause**
stops Sloth from starting anything new (running sessions, inbox deliveries, status replies and
needs-help notifications carry on) and survives a restart.

- An **assignee on a card means a human owns it** — Sloth never works on it. The one exception is the
  final review in Approved (trigger 5): an assigned card is reviewed too, and a rejection sends it back
  to In Progress still assigned, so the owner keeps it. Sloth never assigns anyone and
  never requests a reviewer.
- **Priority**: the watched column is worked in the order of the board's `Priority` field — its options top
  to bottom, first option first — and cards with no priority set come after the ranked ones, in board order.
  Point `priorityField` at another single-select field, or empty it to take cards in plain board order.
- **Roles** (`roles` in the config, the wizard's *Team* step): one **admin** orders Sloth anything —
  work, a move to any column, closing an issue. **Developers** order work within an issue — how to do
  it, address the review comments, start over, stop; an order that reaches beyond the issue becomes a
  question for the admin. **Testers** answer a parked card's questions and ask for status, but never
  order. A comment ending in `?` is always a status question. Sloth ignores logins with no role: no
  reply, and their comments do not count as answers. Every comment Sloth writes starts with `**Sloth:**`.
- **Columns** are roles mapped to the board's Status options: *pickup* (Sloth only reads it),
  *In Progress*, *needs help* (a stuck session parks the card here after asking its questions; an
  answer in the thread brings it back — `helpLogins` are mentioned in that question and `helpWebhook`
  hears about it, along with anything else in `webhookEvents`, see *Configuration*),
  *Code Review* (trigger 4) and *Approved* (trigger 5 — a final review on `models.final`, Fable by default; a GitHub approval does not skip it,
  the verdict lands on the PR pass or fail, and a pass labels the issue `Fable: approved`), and *Done*, where the card
  of a closed issue lands (trigger 6; without the column the card stays where it is).
  Missing columns are created after the pickup column — Done at the end of the board — without dropping any existing option.
- **Sessions** are detached `claude -p … --plugin-dir <sloth>/plugin` runs in the runner checkout.
  They survive a Sloth restart. `maxActive` may work at once, `maxAlive` including the ones waiting
  for an answer; a trigger with no free slot is retried next tick. A session past
  `budgetMinutes + 5` is killed, cleaned up, and its card parked; **stop** in a live session's header
  does the same on demand (a stopped review is not repeated for that PR head), and **end** on a parked
  session whose process is gone cleans it up and takes it off the needs-help list — the card stays put. A Claude usage
  limit pauses the watcher for 30 minutes without costing the card its place.
- **Previews** (`previewHours`, default 24): an implement session that hands its PR to Code Review leaves
  the app it tested running — its own database, seeded, nothing shared — and Sloth puts a tunnel in front
  of it and posts the link on the PR, with how to sign in. The reviewer tries the change in a browser
  without checking anything out. The environment comes down after `previewHours`, when the PR closes,
  when its servers die, when a new session starts on the issue, or with **stop** next to the link in the
  session's header; a Sloth restart re-opens the tunnel and rewrites the comment with the new address.
  The project's run skill decides whether a run can be previewed: the whole app has to answer on one
  local port (see [plugin/README.md](plugin/README.md)). The tunnel points at a small local **guard**, not
  at the app: only a request carrying the preview's key (24 random bytes, in the posted link as
  `?sloth_key=…`) is forwarded. Opening the link trades the key for an `HttpOnly` cookie and redirects to
  the clean URL — so the key leaves the address bar and the app's logs — and anything else gets a 401 page.
  Websockets (HMR, live reload) are proxied too. The key lives in the preview's state file, so a Sloth
  restart keeps the link that was posted working.

```
~/.sloth/
├── config.json                     the whole configuration
├── watcher.log                     one line per event — the log the UI tails (rotated to .1 past 5 MB)
├── runners/<repo>/                 the checkout the sessions run from
├── worktrees/<repo>/issue-42/      one worktree per issue
├── sessions/<repo>/                issue-42/, review-91/, approved-91/ — pid, state.json, inbox/, run.log, preview.json …
└── state/                          seen/, reviewed/, approved/, notified/, finished/, closed/, checks/, merged/,
                                    merge-failed/ dedupe markers; paused, paused_until, pruned_at
```

## The plugin

`plugin/` is the Claude Code plugin the sessions run: `/sloth:implement <issue>`, `/sloth:review <pr>`
and `/sloth:status <issue> <comment-id>`. Nothing needs installing — Sloth passes `--plugin-dir`. To
use it yourself: `claude plugin marketplace add Juratbek/sloth && claude plugin install sloth@sloth`.
The session protocol (environment variables, `state.json`, the inbox) is in [plugin/README.md](plugin/README.md).

## Configuration

`~/.sloth/config.json` (path overridable with `SLOTH_CONFIG`). The wizard asks about the board, the
columns, who to notify when a card needs help, `repo`, `runnerRoot`, the team (`roles`) and the caps; **Settings** (the
gear in the header) edits every key, by section; whatever is left out defaults:

| Key | Default | Means |
|---|---|---|
| `runnersDir` / `worktreesDir` / `sessionsDir` / `stateDir` / `watcherLog` | under `~/.sloth/` | Where checkouts, worktrees, session directories, markers and the log live |
| `roles` | `{admin, developers, testers}` | The team: the one login that orders anything, the logins that order within an issue, the logins that answer and ask. A config from before roles keeps its `orderLogin` as the admin |
| `mention` / `botPrefix` | `@sloth` / `**Sloth:**` | The keyword that wakes Sloth; the first line of every comment it writes |
| `maxActive` / `maxAlive` | `3` / `5` | Session caps |
| `budgetMinutes` / `waitHours` | `60` / `2` | A session's time budget; how long a parked session waits for an answer |
| `reviewRounds` / `maxRetries` | `4` / `2` | Reviewer-agent rounds before asking for help; trigger-2 relaunches before parking |
| `boardSeconds` / `commentSeconds` | `300` / `120` | Poll intervals |
| `models` | `opus` each, `final: fable` | Which model each agent runs on (Settings → *Models*): `implement` (triggers 1–3), `tester` (the Chrome subagent), `reviewer` (the in-session review loop), `review` (trigger 4), `final` (trigger 5), `status` (mention replies). An older config's `model` / `approvedModel` still load |
| `autostart` | `false` | Start Sloth at login through a macOS launch agent (Settings → *Machine*; see *Run at login*). Saved but ignored on other platforms |
| `chrome` | `true` | Start implement sessions with `--chrome`, so a tester subagent can click through the change in your Chrome |
| `previewHours` | `24` | How long a finished implement session's app stays up behind a public link posted on its PR (see *Previews* above); `0` turns previews off |
| `priorityField` | `Priority` | A single-select field on the board whose option order ranks the watched column. Missing from the board, or empty here: cards are picked up in board order |
| `keepDays` | `30` | How long a finished run is kept. Once an hour Sloth deletes the session directories, worktrees and status-reply markers older than this — never a live, parked or previewing run, and never a transcript (those are Claude Code's, under `~/.claude`). `watcher.log` is rotated to `watcher.log.1` past 5 MB |
| `helpLogins` | `[]` | GitHub logins `@`-mentioned in the comment that parks a card in *needs help*, so GitHub notifies them (not the login `gh` writes with — GitHub skips self-mentions) |
| `autoMerge` | `""` | How trigger 8 merges a PR whose final review passed, whose checks are green and which merges cleanly: `squash`, `merge` or `rebase` (the `gh pr merge` methods). Empty leaves merging to a human |
| `helpWebhook` | `""` | URL POSTed once per event in `webhookEvents` (`{event, text, content, repo, issue, title, url, column, pr?}` — Slack and Discord incoming webhooks read `text` / `content` as is) |
| `webhookEvents` | `["needsHelp"]` | What `helpWebhook` hears about (Settings → *Notifications*, one toggle each): `needsHelp` (a card is parked), `codeReview` (a PR is ready for a human), `finalPassed` / `finalFailed` (the final review's verdict — the `Fable: approved` label appearing or going), `merged` (Sloth filed a closed issue away), `stopped` (a run was stopped or parked), `usageLimit` (a Claude limit paused the watcher) |
| `tunnel` | `["cloudflared", "tunnel", "--url", "http://localhost:{port}"]` | The command Sloth runs so the UI is reachable from outside (see *Remote access*); the first bare `https://` URL it prints is the address |
| `publicUrl` | — | Where the UI is already reachable — your own tunnel or domain. Set, no tunnel is started |

Environment: `SLOTH_CONFIG`, `SLOTH_PORT` (default `4400`), and `SLOTH_DRY_RUN=1` to log what every
tick *would* do without doing it. A `.env` in the project root works too.

## UI and API

The UI lists sessions (live / needs help / finished) with their transcript, subagents, token spend, what
the run cost at list price and watcher state, plus a home panel with hourly spend, **cost by issue** — every
issue Sloth touched, its runs rolled up into one line, dearest first — the queue and the log. It refreshes on a 15s poll
and an SSE stream. Transcripts are read from `~/.claude/projects/<runner root, non-alphanumerics as '-'>`.

At the top of the home panel is the **board**: Sloth's columns in pipeline order — pickup, In Progress,
needs help, Code Review, Approved, Done — whatever order the GitHub board puts them in, with a card per
issue. A card is two lines: the number and title, a state dot with what Sloth's newest run on that issue
is doing, and then only what applies — what the issue has cost, its PR, a live preview link, retries, the
human who owns it, a `Fable: approved` badge, how long a parked card has been waiting. Clicking a card
opens that run. It is a **mirror**: the view is built from the board the last tick already read (no extra
GitHub call, and `board as of 14:02` says how fresh it is), Done shows the last 7 days, every other Status
column is one `elsewhere · 14` chip, and nothing on it writes back — no dragging, no buttons. On a phone
the columns take turns behind a switcher; the header's small button hides the whole block and remembers that.

Read: `GET /api/overview`, `/api/sessions/:id`, `/api/sessions/:id/agents/:agentId`, `/api/usage?days=N`,
`/api/events` (SSE). Write: `POST /api/tick` (`?dry=1`), `/api/pause`, `/api/resume`, `/api/sessions/:id/stop` (ends the run, parks an issue's card), `/api/previews/:issue/stop` (takes a preview down now), `/api/setup/config`,
`/api/setup/clone`. Wizard reads: `GET /api/setup/env`, `/api/setup/projects`, `/api/setup/projects/:id/fields`,
`/api/setup/config`. `GET /api/remote` (the QR's link and the tunnel tool's state), `POST /api/remote/rotate`
(a new link) and `POST /api/remote/install` (brew installs the tool). `GET /api/update` (version, commit, commits
behind), `POST /api/update/check` (fetches), `POST /api/update/run` (pull, install, build, restart). Everything under
`/api/setup/`, `/api/remote` and `/api/update` answers only from the machine Sloth runs on — a phone reads and
ticks, it never reconfigures or updates.

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
put its command in `tunnel` so Sloth starts it — `"tunnel": ["jprq", "http", "{port}"]`, say. Previews always run the
`tunnel` command, one child per preview, whatever `publicUrl` says — that only names the UI.

### Run at login

Watching stops when the process stops, so Sloth has to be running for anything to happen. **Settings →
Machine → Start at login** (`autostart`) registers a macOS launch agent —
`~/Library/LaunchAgents/dev.sloth.<repo>.plist`, `caffeinate -i pnpm start` in this checkout — that
launchd starts at login, restarts if it dies, and that keeps the Mac awake while it runs. It serves the
built UI, so run `pnpm build` first (the **Update** button does). Turning it off unloads and deletes the
agent. It takes effect at the next login; to start it now without logging out:
`launchctl kickstart -k gui/$UID/dev.sloth.<repo>`. Only macOS is supported — elsewhere, run
`caffeinate -i pnpm start` yourself.

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

The remote-access guard (above) protects the monitor; it does not sandbox the sessions. A **preview link**
is guarded by its key, not by who you are: whoever holds the link uses the app with the sign-in notes in
the PR comment, and the cookie it leaves keeps that browser in for as long as the preview lives. It reaches
only that run's throwaway database — never share it beyond the PR's readers, and keep real credentials out
of the project's run skill. A preview whose key somehow got out comes down with **stop** next to the link
in the session's header; the next one gets a fresh key.

## Conventions

Source files stay under 200 lines. Every shell-out is `execFile` / `spawn` with an argv array — no
shell strings. `useEffect` only lives in a dedicated hook that subscribes to something outside React.
`pnpm lint` (tsc), `pnpm test` (vitest — `test/`, every `gh` call mocked, a throwaway `$HOME`, never the real
board) and `pnpm build`; CI runs all three on every PR. MIT licensed.
