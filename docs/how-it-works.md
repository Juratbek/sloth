# How Sloth works

Sloth is a program that runs on your machine. Every 5 minutes it looks at your GitHub project
board. When it finds work, it starts a Claude Code session to do it. That is all it does.

## The life of a card

1. **You move an issue into the pickup column.**
2. **Sloth picks it up.** It moves the card to *In Progress* and starts a session:
   `claude -p "/sloth:implement 42"`. The session gets its own git worktree, so it never touches
   your checkout.
3. **The session does the work.** It reads the issue and its comments. Some cards cannot be built without
   guessing: a feature named in a line, a screen with no design, two readings that would lead to different
   code. Such a card is **refined first**. The session answers what the code and your docs settle, and asks
   the rest on the issue: only questions whose answer changes the code, five at most, two rounds at most.
   The card is parked in *Sloth needs help* meanwhile, and the wait is the same as for any question
   (`waitHours`). With the answers in, it writes a `## Spec` into the issue body — goal, scope, out of scope,
   acceptance criteria, edge cases — and builds to it; the tester and the reviewer hold the work to that
   spec. A comment `@sloth refine` on the issue — a statement, not a question, from the admin or a developer
   — asks for the questions even on a card that reads clear. Then the session follows your
   project's `CLAUDE.md` and rules, writes the fix, and runs your tests. Then it starts the app and a **tester
   agent** opens it in a headless Chrome of its own — its own empty profile, nobody else's browser —
   clicks through the change like a user would, and **screenshots every screen it checks**; what it finds
   gets fixed. Then it opens a draft PR that says `Closes #42`. The PR carries those screenshots: they are
   pushed to a `sloth-assets` branch of the repository, which holds images only and is never merged, so
   nothing lands in your code — and the PR body embeds them under `## Screenshots`, proof of the work next
   to the description. This needs Google Chrome installed on the machine Sloth runs on; without one the
   session says so in the PR instead. With **Write e2e tests** on (Settings → General, off by default) an
   e2e-writer agent then turns every acceptance criterion of the card into a Playwright test in your own e2e
   suite, runs them against the session's app, and the tests land in the same PR as the code; a red test is
   a bug the session fixes first, and a criterion the change was never meant to meet becomes a question on
   the issue, never a deleted test. Before handing it over, it asks a reviewer agent to check the PR and fixes what
   the reviewer finds (up to 4 rounds) — a PR that changes a screen and shows none is sent back. With the **orchestrator** on (the default, Settings → Models), the session
   itself never writes code: it runs on the orchestrator model (Fable by default), hands every change to
   an implementor agent on the implement model, and keeps the judging — verification, tester, reviewer, PR.
4. **The card moves to *Code Review*.** The PR is marked ready. The app the session tested stays running,
   and Sloth posts a **preview link** on the PR with how to sign in: whoever opens it sees the change in a
   browser — its own seeded database, nothing shared — without checking anything out. The link lives 24
   hours (`previewHours`), or until the PR closes.
5. **Another agent reviews the PR.** Every card in *Code Review* — Sloth's PR, or one you wrote and wired to
   the issue, a draft or marked ready — gets a fresh review from a second agent, on the review model (Fable,
   unless Settings → Models says otherwise): `/sloth:review <pr> final`, once per version of the PR. This is
   Sloth's first priority: the review starts before anything else in a tick and is never held back by the
   session caps, only by a loaded machine, so finished work never waits on work that is still being built.
   One tick starts at most as many reviews as there are session slots (3) — the machine is read once a
   tick, so a backlog in *Code Review* is spread over ticks rather than started all at once; the rest keep
   their turn and go on the next tick. It reads the issue and its thread,
   the whole diff, the checks and the screenshots, and always leaves its verdict as a comment on the PR.
   Problems: it comments inline on each one and moves the card back to *In Progress*, and the session that
   wrote the PR is started again on the same branch to address them — a round-trip, the PR keeps its number.
   Clean: the issue gets the label `Fable: approved` and the card moves to *Approved*. No human reads code
   here unless they want to. With several PRs open at once the older ones stop merging as the newer ones
   land; turn on *Resolve merge conflicts* in Settings → General (`resolveConflicts`, off by default) and a
   PR of Sloth's that conflicts with its base while its card sits in *Code Review* gets the same round-trip:
   the session merges the base into the branch, resolves the conflicts, pushes, and the review waits for
   that head instead of reading one that cannot merge. Once per version of the PR, only Sloth's own PRs.
