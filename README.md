# Sloth

Sloth watches a project board — GitHub Projects or Trello — and lets Claude Code do the work while you rest. Move a card
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
`claude` and `gh` (a **Log in** button runs `gh auth login` for you, showing the one-time code), lets you pick the board, its columns, the repository and the checkout the sessions
run from, then writes `~/.sloth/config.json`. The gear in the header opens **Settings**, where every value in
that file — the board, the team, the caps, which model each agent runs on — can be changed; the wizard can be
re-run from there. Its **About** section shows the version and commit Sloth runs (`major.minor` from `package.json`,
the patch the number of PRs merged into the branch, so it goes up with every merge by itself), how far behind `origin` it is,
and an **Update** button: `git pull --ff-only`, `pnpm install`, `pnpm build`, then Sloth restarts itself with the
same command line (running sessions are not touched; a `caffeinate` or `pnpm` wrapper exits with the old process).

## How it works

The short version; the tick-by-tick account is in [docs/how-it-works.md](docs/how-it-works.md).

| # | When | What Sloth does |
|---|---|---|
| 1 | An issue sits in the watched column | Moves it to In Progress and starts `/sloth:implement <n>`, most important card first (`priorityField`). A card the session cannot build without guessing is refined first: questions on the issue, the card parked meanwhile, then a `## Spec` in the body it builds to |
| 2 | An issue sits in In Progress with no live session | Relaunches it, at most `maxRetries` times in a row; the comment that then parks the card says how each run ended — its last step and its own final report — so nobody has to open `run.log` to learn why |
| 3 | Someone on the team mentions `@sloth` in a comment — on an issue, or on the PR that closes it, in its conversation or on a line of its diff | Leaves 👀 on the comment, then delivers it to the live session; with no session, an order (admin or developer) starts one and anything else gets a status reply, on the thread it was written in — a review-thread comment is answered in that thread, and an answer written there wakes a parked card like one in the conversation. A login with no role is ignored; a PR linked to no issue gets told so |
| 4 | An issue in Code Review — `Sloth: skip` or not, Sloth's PR or a human's, draft or ready — has an open wired PR whose current head has not been reviewed | **Sloth's first priority**: runs `/sloth:review <pr> final` on the review model (`models.final`, `fable` by default), once per PR head — ahead of every other row that starts a session, and held back by the machine only, never by the session caps. The verdict is posted on the PR either way: a pass labels the issue `Fable: approved` and moves the card to Approved, a fail comments inline and moves it back to In Progress, where row 2 sends the session back to address the findings. An Approved card pushed to after its pass loses the label and comes back to Code Review for a fresh review. Pending checks wait a tick; red ones are row 7's. One owner per card: the review waits until the session that wrote the PR has ended, and a Code Review card whose head already has a verdict on the PR — with nobody on it — is put where that verdict says, so a card left behind by a race unsticks itself |
| 5 | An issue in Approved carries `Fable: approved` for its current head | Comments once on the issue that it is ready for a human to test — with the preview link when the app is up behind one, else the PR to check out |
| 6 | An issue Sloth was working on is **closed** | Moves the card to Done, takes its preview, servers, database and worktree down, and deletes the `sloth/issue-<n>-…` branch of the PR that closed it. A PR closed *without* being merged parks its still-open issue instead |
| 7 | The checks on a PR **Sloth wrote** are red, its card in Code Review or Approved | Sends the session back to the branch to make them pass — once per commit, keeping the PR. A human's PR is left to its author |
| 8 | A PR that passed its review is green and merges cleanly | Merges it with the `autoMerge` method — as soon as that is true, so nobody tests it in Approved first. Off by default: merging stays a human's call until you ask for it |
| 9 | It is `qa.at` o'clock and the QA column holds cards | **The QA sweep**: every card there — a merged fix, deployed to `qa.branch` — gets `/sloth:qa <n>` on `models.qa`, a session of its own that checks the branch out at its current head, boots the app and tests the fix in the browser as the user it concerns. The findings go on the issue with screenshots; a pass moves the card to Done, a fail to In Progress (row 2 then starts an implement run on the findings), an inconclusive test leaves it for a human. Once per card per head, so a passed card is not tested again until the branch moves. A card whose tests keep dying before they reach a verdict (`maxRetries + 1` of them on one head) is **blocked** instead — see *Blocked cards*. Off until a QA column is chosen — then daily at `qa.at`, 20:00 unless changed; **sweep now** on the home panel runs one regardless |
| 10 | A PR **Sloth wrote** conflicts with its base, its card in Code Review | With `resolveConflicts` on: sends the session back to the branch to merge the base in and resolve the conflicts — once per commit, keeping the PR — and holds row 4's review until the resolved head is on the branch, so the PR is reviewed once, on a head that merges. Off by default: a round-trip is a whole session. A human's PR, a `Sloth: skip` card and an Approved card are left alone |
| 11 | It is `smoke.at` o'clock and `smoke.everyDays` days have passed since the last one | **The smoke test**: one `/sloth:smoke <n>` session on `models.smoke` checks `smoke.branch` out at its current head, builds it, boots the app and has a browser tester walk the main flows of every user role, happy paths only — release qualification, not a review. Blockers and majors are filed as issues — each with a screenshot of the failing screen, or it is not filed — and put on the board with no status for a human to triage; the GO / NO-GO report, screenshots included, is a comment on the open issue titled `Smoke test reports`. Nothing on the board moves. One run at a time; a due run held by the slots or the machine starts on the next tick that can. Off until `smoke.everyDays` is set — daily is 1, weekly 7; **test now** on the home panel runs one regardless |

