---
description: The scheduled smoke test of the whole app — check the branch out at the head the server pinned, boot the app, walk the main flows of every user role through a headless Chrome, happy paths only, then post a GO / NO-GO report on the report issue, file the blockers and majors as issues, and write the verdict for the server
argument-hint: <run-number>
allowed-tools: Bash, Read, Grep, Glob, Skill, Agent, ToolSearch, SendMessage
---

# Smoke-test the app for a release

Run `$ARGUMENTS` (`$SLOTH_SMOKE_RUN` when set) is Sloth's scheduled smoke test: release qualification of
`$SLOTH_SMOKE_BRANCH` at `$SLOTH_SMOKE_SHA`. Find what would block a deploy — a login that fails, a white
screen, a crash, a core flow that cannot complete, wrong money, one user's data on another's screen, a build
that does not build. It is **not** a review of style, conventions or tests. **Happy paths only**: every
role's main flows, through the real UI, as that user would go through them. You move no card, change no
code — the throwaway Playwright run config of Step 2.5, deleted after its run, is the one file you write —
and never ask for help. The verdict goes to the server in one word (`$SESSION_DIR/verdict`); the
report goes on the repository's **report issue**; the serious findings become issues of their own.

Nobody is watching. There is no issue of your own, no inbox, no needs-help step: what cannot be tested is
said in the report. Read the **`session`** skill (state file, budget, screenshots, teardown) and the
**`board`** skill (`retry`, `item-add`) before Step 0.

**Everything project-specific comes from the project**: `CLAUDE.md` / `AGENTS.md`, its rules, its skills
(above all the one that runs the app and says how to sign in as each role), its docs. This command only
says *when* and *how much*.

## Step 0 — Read the project, plan the roles

```bash
RUN=${SLOTH_SMOKE_RUN:-$ARGUMENTS}; SESSION_DIR=${SLOTH_SESSION_DIR:?}
START=${SLOTH_START:-$(date +%s)}; SINCE=$START
# set_state working 0 "reading the project"     (session skill)
cat "$SESSION_DIR/brief.md" 2>/dev/null          # what to smoke, from Settings — may not exist
```

Write the plan before touching anything — `$SESSION_DIR/plan.md`, one line per role: **the role**, **where
it lands** after sign-in, **its main flows** (three to six, the ones the business stops without), and **how
to sign in as it** (from the run skill: seeded accounts, OTP, password). With a brief, the brief is the
plan — its roles, its flows, in its order; fill in only what it leaves out. Without one, read the roles off
the project: the run skill's seeded users, the routes and navigation per role, the docs. Every role that
has screens of its own is a line; an internal or admin-only role ranks last.

Then the budget: `REMAIN=$(( SLOTH_DEADLINE - $(date +%s) ))`. Reserve fifteen minutes for the report and
teardown and, with a cold boot, twenty for the app; with `SLOTH_E2E=1` and a Playwright setup in the project, up
to twenty for the e2e suite (Step 2.5). What is left is split over the roles, first line first, about fifteen
minutes each; roles that do not fit are **untested** — say so in the plan now, not at the end.

## Step 1 — Check out the head under test, build

`$SLOTH_WORKTREE` is a worktree Sloth leased to this run from its pool. Reset it to the exact head the
server pinned; never create or remove a worktree.

```bash
WT="$SLOTH_WORKTREE"; BRANCH="$SLOTH_SMOKE_BRANCH"; SHA="$SLOTH_SMOKE_SHA"
git -C "$WT" fetch origin "$BRANCH"
git -C "$WT" checkout -q --detach "$SHA"
git -C "$WT" clean -fdx -e node_modules -e .turbo -e .venv -e .cache
cd "$WT"
# set_state working 1 "checked out $BRANCH @ ${SHA:0:7}"   with BRANCH set
```

