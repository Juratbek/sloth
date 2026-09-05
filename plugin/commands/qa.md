---
description: The daily QA sweep's test of one card — check the QA branch out at its current head, boot the app, test the merged fix in a headless Chrome as the user the issue is about, post the findings on the issue with screenshots, and write the verdict (passed / failed / inconclusive) for the server, which moves the card
argument-hint: <issue-number|url>
allowed-tools: Bash, Read, Grep, Glob, Skill, Agent, ToolSearch, SendMessage
---

# Test a merged fix on the QA branch

The issue in `$ARGUMENTS` (`$SLOTH_ISSUE` when set) sits in `$SLOTH_COL_QA_NAME`: its fix is merged and
deployed to `$SLOTH_QA_BRANCH` — the repository's default branch when that is empty — and a tester is
supposed to confirm it. Be that tester: check the branch out, bring the app up, drive the behaviour the
issue asked for as the user it concerns, and say on the issue what you saw. **You move no card and change
no code.** The server reads your verdict and moves the card: `passed` → `$SLOTH_COL_DONE_NAME`, `failed` →
`$SLOTH_COL_IN_PROGRESS_NAME`, where a new implement run picks your findings up; `inconclusive` leaves it
for a human.

Nobody is watching. Never ask in chat; there is no needs-help step here — what cannot be tested is
`inconclusive`, said plainly. Read the **`session`** skill (state file, budget, comment rules, screenshots,
teardown) and the **`board`** skill (`retry`) before Step 0.

**Everything project-specific comes from the project**: `CLAUDE.md` / `AGENTS.md`, its rules, its skills
(above all the one that runs the app and says how to sign in), its docs. This command only says *when*.

## Step 0 — Read

```bash
ISSUE=${SLOTH_ISSUE:?}; SESSION_DIR=${SLOTH_SESSION_DIR:?}
START=${SLOTH_START:-$(date +%s)}; SINCE=$START
# set_state working 0 "reading the issue"     (session skill)
gh issue view "$ISSUE" --repo "$SLOTH_REPO" --json number,title,body,labels,url,state
gh issue view "$ISSUE" --repo "$SLOTH_REPO" --json comments --jq '.comments[] | "\(.author.login) (\(.createdAt)):\n\(.body)\n---"'
```

Then the PR that closed it — `closedByPullRequestsReferences` (`board` skill), merged ones included — and
its body: it says what changed, what was verified and, for a Sloth PR, which screens the tester saw:

```bash
gh pr view <N> --repo "$SLOTH_REPO" --json number,title,body,state,mergedAt,mergeCommit,baseRefName
```

From the issue and its thread write down, before touching anything: **the behaviour to confirm** (every
requirement and acceptance criterion, the body *and* the thread — earlier answers are binding; a `## Spec`
section in the body is Sloth's refinement of the card, and every box under its *Acceptance criteria* is one
thing to confirm), **the old behaviour that must be gone**, and **the role** — which user of the app meets this screen. A behaviour spec
in the repo (`docs/` or equivalent) that covers the flow is the reference for what "correct" means.

No merged PR wired to the issue, or one merged into a branch that is not `$SLOTH_QA_BRANCH` and not merged
onward into it: the fix is not on the branch you are testing → **inconclusive** (Step 4), saying so.

## Step 1 — Reset the worktree slot to the QA branch

`$SLOTH_WORKTREE` is a worktree Sloth leased to this run from its pool — an earlier run's checkout, kept
so its installed dependencies carry over. Reset it; never create or remove a worktree.

```bash
BRANCH=${SLOTH_QA_BRANCH:-$(gh repo view "$SLOTH_REPO" --json defaultBranchRef --jq .defaultBranchRef.name)}
WT="$SLOTH_WORKTREE"
git -C "$WT" fetch origin "$BRANCH"
git -C "$WT" checkout -q --detach "origin/$BRANCH"
git -C "$WT" clean -fdx -e node_modules -e .turbo -e .venv -e .cache   # the previous run's files go; dependencies and caches stay
SHA=$(git -C "$WT" rev-parse --short HEAD)
cd "$WT"
# set_state working 1 "checked out $BRANCH @ $SHA"   with BRANCH set
```