6. **A human tests it in *Approved*.** Sloth comments on the issue that the card is ready to test, with the
   preview link (the sign-in notes are on the PR); with no preview — your own PR, previews off — it points at
   the PR to check out. That head is not reviewed again. A push to the branch after the pass takes the label
   away and sends the card back to *Code Review* for a fresh look, and a check that turns red sends the
   session that wrote the PR back to make the checks pass on the same branch.
7. **The PR is merged.** By you, once it tests fine — or by Sloth when you asked it to: set *Auto-merge* in
   Settings (`autoMerge` — `squash`, `merge` or `rebase`) and a PR that passed its review on the head that is
   on the branch now, whose checks are green and which merges cleanly, is merged for you as soon as that is
   true — nobody tests it first, so it is off by default. Merging closes the issue, and a closed issue is the
   end of the card: Sloth moves it to *Done*, takes the preview, the servers, the database and the worktree
   down and deletes the branch. A PR closed without being merged does the opposite — the issue is still open,
   so the card goes to *Sloth needs help* with a comment saying its PR was closed.
8. **Or the card waits in *QA* for the daily sweep.** Some teams do not close an issue on merge: the fix is
   deployed to a QA branch first and a tester confirms it. Put those cards in a *QA* column (Settings →
   Board, opt-in) and set a time of day in Settings → *QA sweep*: at that hour Sloth gives every card there a
   session of its own — `/sloth:qa 42` — that checks the QA branch out at its current head, boots the app
   and has the tester agent click through the fix as the user it concerns, screenshots included. The result
   goes on the issue: a **pass** moves the card to *Done*, a **fail** lists the steps and what was seen and
   moves the card back to *In Progress*, where a fresh implement run reads those findings; a test that could
   not reach the fix — not on the branch yet, the app would not start — says so and leaves the card for a
   human. A card is tested once per head of the branch, so a pass is not repeated tomorrow unless the branch
   moved; **sweep now** on the home panel runs a sweep at any hour.

## When the session gets stuck

If the session cannot continue — the issue is unclear, the tests will not pass, the time runs out —
it does not guess. It writes **one comment** on the issue with its questions, moves the card to
*Sloth needs help*, and waits up to 2 hours. The people configured as responsible are `@`-mentioned
in that comment, so GitHub tells them; with a webhook configured, Slack (or whatever is behind the
URL) hears about the card too, within one board poll. Both are set in the wizard's *Columns* step
(`helpLogins` and `helpWebhook` in `config.json`); with neither, nobody is told.

The webhook can hear about more than this one moment. **Settings → Notifications** has a toggle per
event: a card reaching *Code Review*, a review passing (with the preview link) or its pass taken back, an issue Sloth closed and
filed away, the QA sweep's verdict on a card, a run stopped or parked, and a Claude usage limit pausing the watcher. Only the needs-help
one is on to begin with, so a Sloth that was set up before this keeps saying exactly what it did.

- Anyone on the team — the admin, a developer or a tester — answers in the issue thread, and the
  session continues. A comment from someone with no role is not an answer.