The board is read every 5 minutes, comments every 2 — every 30 seconds while the GitHub webhook is not
delivering them (see *The comment webhook*); **Tick now** runs both at once. **Pause**
stops Sloth from starting anything new (running sessions, inbox deliveries, status replies and
needs-help notifications carry on) and survives a restart.

The header's **runner** chip says whether this machine can do the work at all: `gh` signed in, the runner
checkout's `origin` reachable, a browser for the screenshots when `chrome` is on, and passwordless sudo
where installing the stack needs it. Green when all four are in order, red naming the ones that are not,
with every check's own answer on the hover; clicking it asks again. The checks are read-only and cached —
taken once at start-up, then at most every 10 minutes from the board tick, so a `gh auth status` never
rides the 5-minute poll (`GET /api/health`, `POST /api/health/check`).

- **The `Sloth: skip` label keeps Sloth off a card.** Put it on an issue and Sloth leaves it alone in
  any column — no pickup, no relaunch, no fixing its checks; take it off and the card is Sloth's again.
  Sloth creates the label in the repo when it starts. Every row above but 4 reads "an issue without
  `Sloth: skip`". The one exception is the review in Code Review (trigger 4): a skipped card is reviewed
  too, and a rejection sends it back to In Progress still labelled, so the owner keeps it. Its *pass* goes
  no further — a skipped card is not handed over (trigger 5) and its PR is never auto-merged (trigger 8),
  whatever the verdict said. Assignees mean
  nothing to Sloth — an assigned card is worked like any other — and Sloth never assigns anyone or requests
  a reviewer.
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
  *Code Review* (trigger 4 — every PR there is reviewed by another agent on `models.final`, Fable by default; a GitHub
  approval does not skip it, the verdict lands on the PR pass or fail, and a pass labels the issue `Fable: approved` and
  moves the card on), *Approved* (a human tests it there, from the link trigger 5 posts on the issue; without the column
  a passing card stays in Code Review), *QA* (opt-in — the merged fixes the daily sweep tests, trigger 9; a
  board without a QA step leaves it at *none* and no column is created), and *Done*, where the card
  of a closed issue lands (trigger 6; without the column the card stays where it is — and so does a card that passed QA).
  Missing columns are created after the pickup column — Done at the end of the board — without dropping any existing option.
- **Sessions** are detached `claude -p … --plugin-dir <sloth>/plugin` runs in the runner checkout.
  They survive a Sloth restart. `maxActive` may work at once, `maxAlive` including the ones waiting
  for an answer; a trigger with no free slot is retried next tick — except the review of a Code Review
  card (trigger 4), which starts regardless of the caps and counts against them, so the sessions that build
  queue behind it, never the other way round. A status reply (trigger 3) is a session like any other:
  it counts, and it waits its turn when there is no slot — the `@sloth` comment is simply answered on a
  later tick. The machine sets a cap of its
  own: with less than `minFreeMemory` percent of the memory available, `minIdleCpu` percent of the
  CPU idle or `minIdleDisk` percent of the busiest disk idle, nothing new starts either. The disk part is
  Linux and Windows only: macOS publishes the summed *latency* of every I/O and no busy time, a figure that
  outruns the clock as soon as requests overlap, so the disk hold does not apply there rather than holding
  every launch for as long as anything is writing. When the machine
  *stays* there with sessions running (a minute of readings, two at least), the lowest-priority run is **paused**
  (SIGSTOP to its processes and the servers it started), and resumed once the readings have shown room for a
  minute again, one run per reading either way. The machine is read every `machineSeconds` and not only on a tick: a board
  poll is minutes apart, and a session that boots an app, a build and a browser at once can exhaust the
  memory in seconds. Priority is the card's column — QA highest, Code Review next, In Progress and the
  rest under them — then, within a column, the card's `priorityField` value, and among equals the newest run
  goes first. Its budget clock stands still meanwhile. Not on Windows, which has no SIGSTOP. A session past
  `budgetMinutes + 5` — counted from the moment Sloth started it, not from the step it says it is on,
  which a session rewrites every few minutes; the time it spent parked waiting for an answer does not count,
  and once the answer is in it has 30 minutes at least — is killed, cleaned up, and its card parked; **stop** in a live session's header
  does the same on demand. A review that is stopped or killed this way is not repeated for that PR head —
  nothing would ever review it again, so the issue behind the PR is parked rather than left in Code Review
  with no verdict and nobody on it. **End** on a parked
  session whose process is gone cleans it up and takes it off the needs-help list — the card stays put. A Claude usage
  limit pauses the watcher for 30 minutes without costing the card its place. A live session's row and
  header show what it is taking of the machine right now — CPU, memory and, except on macOS, the disk it
  is reading and writing — summed over its whole process tree, so the app it booted, its database and its
  browser count with it. **Subagents get no figure of their own**: they run inside the session's own
  process, so the OS has nothing to tell them apart by; the session's number already contains them.
- **Warm slots** (`warmSlots`, default on): when a run ends, the stack it booted — the dev servers, Redis
  and the seeded demo database — stays running in its worktree slot instead of being torn down. The next
  session that leases the slot inherits it: a retry of the same issue on the same head reuses everything
  untouched, any other run syncs the schema, reseeds and flushes Redis — seconds instead of the ten-minute
  boot. The stack dies only when its slot leaves the pool, when one of its processes is found dead, or
  with the toggle off (Settings → *Sessions*); a run that hands its app to a preview hands nothing to the
  slot, so a preview's stack never has two owners.