Detached, read-only: no branch of your own, no commit, no push. Work **only inside `$WT`** — never the
checkout at `$SLOTH_RUNNER_ROOT`, never another slot, which may belong to a live run. Install dependencies
the way the repo does (`CLAUDE.md` wins; otherwise the lockfile — `pnpm-lock.yaml` →
`pnpm install --frozen-lockfile`, and so on). A reused slot installs in seconds but runs **no `postinstall`**:
run the project's generate steps yourself (a Prisma client, codegen — whatever `CLAUDE.md` or the
`postinstall` / `generate` scripts name), or you test against code generated for another branch.

Confirm the fix is in what you checked out: `git -C "$WT" merge-base --is-ancestor <mergeCommit> HEAD`. A
merge commit that is not an ancestor means the branch does not carry the fix yet → **inconclusive**.

## Step 2 — Bring the app up

Use the project's skill that runs the app (a dev-environment / run / demo skill), exactly as it says: its
own database, its own ports, throwaway credentials. Record every pid it starts into `$SESSION_DIR/dev.pid`
/ `redis.pid` and any database name into `$SESSION_DIR/demo.db` the moment they exist (the server cleans
these up), `SERVERS=running`, `set_state working 2 "app up"`. Note the URL and how to sign in as the role
from Step 0.

**A warm stack** (`SLOTH_WARM=1`, `session` skill): the slot's servers, Redis and database from the
previous run are already up — pids and name already in `$SESSION_DIR`. Skip createdb, redis-server, the
build and the server starts: sync the schema onto the existing database, reseed, `FLUSHALL` Redis — the
watch-mode servers pick the checkout up themselves. `SLOTH_WARM_SAME=1` (same card, same head): skip even
that. A reset step fails → kill the pids in `$SESSION_DIR/dev.pid` / `redis.pid` yourself and boot cold.

No such skill: the repo's own instructions (`README`, `CLAUDE.md`, `package.json` scripts). An app that
will not come up after two attempts is not a failed fix → **inconclusive**, with the error.

## Step 3 — Test it in the browser (tester subagent)

Check the clock first (`session` skill). Then, with `SLOTH_CHROME=1`, spawn **one** tester subagent
(`Agent`, `subagent_type: "general-purpose"`, `model: "$SLOTH_TESTER_MODEL"`, `run_in_background: false`)
and reuse it via `SendMessage` for anything you want looked at again. Give it the app's URL, how to log
in as the role, the behaviour to confirm and the old behaviour that must be gone (Step 0, quoted), the
surrounding flow a real user would go through, and `$SLOTH_SCREENSHOTS_DIR`. Its task:

1. Load the browser tools with **one** `ToolSearch` call for the `browser_*` Playwright tools
   (`browser_navigate, browser_snapshot, browser_click, browser_type, browser_fill_form, browser_press_key,
   browser_select_option, browser_wait_for, browser_take_screenshot, browser_console_messages,
   browser_network_requests, browser_handle_dialog, browser_close`). Missing → report
   `browser tools unavailable` and stop.
2. The browser is this session's own headless Chrome — an empty profile. Log in the way the run skill
   says. Act from `browser_snapshot` refs, never from pixels; answer a `confirm` / `alert` with
   `browser_handle_dialog`.
3. Drive the behaviour **as the user would**, from where that role lands, through the whole flow the issue
   is about: the new behaviour works, the old one is gone, what surrounds it still works. After each screen
   read `browser_console_messages` and `browser_network_requests`; an uncaught exception or a failed app
   request on the way is a finding.
4. Screenshot every screen it verifies — `browser_take_screenshot` with an **absolute**
   `filename: "$SLOTH_SCREENSHOTS_DIR/NN-<kebab-what>.png"` — one per state, the state the issue is about
   first; at least one, rarely more than six.