- No answer within 2 hours (`waitHours`, the one window for every question, the refine step's too)? The
  session stops, the card stays in *Sloth needs help*. Sloth keeps
  watching that column: an answer written later starts a new session on the issue, which re-reads the
  whole thread and continues. Moving the card back to the pickup column instead starts over.

## Talking to Sloth

Write `@sloth` in a comment on the issue, or on the pull request that closes it (`Closes #n`, or a
`sloth/issue-n-…` branch) — in the PR's conversation or on a line of its diff. A PR comment counts as
said on its issue, and Sloth answers where it was asked: on the PR, or in that review thread. A PR
linked to no issue gets a one-line reply saying so. Sloth listens to the team from the wizard's *Team*
step — one **admin**, any number of **developers** and **testers** — and ignores everyone else: no
reply, and their comments never count as answers.

- If a session is working on that issue, it reads your comment at its next step.
- The **admin**'s comment, when it is not a question, is an **order** without limits: Sloth starts a
  session (or tells the running one) to do what you said — "address the review comments", "start over
  with X". An order about the board itself — "move it to Planning", "back to Backlog", "close it" — is
  carried out as is: sessions know every column on the board, not only Sloth's own. This also works as
  the answer on a card in *Sloth needs help*.
- A **developer**'s comment, when it is not a question, is an **order within the issue**: how to
  implement it, what to change, address the review comments, start over, stop. An order that reaches
  beyond the issue — the board, closing it, other issues — is not carried out; Sloth asks the admin.
- A **tester** answers: on a card in *Sloth needs help*, a comment from anyone on the team is the answer
  the session waits for. A tester cannot give orders.
- Anything else from the team — a comment ending in `?`, or a tester's comment when nothing is waiting
  for an answer — gets a short **status reply**: which column the card is in, what the last session
  did, where the branch and PR are. It is a session of its own, so it takes a slot and waits for one:
  with the caps full or the machine loaded the comment is left unanswered and picked up on a later tick.

Every comment Sloth writes starts with `**Sloth:**`.

## Rules to know

- **The `Sloth: skip` label means a human owns the card.** Sloth never works on a card carrying it, in
  any column; take the label off and the card is Sloth's again. Sloth creates the label in the repo at
  start-up. The one exception is the review in *Code Review*: every open PR wired to a card there gets
  it, skipped or not, draft or not. A rejection sends the card back to *In Progress* still labelled, so the
  owner keeps it. Assignees do not matter to Sloth — an assigned card is worked like any other — and
  Sloth never assigns anyone.
- **Sloth can update itself.** Settings → About → *Update automatically* makes the watcher look at
  `origin/<branch>` every hour and install what is there — the same pull, install, build and restart as
  the button beside it. It waits for the tick in flight and holds the next one, so nothing is half-moved
  through the restart, and it leaves a checkout with local changes alone. Off by default. Saving the
  wizard waits for the tick in flight the same way, so no tick ever reads half of one board's
  configuration and half of another's.
- **Sessions have a time budget** (60 minutes), measured from when Sloth started the run — a session
  reports the step it is on and moves that mark with every step, so it is not what the budget goes by.
  The time a session spends parked waiting for an answer does not count, and after the answer it has 30
  minutes at least. A session that runs 5 minutes over is killed and its card goes to *Sloth needs help*. **Stop** in a running session's header does the same right away.
  A review killed or stopped this way posted no verdict and its head will not be reviewed again, so the
  issue behind the PR goes to *Sloth needs help* too instead of waiting in *Code Review* for ever.
- **At most 3 sessions work at once** (and 5 alive, counting the ones waiting for an answer), status
  replies among them. Extra work waits for the next tick — except a review of a card in *Code Review*,
  which starts anyway and takes a slot the builds then wait for; at most 3 of those start in one tick.
- **A crashed session is restarted.** A card in *In Progress* with no session is relaunched, at
  most twice in a row — a run that reaches the end of its work starts the count over, so a card that
  comes back from a failing review as often as it takes is never given up on for that. After that it
  goes to *Sloth needs help*, and the comment says how each run ended — the step it was on and what it reported on its way out (a session out of time says what
  it left undone) — so the reason is on the issue, not only in `run.log`.
- **Claude usage limit reached?** Sloth waits 30 minutes and tries again. The card keeps its place.
- **Pause** in the header stops Sloth from starting anything new. Running sessions finish, comments
  are still answered, parked cards are still announced. Press **Resume** to continue.

## Hours

Sloth keeps the hours it worked on the board, so a project can be billed by them. A **session-hour** is one
run's wall-clock time from launch to its end, minus any time Sloth paused it for the machine's sake and
minus the time it sat in *Sloth needs help* waiting for an answer — a parked session keeps its process
alive while it waits, and nobody is billed for the wait. Three runs going at once for an hour are three hours. Implement runs, reviews and QA tests are all booked, a
status reply never is. Sloth looks at its runs every few minutes, and never rounds in its own favour: a
run that marked itself finished or asked a human ended at the moment it said so; one that ended without a
word ended when its process exited, or at its last line of output; a wait begins at the second the session
asked, not at the check that noticed, and a question answered between two checks is credited from the
session's own marks. A card standing in *Sloth needs help* is waiting whatever its session says. An outage
between an end and the check that finds it adds nothing, and a run with no mark at all ends no later than
its budget allows. The launch time the bill is measured from is kept where the session cannot reach it. A run is **billable** when it did its job: it
finished, it stopped to ask a human, it asked and ran **out of response** (no answer in `waitHours`, so it
ended with the card still parked), or it posted its verdict on the PR. A run that failed — it died while
working, it hung past its budget and Sloth killed it, a usage limit stopped it, someone stopped it from the
monitor, or the machine rebooted under it — is booked with its reason and goes one of two ways. When a later
run took the card up, its hours are **continued**: shown apart from the billable hours, to be charged at half
rate. When nobody took the card up, they are not billed.

The home panel's **hours** section shows one month at a time (UTC): billable hours as the headline with the
continued hours beside them, a row per card with the implement / review / QA split, the failed runs under a
fold with how each ended and whether a later run took it up, and what is running right now. The same month is `GET /api/hours?month=YYYY-MM`. Hours only — the rate is
the invoice's business, and the ledger began with the version that introduced it.

The record is `~/.sloth/state/hours.jsonl`: one line per run, appended by Sloth's server and by nothing
else — a session is never told the file exists. Every line carries a fingerprint of its own text and of
the line before it, so a line changed, removed or slipped in breaks the chain from there on, and the panel's
chip turns to **ledger tampered**. After each run the ledger is also committed to the repository's
`sloth-assets` branch (`hours/ledger.jsonl`, beside the PR screenshots), one commit per run, so both sides
hold the history; the tick compares the two and raises `hoursTampered` through the help webhook when they
disagree or the chain is broken. A local file that no longer matches the branch is never pushed over it,
and a branch that is gone or shorter than it was is a rewritten witness, raised and never recreated.

A failed run is **continued** — shown apart, charged at half rate — when a later billable run on the same
card took its work up: one that started within 30 days of the failure and did not start over (a card moved
back to pickup, or a QA fail, starts over). A failed run followed only by more failures, or by nothing, is
not billed. Because of the 30-day window, a month's figures are final 30 days after it ends. The branch is the witness: a local file whose chain is broken, or whose
lines differ from what the branch already holds, is never pushed over it — the copy keeps the record as it
was until a human has put the file right, and the branch's own history shows every change ever made to it.

## Where everything is

```
~/.sloth/
├── config.json          the configuration (the wizard writes it)
├── watcher.log          what Sloth did, one line per event — the UI shows it
├── runners/<repo>/      the checkout sessions start from
├── worktrees/<repo>/    one worktree per issue (and one per QA test while it runs)
├── sessions/<repo>/     one folder per session: its log, its state, its inbox — a QA test's verdict
└── state/               markers so nothing is done twice (approved, handed, finished, closed, checks,
                         merged, qa); the pause; the day's QA sweep; the remote-access secret;
                         hours.jsonl — the hours ledger (see *Hours*)
```

The UI at `http://localhost:4400` shows every session, its full transcript, its token spend, and
the log. Its header's **Board** button opens a page of its own — a mirror of the board, Sloth's columns in
pipeline order over the whole window, a card per issue Sloth is on (a run on it, or waiting unclaimed in pickup;
the team's own cards are only counted), and on each card what the run Sloth last made on it is doing — built from the board the last tick already read, so it costs GitHub nothing and changes nothing.
The ▦ button in the header is a QR code that opens the same UI on your phone.