- **Blocked cards** are the one state Sloth will not leave by itself. A QA test that dies before it writes
  a verdict is retried, but `maxRetries + 1` deaths on the same head of the QA branch mean the sweep is
  burning runs on a card it cannot test — so it gives up. Giving up used to be a line in the log and a
  marker that looked exactly like a passed test, which left the card sitting in QA looking untested with
  nothing short of a new head to ever pick it up again. Now the card is *blocked*: Sloth comments on the
  issue saying why (mentioning `helpLogins`), raises the `blocked` webhook event, shows a red **blocked**
  badge on the board card, and lists it on the home panel with the **unblock** button beside it. Unblocking
  forgets the block, the heads already tested and the run's count of verdict-less tests, so the next sweep
  meets the card fresh — **sweep now** makes that next sweep immediate. Moving the card out of the QA
  column (or closing the issue) lifts the block on its own, since the sweep no longer owns it.
- **Previews** (`previewHours`, default 24): an implement session that hands its PR to Code Review leaves
  the app it tested running — its own database, seeded, nothing shared — and Sloth puts a tunnel in front
  of it and posts the link on the PR, with how to sign in; once the PR passes its review the link is posted
  on the issue too, for whoever tests the card in Approved — in a browser, without checking anything out.
  A preview counts as up only once that comment has landed: a `gh` call GitHub refused is tried again on
  the next tick, rather than leaving the PR with no link while the monitor says there is one.
  The environment comes down after `previewHours`, when the PR closes,
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
├── worktrees/<repo>/slot-1/        the pool of worktrees the runs work in — maxActive of them, made once, reused (their node_modules survive)
├── sessions/<repo>/                issue-42/, approved-91/, qa-42/ — pid, state.json, inbox/, run.log, preview.json, verdict …
└── state/                          seen/, approved/, handed/, notified/, finished/, closed/, checks/, merged/,
                                    merge-failed/, qa/ dedupe markers; blocked/ the cards Sloth gave up on;
                                    paused, paused_until, pruned_at, qa_sweep, qa_ran; slots/ which run holds which worktree slot, and slot-<n>.warm for the stack a slot keeps warm