Detached, read-only: no branch of your own, no commit, no push. Work **only inside `$WT`** — never the
checkout at `$SLOTH_RUNNER_ROOT`, never another slot, which may belong to a live run. Install dependencies
the way the repo does (`CLAUDE.md` wins; otherwise the lockfile). A reused slot runs **no `postinstall`**:
run the project's generate steps yourself.

**The build gate.** Run the project's build and type-check as `CLAUDE.md` or its package scripts name them
— what a deploy would run. A build that fails is a **BLOCKER** on its own: record the error, skip Steps 2
and 3, and go to Step 4 with a **NO-GO** — nothing can boot.

## Step 2 — Bring the app up

Exactly as `/sloth:qa` does: the project's skill that runs the app, its own database, its own ports,
throwaway credentials. Record every pid into `$SESSION_DIR/dev.pid` / `redis.pid` and any database name
into `$SESSION_DIR/demo.db` the moment they exist, `SERVERS=running`, `set_state working 2 "app up"`.
The warm-stack rules (`SLOTH_WARM`, `SLOTH_WARM_SAME`) are the `session` skill's. An app that will not
come up after two attempts is **inconclusive** (Step 4), with the error — not a finding against the app.

## Step 2.5 — The project's e2e suite, against this app (`SLOTH_E2E=1`)

With `SLOTH_E2E=1` the project may carry the tests Sloth's e2e writer committed with every card, one per
acceptance criterion. Run **the whole suite** once, against the app from Step 2, before any tester: it is
the cheapest smoke there is, and every red test tells a role's tester where to look first. Nothing here
replaces the testers — a suite only checks what somebody once wrote down.

Find the setup: Glob `playwright.config.*` in the worktree, ignoring `node_modules`, `dist`, `build`,
`.venv`. None → the report says `E2E suite: skipped — no Playwright setup`, and the run goes on to Step 3.
Several → the one whose `package.json` has a `test:e2e`-style script. Then check the clock: the suite gets
**at most twenty minutes**, less when the roles' share would fall under ten minutes each — its time comes
off the roles', and the roles are the smoke test. `set_state working 2.5 "running the e2e suite"`.

Run it exactly the way the `e2e-writer` agent does (`agents/e2e-writer.md`, procedure 4, its snippet
included): a `playwright.sloth.config.ts` beside the project's config that imports it with its real
extension, points every `baseURL` — top-level, and per project when it declares any — at this app, drops
`webServer` (the app is never booted twice) and sets `outputDir` under `$SESSION_DIR`. Then, from that
package directory, with no file argument — the whole suite — and the time cap enforced by Playwright:

```bash
MINUTES=20                                        # or less — what the roles can spare
npx playwright test --config playwright.sloth.config.ts --reporter=list --retries=1 \
  --global-timeout $((MINUTES * 60000)) 2>&1 | tee "$SESSION_DIR/e2e.log"
rm -f playwright.sloth.config.ts
```

One `npx playwright install chromium` when the browsers are missing (`Executable doesn't exist`); a Linux
`install-deps` prompt needs sudo you have not got → could not run. A `globalSetup` that boots the app itself
→ could not run. **Delete the run config afterwards**, pass or fail; `git status` in the worktree then shows
nothing — this is the one file the read-only checkout ever gets (Rules).

Read the reporter's list, not its summary line: a test red on both attempts is **a red test**; one that
passed on the retry is **flaky** — noted, never a finding. A run that stopped at the cap is `cut off at
<minutes> minutes` with the counts it reached; a run that could not happen is `could not run — <why>`,
never counted against the app. Write `$SESSION_DIR/e2e.md`: the command, `N passed, M failed, F flaky`,
and one line per red test — its file and title, the assertion's first line — so Step 3 can hand it on.

