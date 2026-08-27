# How Sloth works

Sloth is a program that runs on your machine. Every 5 minutes it looks at your GitHub project
board. When it finds work, it starts a Claude Code session to do it. That is all it does.

## The life of a card

1. **You move an issue into the pickup column.**
2. **Sloth picks it up.** It moves the card to *In Progress* and starts a session:
   `claude -p "/sloth:implement 42"`. The session gets its own git worktree, so it never touches
   your checkout.
3. **The session does the work.** It reads the issue and its comments, follows your project's
   `CLAUDE.md` and rules, writes the fix, and runs your tests. Then it starts the app and a **tester
   agent** opens it in your Chrome and clicks through the change like a user would; what it finds
   gets fixed. Then it opens a draft PR that says `Closes #42`. Before handing it over, it asks a reviewer agent to check the PR and fixes what
   the reviewer finds (up to 4 rounds).
4. **The card moves to *Code Review*.** The PR is marked ready. A human reviews it like any other PR.
5. **A human's PR in Code Review gets a review from Sloth.** If you wrote the PR yourself and
   wired it to the issue, Sloth reviews each new version once (`/sloth:review`). Sloth's own PRs
   are not reviewed again here — the reviewer agent in step 3 already did that. When a review
   finds bugs, it comments on the PR and moves the card back to *In Progress*.
6. **You move the card to *Approved*.** Sloth gives the PR a final review — the same review as in
   step 5, but on the Fable model. If it finds problems, it comments and sends the card back
   to *In Progress*. If not, the card stays in *Approved*, the issue gets the label `Fable: approved`,
   and the PR is ready to merge. A labelled card is not reviewed again — remove the label to ask for
   another look.

## When the session gets stuck

If the session cannot continue — the issue is unclear, the tests will not pass, the time runs out —
it does not guess. It writes **one comment** on the issue with its questions, moves the card to
*Sloth needs help*, and waits up to 2 hours. The people configured as responsible are `@`-mentioned
in that comment, so GitHub tells them; with a webhook configured, Slack (or whatever is behind the
URL) hears about the card too, within one board poll. Both are set in the wizard's *Columns* step
(`helpLogins` and `helpWebhook` in `config.json`); with neither, nobody is told.

- Anyone on the team — the admin, a developer or a tester — answers in the issue thread, and the
  session continues. A comment from someone with no role is not an answer.
- No answer within 2 hours? The session stops, the card stays in *Sloth needs help*. Sloth keeps
  watching that column: an answer written later starts a new session on the issue, which re-reads the
  whole thread and continues. Moving the card back to the pickup column instead starts over.

## Talking to Sloth

Write `@sloth` in an issue comment. Sloth listens to the team from the wizard's *Team* step — one
**admin**, any number of **developers** and **testers** — and ignores everyone else: no reply, and
their comments never count as answers.

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
  did, where the branch and PR are.

Every comment Sloth writes starts with `**Sloth:**`.

## Rules to know

- **An assignee means a human owns the card.** Sloth never works on an assigned card, in any column.
  The one exception is the final review in *Approved*: every open, non-draft PR wired to a card there
  gets it, assigned or not. A rejection sends the card back to *In Progress* still assigned, so the
  owner keeps it. Sloth never assigns anyone.
- **Sessions have a time budget** (60 minutes). A session that runs 5 minutes over is killed and
  its card goes to *Sloth needs help*.
- **At most 3 sessions work at once** (and 5 alive, counting the ones waiting for an answer).
  Extra work waits for the next tick.
- **A crashed session is restarted.** A card in *In Progress* with no session is relaunched, at
  most twice in a row. After that it goes to *Sloth needs help*.
- **Claude usage limit reached?** Sloth waits 30 minutes and tries again. The card keeps its place.
- **Pause** in the header stops Sloth from starting anything new. Running sessions finish, comments
  are still answered, parked cards are still announced. Press **Resume** to continue.

## Where everything is

```
~/.sloth/
├── config.json          the configuration (the wizard writes it)
├── watcher.log          what Sloth did, one line per event — the UI shows it
├── runners/<repo>/      the checkout sessions start from
├── worktrees/<repo>/    one worktree per issue
├── sessions/<repo>/     one folder per session: its log, its state, its inbox
└── state/               markers so nothing is done twice; the pause; the remote-access secret
```

The UI at `http://localhost:4400` shows every session, its full transcript, its token spend, and
the log. The ▦ button in its header is a QR code that opens the same UI on your phone.