```

## Trello boards

A Trello board works in place of a GitHub Projects one, and a person on it never touches GitHub: the
cards are the issues, the lists are the columns, the card's comments are the conversation. The code, the
PRs and the reviews live in the GitHub repository as always — every card Sloth works has a GitHub issue
behind it, opened and kept in step by Sloth, which the team on Trello need not look at.

- **Connecting.** The wizard's first step (and Settings → *Board*) has a **Trello** block: paste the API
  key, the token and the secret there and press *Connect* — Sloth tries them against Trello and keeps
  them, owner-readable only, in `trello.json` beside `config.json`; nothing typed is ever shown back.
  A key comes from [trello.com/power-ups/admin](https://trello.com/power-ups/admin) (a Power-Up of your
  own, *API key*); the token from the *Token* link beside the key, authorised for the account the board is
  on; the *Secret* on the same page is what makes the webhook possible (below). The environment —
  `SLOTH_TRELLO_KEY` / `SLOTH_TRELLO_TOKEN` / `SLOTH_TRELLO_SECRET`, `.env` included — wins over the file
  field by field, for whoever prefers it. Once connected, the wizard and Settings → *Board* list the Trello
  boards beside the GitHub ones, the columns step shows the board's lists — missing ones are created on
  save, like Status options — and the Trello login is checked with the rest of the machine's health.
- **Cards and issues.** A card in the watched list gets a GitHub issue opened for it — the card's name as
  the title, its description as the body — and the issue's URL attached to the card; a card that already
  carries an issue's URL (attached, or in its description) is that issue's card. A comment that mentions
  Sloth on a card in any list opens its issue too. An issue that reaches the board from GitHub's side (an
  `@sloth` order on an issue nobody made a card for) gets a card. A card outside the watched list with no
  issue and no mention is a note, not work.
- **Comments, both ways.** Every comment on a linked card is copied onto its issue under the author's
  Trello name, and every comment on the issue is copied onto the card — Sloth's own words as they are, a
  person's under their GitHub login. So `@sloth` on the card is an order or a question exactly as on an
  issue (trigger 3), an answer on the card is the answer a parked card waits for (trigger 6, and the
  session's inbox while it waits), and Sloth's questions, park notes, status replies and the "ready to
  test" link all appear on the card. The team in `roles` are **Trello usernames** on a Trello board.
  A comment older than an hour, or older than the first time the mirror ran, is not copied.
- **The webhook.** With the secret set and a public address (see *Remote access*), Sloth
  points a Trello webhook for the board at `/api/hooks/trello` itself and verifies every delivery against
  the secret; a comment on a card is then read within seconds. Without the secret there is no webhook and
  the comments are polled every `fallbackCommentSeconds`, as on GitHub without one.
- **Order and labels.** Cards are picked up top to bottom within the watched list; drag one up to have it
  taken first (`priorityField` does nothing on Trello). `Sloth: skip` on the card — Sloth creates the label
  on the board — or on the issue holds a card back; `Fable: approved` lives on the issue. Card members are
  shown on the board page as the card's assignees. Trigger 6 files a card away by its issue's close.
- **Sessions.** A session reads and moves its card through Sloth (`SLOTH_BOARD_API`, `GET /api/board/card/<issue>`
  and `POST /api/board/move`, from this machine only) instead of `gh project`; the plugin's `board` skill has the
  calls. Everything else a session does is unchanged — it reads and writes the issue, and the mirror carries it.

In `config.json` a Trello board is `project.provider: "trello"` with the board id in `project.id` (and in
`statusField.id`), the list ids as the columns' ids. A config without `provider` is a GitHub board.

## The plugin

`plugin/` is the Claude Code plugin the sessions run: `/sloth:implement <issue>`, `/sloth:review <pr>`,
`/sloth:status <issue> <comment-id>` and `/sloth:qa <issue>`. Nothing needs installing — Sloth passes `--plugin-dir`. To
use it yourself: `claude plugin marketplace add Juratbek/sloth && claude plugin install sloth@sloth`.
The session protocol (environment variables, `state.json`, the inbox) is in [plugin/README.md](plugin/README.md).

## Stack

A session boots the app to verify its change and leaves it up as a preview — which needs the app's database
and runtime on the machine Sloth runs on. Sloth installs them: the wizard's *Stack* step (and Settings →
*Stack*) shows what the checkout needs, what is missing, and installs it; **every start of Sloth installs
whatever is still missing** (`ensureStack`, logged as `stack: …` in `watcher.log`). The stack Sloth can
install is fixed — **PostgreSQL, Redis, Node.js, Python, Java** — with Homebrew on macOS (or Linuxbrew), or
`apt-get` on Debian / Ubuntu / WSL when `sudo -n` works; anywhere else the log names the command to run by
hand. Where apt is there but `sudo -n` is refused — the usual Linux box, Sloth running as an ordinary user —
the page offers **Install with a password…**: the sudo password of that user is typed once, spent on
`/etc/sudoers.d/sloth` (every line any of the five installs could run — `apt-get update`, `apt-get install` of each tool's
packages, `service`/`systemctl start` of its service, `createuser` for the Sloth user — argument for argument, and nothing
else: a session talked into any other `sudo` line is refused; a machine whose sudo is wider than that, the rule an older Sloth
wrote included, is flagged on the Stack page and by the health check, and the password replaces the file)
and forgotten — never stored, never logged, never given to a session. The install itself then runs as an **AI
session**, `/sloth:stack <ids>` on the implement model, whose transcript the page shows while it works; the
boot-time `ensureStack` keeps running its fixed list of commands, since nobody is watching a page there.
PostgreSQL is left running as a service, with the user Sloth runs as able to `createdb`. With
`stack: "auto"` the checkout is read at every start: `package.json` → Node, `pyproject.toml` /
`requirements.txt` → Python, `pom.xml` / Gradle → Java, and a compose file, `.env.example`, manifest or
README that names PostgreSQL / Redis → those (the root and one level under `apps/`, `packages/`, `services/`).
Sessions get the list as `SLOTH_STACK`. `GET /api/stack` (`?root=` for another checkout),
`POST /api/stack/install` (`{ids}`, `{ai: true}` for the session) and `POST /api/stack/unlock`
(`{password, ids}`) are the endpoints, local-only like the rest of setup.

## Configuration

`~/.sloth/config.json` (path overridable with `SLOTH_CONFIG`). The wizard asks about the board, the
columns, who to notify when a card needs help, `repo`, `runnerRoot`, the team (`roles`) and the caps; **Settings** (the
gear in the header) edits every key, by section; whatever is left out defaults:

| Key | Default | Means |
|---|---|---|
| `runnerRoot` | `~/.sloth/runners/<repo>` | The checkout the sessions fetch in and the worktree slots are made from. Sloth clones the repository there itself — at boot, after a config save and from every board tick — when the path is not there yet or is an empty folder; a folder with other files in it is left alone and the health chip says why. The clone is made beside the root and renamed into place when it is whole, so a half-made one is never taken for a checkout. Until the checkout is there no launch goes ahead — not from the board, not from a comment's order; a clone that failed is tried again after ten minutes, or at once when the repository or the root changed |
| `runnersDir` / `worktreesDir` / `sessionsDir` / `stateDir` / `watcherLog` | under `~/.sloth/` | Where checkouts, worktrees, session directories, markers and the log live |
| `roles` | `{admin, developers, testers}` | The team: the one login that orders anything, the logins that order within an issue, the logins that answer and ask — GitHub logins, or Trello usernames on a Trello board. A config from before roles keeps its `orderLogin` as the admin |
| `mention` / `botPrefix` | `@sloth` / `**Sloth:**` | The keyword that wakes Sloth; the first line of every comment it writes |
| `maxActive` / `maxAlive` | `2` / `3` | Session caps — `maxActive` is also the size of the worktree pool |
| `minFreeMemory` / `minIdleCpu` / `minIdleDisk` | `10` / `5` / `10` | No new session while less of the machine's memory is available / of its CPU is idle / of its busiest disk is idle (percent, the last one being 100 minus Task Manager's *Disk*), and the lowest-priority running session is paused while it stays that way; `0` turns a check off. `minIdleDisk` does nothing on macOS, which exposes no busy-time counter to read it from — see *Machine limits* |
| `budgetMinutes` / `waitHours` | `60` / `2` | A session's time budget; how long a parked session waits for an answer |
| `reviewRounds` / `maxRetries` | `4` / `2` | Reviewer-agent rounds before asking for help; trigger-2 relaunches before parking. `maxRetries` also caps the runs of one head that end without a verdict — a QA test (trigger 9) and a review (trigger 4) alike; past it the card goes to a human instead of being tried again |
| `boardSeconds` / `commentSeconds` | `300` / `120` | Poll intervals. `commentSeconds` is the comments poll while the webhook is delivering mentions — the safety net under it |
| `fallbackCommentSeconds` | `30` | The comments poll while the webhook is **not** live: no public address, a tunnel that moved, a `gh` token that may not write webhooks. Then polling is the only way a mention is read at all, so it runs shorter. At least 10 (Settings → *General*, beside the webhook's status) |
| `machineSeconds` | `15` | Seconds between two readings of memory, CPU and disk. The three limits above and the pausing of a running session can only act on a reading Sloth has, and a session that boots an app, a build and a browser at once can exhaust the memory between two board polls |
| `models` | `opus` each, `final: fable`, `orchestrator: fable` | Which model each agent runs on (Settings → *Models*): `implement` (triggers 1–3; with `orchestrator` on, the implementor subagent), `orchestrator` (the implement session when `orchestrator` is on), `tester` (the headless-Chrome subagent that screenshots the change — the QA sweep's browser runs on it too), `reviewer` (the in-session review loop), `final` (trigger 4 — the review every Code Review card gets), `status` (mention replies), `qa` (trigger 9 — the session that tests one QA card), `e2e` (the test-writing subagent while `e2e` is on), `smoke` (trigger 11 — the smoke test session; its per-role testers run on `tester`). An older config's `model` / `approvedModel` still load; its `review` key is ignored. A value is a Claude Code alias, a model id, or a model from another provider (see *Model providers*) |
| `smoke` | `{everyDays: 0, at: "06:00", branch: "", budgetMinutes: 120, brief: ""}` | The scheduled smoke test (trigger 11, Settings → *Smoke test*): `everyDays` is how many days apart it runs (`1` daily, `2` every second day, `7` weekly; `0` turns the schedule off), `at` the local time of day a due run starts, `branch` the branch under test (empty: the default branch), `budgetMinutes` the session's own budget, `brief` what to smoke — the roles and their main flows, one per line; empty, the session reads them off the project's docs and skills |
| `qa` | `{branch: "", at: "20:00", budgetMinutes: 60}` | The daily QA sweep (trigger 9, Settings → *QA sweep*): `at` is the local time of day it starts (`HH:MM`; empty turns it off), `branch` the branch the merged fixes are deployed from and tested on (empty: the default branch), `budgetMinutes` one QA session's own budget. The column it sweeps is the *QA* role in `statusField.columns` — opt-in, chosen in Settings → *Board*; nothing runs without it |
| `orchestrator` | `true` | Run implement sessions as an orchestrator on `models.orchestrator` that never edits code itself: it reads the issue, briefs one implementor subagent on `models.implement`, verifies, runs the tester and the reviewer, opens the PR. Off, one session on `models.implement` does all of it. Either way the tester and the reviewer are subagents (Settings → *Models*) |
| `autostart` | `false` | Start Sloth at login through a macOS launch agent (Settings → *Machine*; see *Run at login*). Saved but ignored on other platforms |
| `autoUpdate` / `updateSeconds` | `true` / `3600` | Install Sloth's own updates without being asked (Settings → *About*; see *Updating itself*). Off only when set to `false`. Every `updateSeconds` the watcher looks at `origin/<branch>` and, when this checkout is behind, runs the same pull-install-build-restart the Update button runs. A checkout with local changes is left alone |
| `chrome` | `true` | Give implement sessions a headless Chrome (Playwright MCP), so a tester subagent clicks through the change and its screenshots go on the PR; needs Google Chrome installed |
| `e2e` | `false` | Have implement sessions spawn the e2e-writer agent once the change works (Settings → *General*): one Playwright test per acceptance criterion of the card, written into the project's own e2e suite, run against the session's app and committed with the PR; the review then holds a PR that counts tests to one per criterion (those the PR lists as not testable end-to-end excepted) and the QA sweep runs the PR's added spec files. Only in a project that already has a Playwright setup |
| `previewHours` | `24` | How long a finished implement session's app stays up behind a public link posted on its PR (see *Previews* above); `0` turns previews off |
| `warmSlots` | `true` | Keep a finished run's stack — dev servers, Redis, demo database — running in its worktree slot for the next session to inherit (see *Warm slots* above). Off tears everything down after every run, as before |
| `project.provider` | `github` | Where the board lives: `github` (a Projects v2 board, `project.id` its node id) or `trello` (a Trello board, `project.id` its id — see *Trello boards*). Chosen with the board in the wizard and Settings → *Board* |
| `priorityField` | `Priority` | A single-select field on the board whose option order ranks the watched column. Missing from the board, or empty here: cards are picked up in board order. On Trello the position in the list is the order |
| `keepDays` | `30` | How long a finished run is kept. Once an hour Sloth deletes the session directories, transcripts (under `~/.claude/projects`) and status-reply markers older than this — never a live, parked or previewing run. Worktrees go sooner: a leftover per-issue one as soon as its run is over (one git has already forgotten is deleted outright), a pool slot past `maxActive` once nobody holds it. The same sweep caps what a run leaves behind whatever its age: every `.turbo/cache` back under 512 MB, oldest entry first, and the server logs of a finished run back to their last 2 MB. `watcher.log` is rotated to `watcher.log.1` past 5 MB |
| `helpLogins` | `[]` | GitHub logins `@`-mentioned in the comment that parks a card in *needs help*, so GitHub notifies them (not the login `gh` writes with — GitHub skips self-mentions) |
| `autoMerge` | `""` | How trigger 8 merges a PR whose review passed, whose checks are green and which merges cleanly: `squash`, `merge` or `rebase` (the `gh pr merge` methods) — as soon as it passes, skipping the human test in Approved. Empty leaves merging to a human |
| `resolveConflicts` | `false` | Trigger 10 (Settings → *General*): when a PR Sloth wrote conflicts with its base and its card is in Code Review, the implement session goes back to the branch, merges the base in and resolves the conflicts, once per head; the review of that head waits for the resolved one. Off leaves conflicts to a human |
| `helpWebhook` | `""` | URL POSTed once per event in `webhookEvents` (`{event, text, content, repo, issue, title, url, column, pr?}` — Slack and Discord incoming webhooks read `text` / `content` as is) |
| `webhookEvents` | `["needsHelp"]` | What `helpWebhook` hears about (Settings → *Notifications*, one toggle each): `needsHelp` (a card is parked), `codeReview` (a PR awaits Sloth's review), `finalPassed` (the review passed and the card is in Approved, with the preview link) / `finalFailed` (the `Fable: approved` label was taken back), `merged` (Sloth filed a closed issue away), `qaPassed` / `qaFailed` (the QA sweep's verdict on a card), `smokePassed` / `smokeFailed` (the smoke test's verdict — GO or GO with risks, against NO-GO or inconclusive — with the report issue's link), `blocked` (Sloth gave up on a card), `stopped` (a run was stopped or parked), `usageLimit` (a Claude limit paused the watcher), `hoursTampered` (the hours ledger or its branch copy no longer checks out, see *Hours*) |
| `tunnel` | `["cloudflared", "tunnel", "--url", "http://localhost:{port}"]` | The command Sloth runs so the UI is reachable from outside (see *Remote access*); the first bare `https://` URL it prints is the address |
| `publicUrl` | — | Where the UI is already reachable — your own tunnel or domain. Set, no tunnel is started |
| `stack` | `"auto"` | What the sessions' app needs on this machine, out of the stack Sloth can install: `postgresql`, `redis`, `node`, `python`, `java` (see *Stack* below). `auto` reads the checkout at every start; a list pins it |