**Red tests go to the testers.** Match each red test to a role by its file, its `describe` title and the
screens it drives; a test no role owns goes to the first role that can reach its screen. Its tester
(Step 3) reproduces it **through the UI** first, and the finding — severity, screenshot, evidence — is the
tester's. A red test no tester reproduced is in the report all the same, under *E2E suite*, as a **MAJOR
with no screenshot**: a criterion the app once met and no longer does, with the assertion as its evidence.
It files no issue (Step 4: no image, no issue) but it holds the verdict at **go-with-risks** at best.

## Step 3 — Walk every role through the browser

Check the clock before **each** role. With `SLOTH_CHROME=1`, spawn **one tester subagent per role**
(`Agent`, `subagent_type: "general-purpose"`, `model: "$SLOTH_TESTER_MODEL"`, `run_in_background: false`),
**one role at a time**: the headless Chrome is this session's one browser, and two testers in it would drive
each other's pages. A fresh subagent per role keeps each one's context to its own screens. Give it the app's
URL, its role's line from the plan (how to sign in, where it lands, the flows), `$SLOTH_SCREENSHOTS_DIR`,
a role prefix for its files and, from Step 2.5, the red e2e tests matched to its role — **look here first**:
each is reproduced through the UI before the role's own flows, as a flow of its own. Its task:

1. Load the browser tools with **one** `ToolSearch` call for the `browser_*` Playwright tools
   (`browser_navigate, browser_snapshot, browser_click, browser_type, browser_fill_form, browser_press_key,
   browser_select_option, browser_wait_for, browser_take_screenshot, browser_console_messages,
   browser_network_requests, browser_handle_dialog, browser_close`). Missing → report
   `browser tools unavailable` and stop.
2. Sign in as the role the way the run skill says. Act from `browser_snapshot` refs, never from pixels;
   answer a `confirm` / `alert` with `browser_handle_dialog`.
3. **Smoke the role**: visit every screen reachable from its navigation, open its primary lists and
   tables, and complete each flow from the plan end to end **through the UI**. `curl` and the database
   are for setup only — a missing precondition (an unpaid invoice, an order to act on) may be created
   through the UI as another role of the same tenant, never as a test of its own. Seeded data first.
4. After every screen read `browser_console_messages` and `browser_network_requests`. What counts:
   **uncaught exceptions** and **failed app requests** (any 5xx, or a 4xx on a happy path). Warnings, dev
   notices and third-party noise do not.
