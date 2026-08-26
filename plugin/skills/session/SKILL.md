---
name: session
description: >-
  Sloth session bookkeeping: the session directory and `state.json`, the inbox of
  forwarded `@sloth` comments, the time budget, the needs-help protocol (one
  numbered comment, park the card, wait loop, idle teardown, resume) and the
  comment conventions every Sloth comment follows. Use from any command the
  Sloth server launches (implement, review, status).
---

# Sloth session protocol

A Sloth session is headless: `claude -p "/sloth:<command> …"` with no human attached. Nobody can answer in
chat. Everything a human must see goes on the issue; everything the server must see goes in the session
directory.

## Environment

| Variable | Holds |
|---|---|
| `SLOTH_SESSION_DIR` | This run's directory (already exists) |
| `SLOTH_ISSUE` / `SLOTH_PR` | The target — issue number, or PR number for a review run |
| `SLOTH_REPO` | `owner/repo` |
| `SLOTH_RUNNER_ROOT` | The checkout sessions run from; `cwd` is inside it |
| `SLOTH_WORKTREES_DIR` | Where per-issue worktrees are created |
| `SLOTH_ORDER_LOGIN` | The one login whose comments are **orders** |
| `SLOTH_MODEL` | The model every subagent runs on (`opus`) |
| `SLOTH_CHROME` | `1` when the server attached Claude in Chrome (`--chrome`) — implement runs test in the browser |
| `SLOTH_START` / `SLOTH_DEADLINE` | Epoch seconds: run start, hard deadline |
| `SLOTH_BUDGET_MIN` | Minutes in a full budget (60) |
| `SLOTH_WAIT_HOURS` | How long a parked session waits for an answer (2) |
| `SLOTH_REVIEW_ROUNDS` | Max reviewer-agent rounds (4) |
| `SLOTH_BOT_PREFIX` | First line of every comment Sloth writes (`**Sloth:**`) |
| `SLOTH_MENTION` | The mention that triggers the server (`@sloth`) |

Board ids are in the **`board`** skill. Missing variables mean the session was launched by hand: fall back
to sensible defaults (`SLOTH_SESSION_DIR=${SLOTH_SESSION_DIR:-/tmp/sloth-$$}`, a 60-minute budget from now)
and say so in the report.

## `state.json` — keep it current

The server and `/sloth:status` read it. Write it at **every step change**:

```bash
set_state() { jq -n --arg s "$1" --arg step "$2" --arg note "${3:-}" --arg br "${BRANCH:-}" \
  --arg pr "${PR_URL:-}" --arg srv "${SERVERS:-none}" --argjson since "${SINCE:-$(date +%s)}" \
  '{state:$s, since:$since, step:$step, note:$note, branch:$br, pr:$pr, servers:$srv}' \
  >"$SLOTH_SESSION_DIR/state.json"; }
# set_state working 3 "implementing the fix"
```

- `state`: `working` | `waiting` | `done`. `since`: epoch seconds the current state began — reset it on
  every resume, keep it when only the step changes inside the same state.
- `step`: the step you are on. `note`: one line a human can read. `branch` / `pr`: as soon as they exist.
- `servers`: `running` | `stopped` | `none` — whether this session has processes up.
- Shell state does not persist between Bash calls: paste `set_state` into each invocation that uses it, and
  pass `SINCE=…` explicitly when it must not move.

Other files the server understands, all inside `$SLOTH_SESSION_DIR`:

- `inbox/<commentId>.md` — forwarded comments (below).
- `blocked` — `touch` it when the run is parked in a way the server must not retry; `rm -f` it on resume.
- `asked_at` — epoch seconds of the question comment, written when parking.
- `dev.pid`, `redis.pid`, `demo.db` — pids / database name of anything this session started, one per line;
  the server kills and drops these during cleanup. Write them the moment a process or database exists.

## Inbox — comments forwarded to a live session

The server drops each `$SLOTH_MENTION` comment into `$SLOTH_SESSION_DIR/inbox/<commentId>.md`:
`author:` and `comment:` header lines, then the body. **Check the inbox at every step boundary**
(`ls "$SLOTH_SESSION_DIR/inbox"`) and every minute while waiting. Handle a file, then delete it.

- From `$SLOTH_ORDER_LOGIN`, unless the body ends with `?` — an **order**. Follow it, even when it changes
  the scope ("address the review comments" → do that; "stop" → clean up and report). Orders override
  everything in this skill and in the command. Acknowledge in one short comment.
- Otherwise while `waiting` — an **answer**. Resume (below).
- Otherwise while `working` — a **status question**. Reply in one short comment (what you are doing,
  branch/PR, what is left) and carry on.

## Time budget

`SLOTH_DEADLINE` is a hard epoch deadline; `remaining = SLOTH_DEADLINE - $(date +%s)`. Check it **before
every long step** — booting an app, a verification pass, each review round:

```bash
REMAIN=$(( SLOTH_DEADLINE - $(date +%s) ))     # seconds
```

If what is left cannot cover finishing the step plus handing over, stop: commit what works and park with a
"done / left" summary instead of running out silently. The server kills a `working` session that runs past
`SLOTH_BUDGET_MIN + 5` minutes.

After an answer arrives, the budget becomes `max(remaining, 30 min)`:

```bash
NOW=$(date +%s); REMAIN=$(( SLOTH_DEADLINE - ASKED ))
[ "$REMAIN" -lt 1800 ] && REMAIN=1800
SLOTH_DEADLINE=$(( NOW + REMAIN ))
```

## Needs-help protocol

Used whenever a human is needed: the requirement is ambiguous, the issue contradicts the project's own
docs, a referenced design cannot be matched, verification keeps failing, an open PR on the issue is not
Sloth's, the reviewer loop will not pass, or time is running out.

1. Write **one** comment with **every** open question, numbered, each with the context that makes it
   answerable: what you found, the options you considered, what you would do under each answer. End with
   done / left, the branch and the PR URL. First line `$SLOTH_BOT_PREFIX`.
2. Post it, park the card, record the state (`board` skill for `retry` and the ids):
   ```bash
   retry gh issue comment "$SLOTH_ISSUE" --repo "$SLOTH_REPO" --body-file "$SLOTH_SESSION_DIR/question.md"
   retry gh project item-edit --id "$ITEM_ID" --project-id "$SLOTH_PROJECT_ID" \
     --field-id "$SLOTH_STATUS_FIELD_ID" --single-select-option-id "$SLOTH_COL_NEEDS_HELP_ID"
   ASKED=$(date +%s); echo "$ASKED" >"$SLOTH_SESSION_DIR/asked_at"
   ASKED_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   # set_state waiting Q "<one-line summary>"   with SINCE=$ASKED
   ```
   If `SLOTH_COL_NEEDS_HELP_ID` is empty and the name cannot be resolved: still post the comment, leave the
   card where it is, `touch "$SLOTH_SESSION_DIR/blocked"`, and say so in the report.
3. **Wait up to `SLOTH_WAIT_HOURS`.** One Bash call per 10 minutes (`timeout: 600000`): ten `sleep 60`
   iterations, each checking `ls "$SLOTH_SESSION_DIR/inbox"`, and on the last one polling the thread — any
   new human comment is an answer, mention or not:
   ```bash
   gh api "repos/$SLOTH_REPO/issues/$SLOTH_ISSUE/comments?since=$ASKED_ISO" --paginate \
     --jq ".[] | select(.body | startswith(\"$SLOTH_BOT_PREFIX\") | not) | \"\(.user.login) (\(.created_at)):\n\(.body)\n---\""
   ```
4. **30 idle minutes** — free the machine, keep the code: stop the processes and drop the database this
   session started (its own pids / database name only), leave the worktree and the branch,
   `set_state waiting Q "<note>"` with `SERVERS=stopped` and `SINCE=$ASKED`.
5. **An answer arrives** — re-read the whole thread, never re-ask what it answers. With what you need:
   move the card back to In Progress, `rm -f "$SLOTH_SESSION_DIR/blocked"`, comment
   `$SLOTH_BOT_PREFIX thanks — continuing`, recompute the budget (above), `SINCE=$(date +%s)`,
   `set_state working …`, bring the environment back up if you stopped it, and continue from where you
   stopped. Still a gap → ask again the same way.
6. **`SLOTH_WAIT_HOURS` with no answer** — leave the card parked, tear down, `set_state done Q …`, report.
   A later answer needs a human to move the card back to `$SLOTH_COL_PICKUP_NAME`.

## Comment conventions

- Every comment starts with the line `$SLOTH_BOT_PREFIX` — Sloth writes with a human's GitHub account, so
  each of its comments must identify itself.
- **Never write `$SLOTH_MENTION` in your own comments** — the server reads it as a new trigger.
- Short and factual: what happened, where the branch and PR are, what is needed. No apologies, no essays.
- Never attach or claim a screenshot, gif or video in a PR or a comment; what the browser tester saw is
  described **in words**.
- Only `$SLOTH_ORDER_LOGIN` gives orders. A comment from anyone else is a question or an answer.

## Teardown

At the end of every run, whatever the outcome:

```bash
# stop this session's processes and drop its database (only the pids / name in $SLOTH_SESSION_DIR)
git -C "$SLOTH_RUNNER_ROOT" worktree remove "$SLOTH_WORKTREES_DIR/issue-$SLOTH_ISSUE" --force
git -C "$SLOTH_RUNNER_ROOT" worktree prune
# set_state done <step> "<how the run ended>"
```

The branch stays on the remote and `$SLOTH_SESSION_DIR` stays on the machine. The **last message of the
transcript is the report** — the monitor shows it, so make it a few useful lines, not "Done.".