**One instance, one home.** Everything an instance owns — state, sessions, worktrees, runners, its log, its
Trello credentials — defaults to the directory its config file is in: `~/.sloth` for the default config,
and whatever directory `SLOTH_CONFIG` names for another. So a second Sloth on the same machine (another
project, another client) is `SLOTH_CONFIG=~/.sloth-other/config.json SLOTH_PORT=4401 pnpm dev`, and the
two never see each other's sessions or answer on each other's cards. Each instance writes `state/owner.json`
when it starts watching and refuses to run on a state directory another live instance holds under a
different config — the header's health chip says so (*state dir*) until it is given directories of its own.

Environment: `SLOTH_CONFIG`, `SLOTH_PORT` (default `4400`), `SLOTH_DRY_RUN=1` to log what every
tick *would* do without doing it, and `SLOTH_TRELLO_KEY` / `SLOTH_TRELLO_TOKEN` / `SLOTH_TRELLO_SECRET` for a Trello board. A `.env` in the project root works too.

## Model providers

Every agent runs on Claude Code, which speaks the Anthropic API — so Anthropic's models need nothing
configured beyond the login the machine already has. A model from someone else is reached by pointing
that same client at an Anthropic-compatible endpoint, and Sloth does it per session: only the agents you
put on that provider's models go there, the rest keep running exactly as before.