5. **A failure is reproduced once** before it is a finding. Classify: **BLOCKER** (sign-in broken, a
   white screen or crash, a main flow that cannot complete, wrong money, another tenant's data visible),
   **MAJOR** (a feature broken, a workaround exists, no data corrupted), **MINOR** (cosmetic, an edge).
   Every finding carries its evidence: the screen and route, the exact steps, expected against seen, the
   console or network excerpt, and the server log excerpt when the backend was in it. A finding that is
   clearly the environment — a seed missing, a port clash — is a **setup failure**, fixed and re-run,
   never reported as an app bug.
6. **Every finding is photographed.** The moment a failure is seen, `browser_take_screenshot` of the
   failing state — `$SLOTH_SCREENSHOTS_DIR/NN-<role>-<kebab-what>-bug.png` — and, when the steps matter,
   the screen just before the action that broke (`…-before.png`). During the reproduction, once more: the
   picture that goes on the issue is the reproduced one. A finding with no image of its screen is not
   finished: go back and take it. The build gate and a backend-only failure (a 5xx with nothing on
   screen) are the exceptions — there the log excerpt is the evidence, and a screenshot of whatever the
   screen showed still goes with it.
   Screenshot every screen it verifies as well — the same call, an **absolute**
   `filename: "$SLOTH_SCREENSHOTS_DIR/NN-<role>-<kebab-what>.png"` — one per state; at least one per role,
   rarely more than six beyond the findings' own.
7. `browser_close`. Return raw data: screens visited, each flow pass / fail with its steps, every finding
   with severity and evidence, what could not be tested and why, and the screenshot files with a one-line
   caption each.

A role's tester that dies or reports a setup failure gets **one** more run, after the other roles, when
the machine is quieter; still failing, the role is **untested** with its evidence. `SLOTH_CHROME=0`, or the
tools unavailable: nothing here is a smoke test — the verdict is **inconclusive**, saying so.

## Step 4 — Verdict, and the findings as issues

Decide from the testers' raw data, never their summaries: **`no-go`** with one BLOCKER or more, or the
build gate failed; **`go-with-risks`** with MAJORs only — a red e2e test nobody reproduced counts as one
(Step 2.5); **`go`** with at most MINORs; **`inconclusive`**
when nothing could be tested — the app never came up, no browser, every role untested. Untested roles are
listed and change no verdict. `set_state working 4 "<verdict>: filing findings"`.

Publish the screenshots first (`SHOTS=$(publish_shots "$SLOTH_SCREENSHOTS_DIR")`, `session` skill — it
needs the worktree, so before Step 6); the issues below and the report embed them from there.

**Every BLOCKER and every MAJOR becomes an issue**, one each, unless an open one already covers it:

```bash
gh issue list --repo "$SLOTH_REPO" --state open --search "<three or four keywords>" --json number,title,url
```

A match is linked in the report instead of a new issue. Otherwise:

```bash
ISSUE_URL=$(retry gh issue create --repo "$SLOTH_REPO" \
  --title "Smoke: <role / screen>: <the defect in a few words>" \
  --body-file "$SESSION_DIR/finding-<k>.md")
retry gh project item-add "$SLOTH_PROJECT_NUMBER" --owner "$SLOTH_PROJECT_OWNER" --url "$ISSUE_URL" --format json --jq '.id'
```

The body: `$SLOTH_BOT_PREFIX` first, then **severity and role**, the route, the numbered steps, expected
against seen, **the screenshot of the failing screen** — `![<what it shows>](<SHOTS>/NN-<role>-<what>-bug.png?raw=true)`,
the before-picture above it when one was taken — then the console / network / log excerpts, and a last line
`_Found by Sloth's smoke test $RUN on \`$BRANCH\` @ ${SHA:0:7}._`. **An issue with no image is not filed**:
a person reading it has to see what is wrong, not imagine it. A finding whose tester saved no picture goes
back to that role's one re-run (Step 3) for the screenshot; still without one, it stays in the report,
marked *no screenshot*, and no issue is opened. The build gate's blocker is the one issue without a
screen — its image is the build output in a code block. The card lands on the board **with no status** —
a human decides whether Sloth fixes it. **Never move it to `$SLOTH_COL_PICKUP_NAME` yourself**, never
assign, never label. MINORs are report-only.

## Step 5 — The report, on the report issue

Write `$SESSION_DIR/report.md`, first line `$SLOTH_BOT_PREFIX`, embedding the same published screenshots:

```
**Sloth:**
## Smoke test <run> on `<branch>` @ <sha> — **NO-GO**
<date>. Tested against the project's demo data — regressions that only show on production data are out of scope.

### Blockers
- **<role / screen>** — <flow>: <what was seen, against what was expected>. <issue link or "matches #n">
  ![<caption>](<SHOTS>/03-cashier-checkout.png?raw=true)
### Majors
…
### Minors
…
### E2E suite
<N> passed, <M> failed, <F> flaky in <minutes> min — or one line: skipped — e2e off / no Playwright setup; could not run — <why>; cut off at <minutes> minutes, <counts so far>
- `<file> › <title>` — <the assertion's first line>. Reproduced by <role>'s tester: see <the finding above> — or: not reproduced through the UI; MAJOR, no screenshot, no issue
### Roles
| role | screens | flows | outcome |
|---|---|---|---|
| RECEPTIONIST | 6 | 4 / 5 passed | tested |
| NURSE | — | — | untested: <why> |

_Smoke test on `$SLOTH_MODEL`, testers on `$SLOTH_TESTER_MODEL`._
```

Every finding is one bullet: role and screen, the flow, seen against expected, the filed issue's link,
and the screenshot the tester saved — never one that was not taken. A section with nothing is left out —
except *E2E suite*, always present: its one line says what ran, or why nothing did (`skipped — e2e off` with
`SLOTH_E2E=0`), so a reader never wonders whether the suite was forgotten.
The report comment is the one Sloth comment that runs longer than five lines: it **is** the record.

The report issue is the one open issue in the repository titled exactly `Smoke test reports`; find it, or
create it once:

```bash
REPORT=$(gh issue list --repo "$SLOTH_REPO" --state open --search "\"Smoke test reports\" in:title" --json number,title \
  --jq '[.[] | select(.title == "Smoke test reports")][0].number')
[ -n "$REPORT" ] || REPORT=$(retry gh issue create --repo "$SLOTH_REPO" --title "Smoke test reports" \
  --body "$SLOTH_BOT_PREFIX Every scheduled smoke test of the app posts its GO / NO-GO report here. Blockers and majors are filed as issues of their own." \
  | grep -oE '[0-9]+$')
retry gh issue comment "$REPORT" --repo "$SLOTH_REPO" --body-file "$SESSION_DIR/report.md"
echo "$REPORT" >"$SESSION_DIR/report_issue"
echo no-go >"$SESSION_DIR/verdict"        # or go / go-with-risks / inconclusive — after the comment, never before
# set_state working 5 "<verdict>"
```

The report issue is never closed by this run and never put on the board.

## Step 6 — Clean up, report

Teardown per the `session` skill: with `SLOTH_WARM_SLOTS=1` leave the servers and database running;
otherwise stop this session's processes and drop its database. `set_state done 6 "<verdict>"`; the slot
stays for the server to return. No preview: a smoke test never hands its app to one.

Finish with the report — the transcript's last message, shown in the monitor: the verdict, branch and sha,
the roles tested and untested, how many findings of each severity, which issues were filed, the report
issue's number.

## Rules

- **Read-only on the code**: a detached worktree at the pinned head, no branch, no commit, no push, no edit — the one exception the throwaway `playwright.sloth.config.ts` of Step 2.5, deleted after its run, its output under `$SESSION_DIR`. A finding is filed, never fixed.
- **Pure UI**: the testers drive the real browser; `curl`, `psql` and the CLI are setup tools, not test channels. Happy paths only. The project's own test suites are out of scope — except its Playwright e2e suite with `SLOTH_E2E=1` (Step 2.5), run once against this app and never edited; a red test is a lead for a tester, and a MAJOR when no tester reproduced it.
- **No board move, no label, no assignee, no close.** A filed finding goes on the board with no status; the report issue stays open and off the board.
- **The verdict is written after the report comment**, once — one of `go`, `go-with-risks`, `no-go`, `inconclusive` in `$SESSION_DIR/verdict`, or nothing if the run dies. **Never ask for help**: what stops a test is said in the report.
- **One tester at a time** in the one browser; a fresh subagent per role, on `$SLOTH_TESTER_MODEL`.
- **Every finding has evidence and one reproduction.** No evidence, no finding; a setup failure is never an app bug.
- **Every filed issue shows the bug**: at least one screenshot of the failing screen, taken by the tester and pushed by `publish_shots`, embedded in the body. No image, no issue — it stays in the report. Never a picture that was not taken.
- **Respect `$SLOTH_DEADLINE`** (`session` skill): out of time is untested roles in the report, never a report skipped — reserve the last fifteen minutes for Steps 4–6.
- Every comment starts with `$SLOTH_BOT_PREFIX`; never write `$SLOTH_MENTION`. No screenshot that was not taken.
- **Never touch `$SLOTH_RUNNER_ROOT`, another slot, a shared database, or a port another session uses.**
- Always clean up (Step 6), whatever the verdict.