5. `browser_close`. Return raw data: the steps taken, pass / fail per requirement, every finding with what
   was seen against what was expected, what could not be tested and why, and the screenshot files with a
   one-line caption each.

`SLOTH_CHROME=0`, or the tools unavailable: test what can be tested without a browser — the API with
`curl`, the database, the CLI, the rendered markup — and say exactly what was and was not covered. A fix
that only shows on a screen and no browser to see it → **inconclusive**.

A finding that is clearly the app's environment and not the fix — a seed missing, a port clash — is fixed
in the environment and re-tested, never counted against the fix. A finding in the fix is not yours to
repair: it goes on the issue.

## Step 4 — The verdict, on the issue

Decide from the tester's raw data, not its summary: **passed** when every requirement from Step 0 holds,
the old behaviour is gone and the flow around it works; **failed** when a requirement does not hold, the
old behaviour is still there, or the fix breaks something on the way; **inconclusive** when the fix could
not be reached — no fix on the branch, the app would not come up, no browser for a screen-only change.

Publish the screenshots (`SHOTS=$(publish_shots "$SLOTH_SCREENSHOTS_DIR")`, `session` skill — it needs the
worktree, so before Step 5), then comment, first line `$SLOTH_BOT_PREFIX`:

```
**Sloth:**
QA on `<branch>` @ <sha>: **passed** — <one line: what was driven, as which role>.
![<caption>](<SHOTS>/01-<what>.png?raw=true)
```

```
**Sloth:**
QA on `<branch>` @ <sha>: **failed** — <one line: which requirement, in what way>.
1. <step the tester took> → <what was seen> (expected: <what the issue asks>)
2. …
![<caption>](<SHOTS>/02-<what>.png?raw=true)
```

```
**Sloth:**
QA on `<branch>` @ <sha>: **inconclusive** — <one line: what stood in the way>. A human has to test this one.
```

Every verdict ends with one more line, `_QA tester on \`$SLOTH_MODEL\`._` — who tested and on what, for
whoever reads the card later.

A failure's numbered steps are the brief of the implement run that follows: exact, reproducible, one
observation per line, the expected behaviour beside it. Only screenshots the tester saved — never a link
to one that was not taken. Then the verdict, one word, for the server:

```bash
retry gh issue comment "$ISSUE" --repo "$SLOTH_REPO" --body-file "$SESSION_DIR/qa-comment.md"
echo passed >"$SESSION_DIR/verdict"        # or failed / inconclusive — after the comment, never before
# set_state working 4 "<verdict>"
```

## Step 5 — Clean up, report

Teardown per the `session` skill: with `SLOTH_WARM_SLOTS=1` leave the servers and database running — the
server keeps them warm for the next run; otherwise stop this session's processes and drop its database.
`set_state done 5 "<verdict>"`; the slot (`$SLOTH_WORKTREE`) stays for the server to return. No preview:
a QA run never hands its app to one.

Finish with the report — the transcript's last message, shown in the monitor: the verdict, branch and
sha, what the tester drove and as whom, what was not covered, how many screenshots the comment carries.

## Rules

- **Read-only on the code**: a detached worktree, no branch, no commit, no push, no edit. The fix is judged, not repaired.
- **No board move, no label, no close** — the server moves the card on `verdict`. Never move it yourself.
- **The verdict is written after the comment**, and once. Every run ends with exactly one of the three
  words in `$SESSION_DIR/verdict`, or none if the run dies — the server then tests the card again.
- **Never ask for help.** Ambiguity that stops a test is `inconclusive`, said in the comment; the card stays.
- **The tester's raw data decides**, against the issue's requirements *and* its thread — never the PR's
  own word for what works.
- **Respect `$SLOTH_DEADLINE`** (`session` skill): out of time before a verdict → `inconclusive`, saying so.
- Every comment starts with `$SLOTH_BOT_PREFIX`; never write `$SLOTH_MENTION`. No screenshot that was not taken.
- **Never touch `$SLOTH_RUNNER_ROOT`, the issue's `issue-<n>` worktree, a shared database, or a port another session uses.**
- Always clean up (Step 5), whatever the verdict.