A provider is offered in Settings → *Models* once its key is in the environment Sloth itself was started
with. Without the key its models are still listed, greyed out and naming the variable to set.

| Provider | Key | Models |
| --- | --- | --- |
| Anthropic | — (the machine's Claude Code login) | `fable`, `opus`, `sonnet`, `haiku` |
| [Z.ai](https://docs.z.ai/devpack/tool/claude) | `SLOTH_ZAI_TOKEN` | `glm-5.3`, `glm-5.3-flash` |

A session started on a provider's model gets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for it, the
alias defaults a subagent may ask for (`opus`, `sonnet`, `haiku`) mapped onto models that provider serves,
and no `ANTHROPIC_API_KEY` — an Anthropic key is never forwarded to somebody else's endpoint. The cost the
UI shows follows the provider's own list prices, cached prompts included. The whole table lives in
`server/models.ts`: another provider is another row, and a model id that is not on it is still passed to
`--model` untouched.

## UI and API

The UI lists sessions (live / needs help / finished) with their transcript, subagents, token spend, what
the run cost at list price — on the row in the list as well as in the session header — the machine load of a live run (see *Sessions*) and watcher state, plus a home panel with hourly spend, **hours** (below), **cost by issue** — every
issue Sloth touched, its runs rolled up into one line, dearest first — the queue and the log. It refreshes on a 15s poll
and an SSE stream. Transcripts are read from `~/.claude/projects/<runner root, non-alphanumerics as '-'>`.

The header's **Board** button opens the board on a page of its own — the whole window, since half a screen
was not enough to see a pipeline in. It shows Sloth's columns in pipeline order — pickup, In Progress,
needs help, Code Review, Approved, Done — whatever order the GitHub board puts them in, each column
full-height and scrolling on its own, with a card per issue **Sloth is on**: the ones it has a run on, and the
unclaimed ones waiting in pickup. A card someone else moved by hand — no run, or claimed in pickup — is not
listed, only counted in a `not Sloth's · 3` chip. Beside the counts, **today** and **7 days** say what every run has cost at list price, so spend is in view without going back to the chart. A card is two lines: the number and title, a
state dot with what Sloth's newest run on that issue is doing, and then only what applies — what the issue
has cost, its PR, a live preview link, retries, the human who owns it, a `Fable: approved` badge, how long a
parked card has been waiting. Under those, when there is one, the **hold**: one line saying why nothing is
happening on that card — a pause, a usage limit, the machine, no free slot, the `Sloth: skip` label, a
give-up, the relaunches it has used up, a review waiting for the session that wrote the PR. Reasons that
used to be in `watcher.log` only; a card a session is live on has none. Clicking a card goes back to the
monitor with that run open. It is a
**mirror**: the view is built from the board the last tick already read (no extra GitHub call, and
`as of 14:02` says how fresh it is), Done shows the last 7 days, every other Status column is one
`elsewhere · 14` chip, and nothing on it writes back — no dragging, no buttons. On a phone the columns take
turns behind a switcher, the active one filling the page; **← Back** returns to the monitor.

The page you are on is in the URL, so a refresh lands where you were and a view can be linked to:
`/` the home panel, `/sessions/<id>` one session, `/board` the board, `/settings` and `/setup` the settings
page and the wizard (both only from the machine Sloth runs on — on a phone they fall back to `/`). Anything
else is the home panel. Back and forward work. A remote link keeps its path through the sign-in redirect
(`server/remote.ts` drops only the `code`), so `https://…/board?code=…` opens a phone straight on the board;
the QR itself always points at `/`.

Read: `GET /api/overview`, `/api/sessions/:id`, `/api/sessions/:id/agents/:agentId`, `/api/usage?days=N`,
`/api/hours?month=YYYY-MM` (the hours ledger, one month), `/api/events` (SSE). Write: `POST /api/tick` (`?dry=1`), `/api/pause`, `/api/resume`, `/api/qa/run` (opens a QA sweep now and ticks), `/api/smoke/run` (asks for a smoke test now and ticks; dropped while one is running), `/api/sessions/:id/stop` (ends the run, parks an issue's card), `/api/previews/:issue/stop` (takes a preview down now), `/api/setup/config`,
`/api/setup/clone` (the Settings button — the same clone Sloth makes on its own), `/api/setup/gh-login` (runs `gh auth login --web` on the machine; `GET` reads the one-time code while it
waits, `POST …/cancel` stops it). Wizard reads: `GET /api/setup/env`, `/api/setup/projects`, `/api/setup/projects/:id/fields`,
`/api/setup/config`. `GET /api/remote` (the QR's link and the tunnel tool's state), `POST /api/remote/rotate`
(a new link) and `POST /api/remote/install` (brew installs the tool). `GET /api/update` (version, commit, commits
behind), `POST /api/update/check` (fetches), `POST /api/update/run` (pull, install, build, restart). Everything under
`/api/setup/`, `/api/remote` and `/api/update` answers only from the machine Sloth runs on — a phone reads and
ticks, it never reconfigures or updates.

`GET /api/webhook` (the comment webhook's state and which poll it puts in force) and `POST /api/webhook/retry`
(configure it again now) sit behind the same guard as the rest. `POST /api/hooks/github` is the one route that does
not: it is GitHub's delivery address, and it is authenticated by the signature over its body instead — see below.

## Hours

Sloth books every run it ends in `~/.sloth/state/hours.jsonl`, so a project can be billed by the hours
it worked: one line per run with its launch, end, the seconds it stood paused for the machine and the seconds
it sat in *Sloth needs help* waiting for an answer (neither is billed), how it ended and whether that is
billable. A run is billable when it did its job — reached `done`, stopped to ask a human, asked and ran out
of response, or posted its verdict; one that died, hung past its budget, hit a usage limit, was stopped from
the monitor or lost the machine to a reboot is booked with that reason: **continued** (shown apart, half
rate) when a later run took the card up, not billed when none did. Parallel runs each count.
The home panel's **hours** section shows a month at a time (UTC) with a row per card and the failed runs
under it; `GET /api/hours?month=YYYY-MM` is the same as JSON. Hours only, never a rate.

The ledger is written by the server alone and is not in any session's environment. Each line fingerprints
itself and the line before it (`server/runner/hours.ts`), and the file is committed after each run to the
repository's `sloth-assets` branch as `hours/ledger.jsonl` (`server/runner/hours-copy.ts`). The tick
compares the two; a broken chain or a copy that differs shows as **ledger tampered** on the panel and is
raised once through `helpWebhook` as `hoursTampered`. The branch is the witness: a file that is broken or
differs from what the branch holds is never pushed over it, and the branch's history shows every change.

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

A tunnel that drops is started again, with a backoff that doubles to a minute and resets the moment an
address is printed — however many times in a row it drops, and without needing Sloth restarted.

While an address is known — a tunnel that printed one, or `publicUrl` — every session Sloth starts on an
issue (implement, QA, the final review) leaves one comment on that issue with the link to its page on the
monitor, so the run can be followed from GitHub. The link is bare: a browser signed in through the QR
opens it, anyone else gets the 401. Without an address nothing is written.

A quick tunnel gets a new address on every start — the QR follows it. For a stable address run your
own tunnel (a named `cloudflared` tunnel on your domain, `jprq`, `ngrok`) and set `publicUrl`, or
put its command in `tunnel` so Sloth starts it — `"tunnel": ["jprq", "http", "{port}"]`, say. Previews always run the
`tunnel` command, one child per preview, whatever `publicUrl` says — that only names the UI.

### The comment webhook

Nobody sets this up. While Sloth has a public address — the tunnel above, or `publicUrl` — it points the
**repository's webhook** at its own `/api/hooks/github` and keeps it pointed there: it looks for a hook
whose URL ends in that path, whatever host it names, and creates or repoints it. A quick tunnel gets a
new host on every start, which is exactly the case a webhook configured by hand quietly stops delivering
on. The shared secret is 32 random bytes in `state/webhook-secret`, minted once and never in an argv;
the hook asks for `issue_comment` and nothing else.

A delivery is taken only when `X-Hub-Signature-256` matches an HMAC over the exact bytes that arrived —
anything else is a 401, and the route decides nothing beyond "someone wrote a mention": it answers GitHub
at once and starts a comments tick, and [trigger 3](#how-it-works) does the de-duplication, the roles and
the pause exactly as it does on the poll. GitHub's `ping` is answered too, so the hook goes green on its side.

**Polling never stops.** A webhook is a promise from someone else's machine — a delivery is dropped, the
tunnel is down when a comment is written, a human deletes the hook — so the comments tick stays on
`commentSeconds` (120s) underneath it. When the hook is *not* live, the tick drops to
`fallbackCommentSeconds` (30s): the two intervals are Settings → *General*, next to the hook's status.
"Live" means configured **and** pointing at the address Sloth is reachable at right now, so a tunnel that
came back on a new host counts as down until it has been repointed.

Settings → *General* → **GitHub webhook** shows *Active* with the address, or *Off* / *Failed* with the
reason — no public address, the tunnel is down, the address changed, or whatever `gh` said — the last
delivery, and **Retry webhook setup**, which configures it again then and there. The token needs the
`repo` scope (fine-grained: *Webhooks: write*); without it GitHub answers `HTTP 404` on the hooks
endpoint, which the page reports as the missing scope it is. Sloth never deletes the hook: a tunnel that
stops leaves it in place, inactive on Sloth's side, and the next address repoints it.

### Run at login

Watching stops when the process stops, so Sloth has to be running for anything to happen. **Settings →
Machine → Start at login** (`autostart`) registers a macOS launch agent —
`~/Library/LaunchAgents/dev.sloth.<repo>.plist`, `caffeinate -i pnpm start` in this checkout — that
launchd starts at login, restarts if it dies, and that keeps the Mac awake while it runs. It serves the
built UI, so run `pnpm build` first (the **Update** button does). Turning it off unloads and deletes the
agent. It takes effect at the next login; to start it now without logging out:
`launchctl kickstart -k gui/$UID/dev.sloth.<repo>`. Only macOS is supported — elsewhere, run
`caffeinate -i pnpm start` yourself.

### Updating itself

**Settings → About → Update** pulls, installs, builds and restarts this checkout on demand. **Update
automatically** (`autoUpdate`, on by default) does the same on a timer — every `updateSeconds`, an hour by
default — so a Sloth left running for weeks does not fall behind the repository it was cloned from. Turn
it off in the same section, or with `"autoUpdate": false` in the config file, to update by hand only.

What it will not do: update a checkout with local changes (`git pull --ff-only` would refuse, and the
reason is logged once rather than once an hour), or restart in the middle of a tick. The update is
queued on the watcher's own chain, so it waits for the tick in flight and holds the next one until the
process is back — a card half-moved through a restart is a card in two places. Running sessions are
detached and are not touched; they notice nothing but a blink in the monitor.

The restart itself depends on who owns the process. With **Start at login** on, launchd's `KeepAlive`
brings Sloth back by itself, so the old process only exits; without it, it starts its replacement
before going. Either way exactly one Sloth ends up on the board — and `strictPort` means a second
instance would fail to bind rather than quietly watch the same board on the next port.

## Security

Sloth runs `claude … --dangerously-skip-permissions` in `runnerRoot` with **your** environment — your
`gh` token, your SSH keys, your PATH, your network. A git worktree isolates the *checkout*, not the
*host*. So treat every input that reaches a session as capable of running code as you:

- **Issue, PR and comment text is untrusted.** A card in the pickup column (anyone with board write
  access can put one there) starts an implement session that reads the issue and acts on it; an `@sloth`
  order or comment feeds text straight into the session. Only give board write access to people you
  trust with a shell on this machine.
- **Only the admin and the developers give orders**, and only the team's comments reach a session at
  all — but *any* pickup card without `Sloth: skip` is worked: the card, not the author, is the trigger. Keep the
  pickup column behind the same trust boundary as the repo.
- For a stronger boundary, run Sloth (or at least the sessions) in a VM or container with a **scoped**
  `GITHUB_TOKEN` rather than your personal `gh` login, so a prompt-injected run cannot reach beyond the
  one repo.

The webhook's delivery route (`POST /api/hooks/github`) is the one path the remote-access guard does not
cover — GitHub arrives with no cookie. It is authenticated by an HMAC over the raw body against a secret
only GitHub and this machine hold, compared in constant time, and it does nothing with what it is sent
beyond starting the same comments tick the poll starts: an unsigned or wrongly signed delivery is a 401,
and a signed one still cannot name an issue, an author or a command. Rotating it is deleting
`state/webhook-secret` and pressing **Retry webhook setup**.

The remote-access guard (above) protects the monitor; it does not sandbox the sessions. A **preview link**
is guarded by its key, not by who you are: whoever holds the link uses the app with the sign-in notes in
the PR comment, and the cookie it leaves keeps that browser in for as long as the preview lives. It reaches
only that run's throwaway database — never share it beyond the PR's readers, and keep real credentials out
of the project's run skill. A preview whose key somehow got out comes down with **stop** next to the link
in the session's header; the next one gets a fresh key.

## Conventions

Source files stay under 300 lines (`test/line-limit.test.ts` enforces it). Every shell-out is `execFile` / `spawn` with an argv array — no
shell strings. `useEffect` only lives in a dedicated hook that subscribes to something outside React.
`pnpm lint` (tsc), `pnpm test` (vitest — `test/`, every `gh` call mocked, a throwaway `$HOME`, never the real
board) and `pnpm build` — run all three before a PR. MIT licensed.
