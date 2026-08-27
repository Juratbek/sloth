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
   and the PR is ready to merge.

## When the session gets stuck

If the session cannot continue — the issue is unclear, the tests will not pass, the time runs out —
it does not guess. It writes **one comment** on the issue with its questions, moves the card to
*Sloth needs help*, and waits up to 2 hours.

- Answer in the issue thread, and the session continues.
- No answer? The session stops. Move the card back to the pickup column to try again.

## Talking to Sloth

Write `@sloth` in an issue comment.

- If a session is working on that issue, it reads your comment at its next step.
- If you are the configured `orderLogin` and your comment is not a question, it is an **order**:
  Sloth starts a session to do what you said ("address the review comments", "start over with X").
- Anything else gets a short **status reply**: which column the card is in, what the last session
  did, where the branch and PR are.

Every comment Sloth writes starts with `**Sloth:**`.

## Rules to know

- **An assignee means a human owns the card.** Sloth never touches an assigned card, in any column.
  Sloth never assigns anyone.
- **Sessions have a time budget** (60 minutes). A session that runs 5 minutes over is killed and
  its card goes to *Sloth needs help*.
- **At most 3 sessions work at once** (and 5 alive, counting the ones waiting for an answer).
  Extra work waits for the next tick.
- **A crashed session is restarted.** A card in *In Progress* with no session is relaunched, at
  most twice in a row. After that it goes to *Sloth needs help*.
- **Claude usage limit reached?** Sloth waits 30 minutes and tries again. The card keeps its place.
- **Pause** in the header stops Sloth from starting anything new. Running sessions finish, comments
  are still answered. Press **Resume** to continue.

## Where everything is

```
~/.sloth/
├── config.json          the configuration (the wizard writes it)
├── watcher.log          what Sloth did, one line per event — the UI shows it
├── runners/<repo>/      the checkout sessions start from
├── worktrees/<repo>/    one worktree per issue
├── sessions/<repo>/     one folder per session: its log, its state, its inbox
└── state/               markers so nothing is done twice; the pause
```

The UI at `http://localhost:4400` shows every session, its full transcript, its token spend, and
the log.
