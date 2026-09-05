---
description: Implement a GitHub issue end-to-end in an isolated worktree — claim the card, refine it with the author when it cannot be built without guessing, fix, verify, test and screenshot it in a headless Chrome, write the e2e tests for its criteria when the switch is on, open a PR, pass a reviewer-agent loop, hand the card to Code Review; when blocked, ask on the issue and wait for the answer
argument-hint: <issue-number|url> [extra instructions or an order]
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Skill, Agent, ToolSearch, SendMessage
---

# Implement a GitHub issue

Implement the issue in `$ARGUMENTS` **autonomously**: isolated worktree, real verification, a PR that passes
a reviewer-agent loop, card in `$SLOTH_COL_CODE_REVIEW_NAME`.

Nobody is watching this session. Never ask in chat, never guess: whenever you need a human — the issue is
ambiguous, it contradicts the project's docs, a design cannot be matched, verification will not pass, the
open PR on the issue is not yours, the review loop stalls, time runs out — go to **Step Q**.

Read the **`session`** skill (state file, inbox, budget, needs-help, comment rules) and the **`board`**
skill (ids, moves, wired PR, `retry`) before Step 0, and follow them for the whole run.

**Everything project-specific comes from the project**, never from this command: `CLAUDE.md` / `AGENTS.md`,
the repo's rules, its skills, its docs. This command only says *when* to consult them.

**Orchestrator mode** (`SLOTH_ORCHESTRATOR=1`): this session is the orchestrator and **never edits code
itself** — no `Edit`, no `Write`, no fix-up in the worktree. Every change to the application's code is made by
**one implementor subagent** on `$SLOTH_IMPLEMENTOR_MODEL` (spawned in Step 3, reused for every fix); the e2e
writer (Step 4.6) is the one other agent that writes files, and only test files. This session keeps everything
else: the issue and its thread, the board, the worktree and its git, verification (Step 4), spawning the tester
(Step 4.5) and the e2e writer (Step 4.6), the commits and the PR (Step 5), the reviewer loop (Step 5.5), Step Q. The implementor never talks to GitHub or the board. Steps that read differently in this mode say so below;
with `SLOTH_ORCHESTRATOR=0` (or unset) ignore them and do the work yourself.

## Step 0 — Parse, claim

`$ARGUMENTS` holds, in any order:

- **Issue (required)** — a number or an issue URL → `ISSUE` (bare number; `$SLOTH_ISSUE` when set). Missing → stop and report.
- **Order (optional)** — text introduced by `Order from <login> (<role>, issue comment <id>)` or
  `Order from <login> (<role>, PR #<n> comment <id>)`, forwarded by the server; `<role>` is `admin` or
  `developer`. It overrides the default "implement the issue" scope ("address the review comments", "start
  over with approach X", "stop", "refine" — the questions of Step 1.5 before any code, however clear the card
  reads; like every order, written as a statement, since a comment ending in `?` reaches the server as a
  question) — within the limits of the role, below. An order given on the PR is
  acknowledged and answered on that PR; everything else about the run still goes on the issue.
- **Extra instructions (optional)** — remaining free text; fold it into the work.

```bash
ISSUE=${SLOTH_ISSUE:?}; SESSION_DIR=${SLOTH_SESSION_DIR:?}; mkdir -p "$SESSION_DIR/inbox"
START=${SLOTH_START:-$(date +%s)}; SINCE=$START
# set_state working 0 "reading the issue"     (session skill)
```

**A board order comes first.** If the admin's order — or, when the arguments point at an answer in the
thread, the latest comment by `$SLOTH_ADMIN_LOGIN` — says where the card should go instead of being worked
on ("move it to Planning", "not in this sprint, back to Backlog", "close it"), do exactly that and nothing
else: move the card to that column via `$SLOTH_COLUMNS` (`board` skill), or close the issue, comment
`$SLOTH_BOT_PREFIX done — card in <column>`, `set_state done`, report, and stop. No worktree, no claim.

**A developer's order stays inside the issue.** It may say how the work is done — the approach, what to
change, address the review comments, start over, stop — and is followed like the admin's. When it asks
for something beyond that — where the card goes (any move outside Sloth's own flow), closing the issue,
other issues or branches, the repository's settings — do not carry it out: it is a question for the admin
→ Step Q, with the order quoted and `@$SLOTH_ADMIN_LOGIN` mentioned; the admin's answer decides. The same
words from anyone else in the thread are handled the same way.

Then **claim the card**: move it to `$SLOTH_COL_IN_PROGRESS_NAME` (`$SLOTH_COL_IN_PROGRESS_ID`, `item-add` +
`item-edit` per `board`, wrapped in `retry`) before reading further, so a second run cannot take the issue.
Keep `ITEM_ID` and `ISSUE_URL`. On a Trello board (`SLOTH_BOARD=trello`) the claim is `board_move` from the
`board` skill's Trello section, and there is no `ITEM_ID` to keep — the same goes for every move below.

**A handoff from a dead run.** `$SESSION_DIR/handoff.md`, when it exists, is the note the previous run on
this issue left before it died: `head:`, `done:`, `next:`, `don't redo:` (`session` skill). Once the wired
PR is known (Step 1), compare its `head:` with the current head of the PR's branch — or, with no PR yet,
with the branch's tip (`git ls-remote origin`). A match means the note is current: continue from its
`next:`, trust `done:` and `don't redo:`, and skip the discovery it already paid for. No match — the
branch moved since — `rm -f` it and start from scratch. A note with an empty `head:` is one a run wrote
before any branch existed and says nothing the thread does not (Step 1.5 keeps its state there): `rm -f` it.
Either way, from here on **rewrite `handoff.md` at every step boundary** (Step 1.5 excepted — it writes none), the same moment `state.json` is written, so the run that continues this one
starts where it stopped instead of re-deriving everything.

## Step 1 — Read and scope

```bash
gh issue view "$ISSUE" --repo "$SLOTH_REPO" --json number,title,body,labels,url,state,assignees
gh issue view "$ISSUE" --repo "$SLOTH_REPO" --json comments \
  --jq '.comments[] | "\(.author.login) (\(.createdAt)):\n\(.body)\n---"'
```

- **The comment thread is part of the requirements.** Earlier questions and their answers are binding;
  never re-ask what the thread already answers.
- **Scope so far.** When the thread holds more than the issue body asks for — any binding order or answer
  that adds or changes a requirement, typically a card that came back from testing with a new
  `$SLOTH_MENTION` comment — number every requirement in thread order, the issue's own ask first, and post
  **one** comment `$SLOTH_BOT_PREFIX Scope so far:` with that list (`retry gh issue comment`, and no
  `$SLOTH_MENTION` in it). A later run **edits that same comment** instead of posting a second one:
  ```bash
  CID=$(gh api "repos/$SLOTH_REPO/issues/$ISSUE/comments" --paginate \
    --jq ".[] | select(.body | startswith(\"$SLOTH_BOT_PREFIX\") and contains(\"Scope so far\")) | .id" | tail -1)
  [ -n "$CID" ] && retry gh api -X PATCH "repos/$SLOTH_REPO/issues/comments/$CID" -f body="$(cat "$SESSION_DIR/scope.md")"
  ```
  That list is the spec from here on: the tester (Step 4.5) and the reviewer loop (Step 5.5) check **every**
  item on it, not only the latest order. No comment when the issue body is the whole spec.
- **Project conventions first.** Read the repo's `CLAUDE.md` / `AGENTS.md`, the rules it points at, and the
  skills available in this session. Implement the way the project says, not the way you would by default.
- **Behaviour specs.** If the repo documents the behaviour (a `docs/` tree or equivalent), implement to
  match it. If the issue contradicts it, that is Step Q. Never edit those docs in this PR.
- **Design references.** The issue involves a design when it attaches design images, links or names a
  design file/screen, carries a design label, or says something "does not match the design". Download the
  attachments and look at them:
  ```bash
  curl -sL -H "Authorization: Bearer $(gh auth token)" "<attachment URL>" -o "$SESSION_DIR/design-1.png"
  ```
  then `Read` each file. If the project has a rule or skill for reading its design files, follow it.
- **Existing PR.** Look up the wired PR (`board`). If one is open **and it is Sloth's** (its head branch is
  `sloth/issue-$ISSUE-*`, or `state.json` names it), this run is a **review round-trip**: reuse that branch
  (Step 2), read the PR's review comments and unresolved threads, fix each one — or reply with the reasoning
  when it is wrong — and continue from Step 4. If GitHub reports the PR as conflicting with its base
  (`gh pr view <pr> --repo "$SLOTH_REPO" --json mergeable --jq .mergeable` says `CONFLICTING`, or the order
  says so), the round-trip also merges the base in: see Step 2. An open PR that is **not** Sloth's, with no
  order saying what to do about it, is Step Q.
- Locate the code with Grep/Glob/Read, or an `Explore`-style subagent on `$SLOTH_MODEL`. **Orchestrator:**
  read only what you need to brief the implementor and to judge its work — the issue, the thread, the
  project's rules, the design; locating and reading the code is the implementor's job.

## Step 1.5 — Refine: is the card buildable?

`set_state working 1.5 "refining"`. First, **where the card stands** — the thread and the body are the record,
this step writes no `handoff.md`:

- The body holds a `<!-- sloth:spec -->` block — or a `## Spec` heading Sloth wrote before the markers existed,
  signed `_Written by Sloth …_` — → refined by an earlier run; the spec is binding, read as part of Step 1.
  **Step 2.**
- `ROUNDS` = the number of Sloth comments in the thread carrying a `<!-- sloth:refine N -->` line (below).
  `ROUNDS` is 1 or 2 and someone with a role answered after the last of them → continue at item 4. No answer
  after it yet → the questions stand: park and wait as item 3 says, with no new comment.
- `ROUNDS` is 0 → decide.

Decide, from the issue and its thread, whether the card can be built **without guessing**. It can when a
developer who knows the project could start now: a bug with the steps that reproduce it or the wrong state
shown; a change whose place, scope and expected result are in the body or the thread. It cannot when a
**feature** card names the feature and little else — a title and a line; a wish without where it lives or who
uses it; a screen with no design and no copy; two readings that would lead to different code; an outcome
nobody could check. A reported bug is not refined for lacking acceptance criteria — reproducing it is the
criterion. A `refine` order (Step 0) means the questions are wanted before any code, however clear the card
reads. A review round-trip (Step 1, *Existing PR*) is never refined: a `refine` order on a card with an open
Sloth PR is answered in one comment — refine comes before code; what should change in the PR is an order on
the PR — and the round-trip goes on.

Buildable → Step 2. Otherwise, before any worktree or code:

1. **Answer your own questions first.** The code, the project's docs and behaviour specs, its rules and the
   thread settle most of them — how the neighbouring feature behaves, what the conventions require, which
   roles exist, what the design shows. Whatever they settle is not asked. **Orchestrator:** this step is this
   session's, there is no implementor yet; read the code as far as the questions need, an `Explore`-style
   subagent on `$SLOTH_MODEL` at most.
2. **Ask only what changes the code.** A question qualifies when two answers lead to two different
   implementations: "who sees this — admins only, or every member?", "an empty list: hide the section or show a
   note?", "does the export include archived items?". Never a question the conventions decide, a request for
   approval, or "should it be fast / look good". **At most 5**, the most important first, each in one or two
   lines with the options and what you would do under each when the answer is not obvious (`session` skill,
   needs-help protocol). Nothing left to ask → the card was buildable: Step 2 — under a `refine` order, after
   one comment `$SLOTH_BOT_PREFIX nothing to refine — the card is buildable as written`.
3. **Post and park** exactly as Step Q says — one comment, card to `$SLOTH_COL_NEEDS_HELP_NAME`,
   `state: waiting`, the same `$SLOTH_WAIT_HOURS` window as any question — with one line more at the end of
   the comment, before the `cc`: `<!-- sloth:refine 1 -->` (`2` for the second round; invisible on GitHub,
   it is how a later run counts the rounds). An answer inside the window continues this session, which still
   holds what it read. No answer within it → end the run as Step Q says (`set_state done Q`); the card stays
   parked at no cost, and a later answer starts a new run of this command, which comes back here — cheaper
   than keeping this one alive for a day.
4. **An answer arrived** — move the card back to `$SLOTH_COL_IN_PROGRESS_NAME` at once and
   `set_state working 1.5 "refining"` (a card left in `$SLOTH_COL_NEEDS_HELP_NAME` counts as waiting to the
   server, and the budget clock would stand still through real work); the rest of the Step Q resume is
   **silent** during refine — no `thanks — continuing`; the one comment comes with the spec (item 5). Re-read
   the whole thread. The answers may open new questions
   — **one more round at most** (`ROUNDS` was 1), asked as item 3 says with `<!-- sloth:refine 2 -->`, and only
   about what the answers brought up. After the second round nothing is asked again here: what is still open
   goes into the spec under **Open**, the work starts on what is settled, and the point comes up as an
   ordinary Step Q question when the code reaches it. Never decide it yourself.
5. **Write the spec into the issue body** — always, once the questions have their answers, whatever the
   card now looks like: the tester and the reviewer hold the work to it. Write this section to
   `$SESSION_DIR/spec.md`, the marker lines included:

   ```markdown
   <!-- sloth:spec -->
   ## Spec
   _Written by Sloth from the thread on <date>; the answers in the thread are binding._

   **Goal** — one line: who gets what.
   **Scope** — the changes, one line each.
   **Out of scope** — what the thread said no to, what stays as it is.
   **Acceptance criteria**
   - [ ] one checkable statement each — the tester confirms every box, the reviewer holds the diff to them
   **Edge cases** — empty states, permissions, errors, concurrency, each with its expected behaviour.
   **Design** — the links or attachments that are the spec for the screens, when there are any.
   **Open** — what the two rounds left undecided, when anything; asked again when the code reaches it.
   <!-- /sloth:spec -->
   ```

   Then append it to the body, keeping everything above and outside Sloth's own block as it is — a heading a
   human wrote is theirs, only the block between the markers is replaced — and never on a read that failed:

   ```bash
   [ -s "$SESSION_DIR/spec.md" ] || { echo "spec.md missing"; exit 1; }     # never push a body without it
   BODY=$(retry gh issue view "$ISSUE" --repo "$SLOTH_REPO" --json body --jq .body) || { echo "body unread — spec not written"; exit 1; }
   printf '%s\n' "$BODY" | tr -d '\r' >"$SESSION_DIR/body.md"
   if grep -qx '<!-- sloth:spec -->' "$SESSION_DIR/body.md" && grep -qx '<!-- /sloth:spec -->' "$SESSION_DIR/body.md"; then
     awk '/^<!-- sloth:spec -->$/{skip=1} !skip{print} /^<!-- \/sloth:spec -->$/{skip=0}' "$SESSION_DIR/body.md" >"$SESSION_DIR/body.tmp" \
       && mv "$SESSION_DIR/body.tmp" "$SESSION_DIR/body.md"     # both markers, or the body is kept whole
   fi
   printf '\n' >>"$SESSION_DIR/body.md"; cat "$SESSION_DIR/spec.md" >>"$SESSION_DIR/body.md"
   retry gh issue edit "$ISSUE" --repo "$SLOTH_REPO" --body-file "$SESSION_DIR/body.md"
   ```

   A failed read or edit is Step Q — the spec goes into the question comment so nothing is lost — not a
   guess. On a Trello board (`SLOTH_BOARD=trello`) the people read the card, not the issue: post the spec as
   a comment too, `$SLOTH_BOT_PREFIX Spec:` followed by the same section — the one comment the `session`
   skill allows past five lines; the mirror copies it onto the card.

Then one comment `$SLOTH_BOT_PREFIX spec written into the issue — building`, the budget recomputed as the
`session` skill says (the card is already in `$SLOTH_COL_IN_PROGRESS_NAME`, item 4) — and on to Step 2.
**From here the spec is the requirement list**: Step 3 builds it and nothing beyond it, the tester (Step 4.5)
confirms every acceptance criterion, the reviewer loop (Step 5.5) and the server's review hold the diff to
them, and the PR's `## Why` refers to them. The `Scope so far` comment of Step 1 is written in addition only
when an order later adds to the spec.

## Step 2 — Reset the worktree slot to the default branch

`$SLOTH_WORKTREE` is a worktree Sloth leased to this run from its pool — a checkout an earlier run used,
kept so its installed dependencies carry over. Reset it to a fresh branch; never create or remove a worktree.

```bash
BASE=$(gh repo view "$SLOTH_REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
BRANCH="sloth/issue-$ISSUE-<kebab-slug>"
WT="$SLOTH_WORKTREE"
git -C "$WT" fetch origin "$BASE"
git -C "$WT" checkout -q --ignore-other-worktrees -B "$BRANCH" "origin/$BASE"
git -C "$WT" clean -fdx -e node_modules -e .turbo -e .venv -e .cache   # the previous run's files go; dependencies and caches stay
cd "$WT"
```

For a review round-trip check the PR's branch out instead: `git -C "$WT" fetch origin "$BRANCH" &&
git -C "$WT" checkout -q --ignore-other-worktrees -B "$BRANCH" "origin/$BRANCH"`, then the same `clean`.
A PR that conflicts with its base is merged up to date here, before any other change: `git -C "$WT" fetch
origin "$BASE" && git -C "$WT" merge --no-edit "origin/$BASE"`, then resolve every conflicted file keeping
what both sides meant — the base's change and the branch's — and commit the merge. **Merge only**: never
rebase the branch and never force-push, the PR's review comments are pinned to its commits. A conflict you
cannot resolve without guessing is Step Q.
From here on work **only inside `$WT`** — never the checkout at `$SLOTH_RUNNER_ROOT`, never another slot.

Install dependencies the way the repo does — `CLAUDE.md` wins; otherwise detect from the lockfile:
`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`,
`package-lock.json` → `npm ci`, `bun.lockb` → `bun install`, or the language's equivalent
(`uv sync` / `poetry install` / `pip install -e .`, `go mod download`, `bundle install`, `cargo fetch`).
No manifest → nothing to install. In a reused slot this is seconds when the lockfile is unchanged — but
then the install runs **no `postinstall`**, so run the project's generate steps yourself (a Prisma client,
GraphQL or API codegen: whatever `CLAUDE.md` or the manifests' `postinstall` / `generate` scripts name),
or the slot serves code generated for the branch the last run was on. **Install once per run**: re-run it
only when the lockfile changed since — a "Lockfile is up to date" install is a minute wasted.

## Step 3 — Implement

Scope tightly to the issue plus any order or extra instructions. Follow the project's rules and conventions
exactly. Do not add tests unless the issue asks or the repo requires them with the change.

**No code comments.** Write no comment in any file you touch — no line comment, no block comment, no
docstring, no JSDoc, no commented-out code, no `TODO` — and remove the ones you would have written. The
code says what it does through its names: a variable named for what it holds (`retryDelayMs`, not `d`), a
function named for what it does (`isExpired(token)`, not `check(t)`), a boolean that reads as a fact
(`hasUnsavedChanges`), a magic number bound to a named constant (`MAX_REVIEW_ROUNDS = 4`). When a stretch
of code needs explaining, split it into a well-named function instead of annotating it. The only exceptions
are the ones the file cannot do without: a directive the toolchain reads (`// eslint-disable-next-line`,
`# type: ignore`, `"use client"`, a shebang, a licence header the repo already carries) and comments the
project's own `CLAUDE.md` explicitly requires. An existing comment in code you did not otherwise change
stays — no drive-by deletions.

**Name the cause of a reported bug** — where in the code it is and why it breaks — in your notes and the
PR's `## Why`, never as a comment in the code, before fixing it. When the order, the extra instructions
or the fix you chose remove the symptom and leave that cause standing, carry it into the PR's `## Why` as
one line — `Root cause left: <what it is, what still breaks because of it>`. The order stands: this is a
statement in the PR, not a Step Q question. Never ship a symptom fix silently.

**A referenced design is the spec** — not the issue text, not the current screen. Reproduce every value:
layout, spacing, sizes, colors, typography, radii, borders, icons, copy, and each state shown. Reuse the
project's design tokens and components; where none matches, use the design's exact value. Before Step 5,
walk the design node by node against your markup and **name each value you matched** — any difference is a
bug to fix, not a note. That written comparison becomes the PR's `## Design fidelity`. A design you cannot
reach (missing asset, contradictory, screen absent) is Step Q, not a PR.

### Step 3, orchestrator — the implementor subagent

Spawn **one** implementor subagent (`Agent`, `subagent_type: "general-purpose"`,
`model: "$SLOTH_IMPLEMENTOR_MODEL"`, `run_in_background: false`) and **reuse it for every later change**
via `SendMessage` — a Step 4 failure, a tester finding, a reviewer finding, a review round-trip's comments,
an order that changes the scope. Never a fresh implementor per fix: it already holds the code in context.

Its brief carries everything it cannot read for itself, and nothing it can:

- the worktree `$WT` — it works only there, on the branch already checked out, and never touches
  `$SLOTH_RUNNER_ROOT`, a shared database or a port another session uses;
- the issue's number and title, its body — the `## Spec` section included, when Step 1.5 wrote one: it is
  the requirement list — and the binding parts of the thread (answers, orders, extra instructions), quoted —
  it has no `gh` access to the issue and must not use any;
- the paths of any downloaded design files, and that the design is the spec (the paragraph above);
- where the project's rules are (`CLAUDE.md` / `AGENTS.md`, the rules and skills they point at) — it reads
  and follows them itself;
- the scope: tightly the issue, no unrelated cleanup, no tests unless the issue or the repo asks;
- **no code comments** — the rule above, quoted in full: names carry the meaning, a stretch that needs
  explaining becomes a well-named function, only toolchain directives and comments the project's
  `CLAUDE.md` requires are allowed;
- the time it has: `$SLOTH_DEADLINE` minus what Steps 4–6 need (`session` skill);
- what to return: the files changed and why, on a reported bug where in the code its cause is and whether
  the change removes it, the exact checks it ran (the repo's `test` / `lint` / `build` / `typecheck` scripts scoped to
  its change, per Step 4) with their outcome, the design-fidelity walk when
  there is a design, and anything it could not do or found ambiguous — **as a question for you, never a
  guess**. It writes no commits, no comments, no PR, no board moves: those are yours.

Read its report, not its transcript. A failed check it could not fix, or a question it raised, is your Step
Q — with the implementor's words, not a paraphrase. An answer from the thread goes back to it verbatim.

## Step 4 — Verify

Run what the project declares, in this order of preference:

1. **A project skill that runs or verifies the app.** Check the skills available in this session for one
   that brings the app up (a dev-environment / run / demo skill). Use it, then drive the exact behaviour the
   issue describes and confirm it works and the old behaviour is gone. Record every pid it starts into
   `$SESSION_DIR/dev.pid` / `redis.pid` and any database name into `$SESSION_DIR/demo.db`, and set
   `SERVERS=running` in `state.json` — the server cleans these up.
2. **Otherwise the repo's declared checks**: the `test`, `lint`, `build`, `typecheck` scripts in
   `package.json` (or `Makefile` / `pyproject.toml` / `go test ./...` / `cargo test`), scoped to what you
   changed. Then exercise the change as far as the session allows — `curl` the endpoint, query the database,
   run the CLI, read the rendered markup from the dev server, drive a headless browser if one is installed.

**A warm stack** (`SLOTH_WARM=1`, `session` skill): the slot's servers, Redis and database from the
previous run are already up — their pids and name already in `$SESSION_DIR`. Skip createdb, redis-server,
the build and the server starts: sync the schema onto the existing database, reseed, `FLUSHALL` Redis —
the watch-mode servers pick your checkout up themselves. `SLOTH_WARM_SAME=1` (a retry on the same head):
skip even that and go straight to the behaviour. A reset step fails → kill the pids in
`$SESSION_DIR/dev.pid` / `redis.pid` yourself and boot cold as the run skill says.

**Do not repeat work.** While the dev servers run in watch mode, never build just to check — the watcher
recompiles on save; read its output instead. When a build or typecheck *is* needed, scope it to what
changed (`turbo … --filter=<pkg>`, the package's own script), never the whole repo.

Record the exact commands and their output: they become the PR's `## Verification`, which states precisely
**what was verified and what was not**. A failing check you cannot fix is Step Q — do not push over it.

**Orchestrator:** the declared checks (2) are the implementor's — take them from its report and do not
re-run them unless the report is missing one. Bringing the app up and exercising the behaviour (1) is yours:
that is how you judge the work. Anything that fails goes back to the implementor via `SendMessage` — the
failing command and its output verbatim — and it reports again; you never patch it yourself.

## Step 4.5 — Test it in the browser (tester subagent)

When `SLOTH_CHROME=1` and the change has a screen a user can reach, spawn **one** tester subagent
(`Agent`, `subagent_type: "general-purpose"`, `model: "$SLOTH_TESTER_MODEL"`, `run_in_background: false`) and
reuse it for every re-test via `SendMessage`. The app is already up from Step 4: give the tester its URL,
how to log in (from the project's run skill), the exact behaviour the issue describes, the old behaviour that
must be gone, every numbered item of the *Scope so far* list when Step 1 wrote one, and
`$SLOTH_SCREENSHOTS_DIR`. Its task:

1. Load the browser tools with **one** `ToolSearch` call for the `browser_*` Playwright tools:
   `browser_navigate, browser_snapshot, browser_click, browser_type, browser_fill_form, browser_press_key,
   browser_select_option, browser_wait_for, browser_take_screenshot, browser_console_messages,
   browser_network_requests, browser_handle_dialog, browser_close`. If they are missing, report
   `browser tools unavailable` and stop — Step 4 stays the verification.
2. The browser is **this session's own** headless Chrome: an empty profile, nobody else in it, nothing logged
   in. Log in the way the run skill says. Act from `browser_snapshot` refs (`[ref=eN]`), never from pixels; a
   `confirm` / `alert` is answered with `browser_handle_dialog`, not avoided.
3. Drive the issue's behaviour as the user would: the new behaviour works, the old one is gone, the
   surrounding flow still works, and every item of the *Scope so far* list, not only the newest one. After
   each screen read `browser_console_messages` and `browser_network_requests`; uncaught exceptions and
   failed app requests are findings.
   **The issue's own subject goes through every new mode the change adds** — the entity, type, value or
   state named in its title, paired with each other kind that carries its own fields: a field made
   multi-select is driven with the issue's own value plus each other value that has a section of its own,
   never two unrelated values.
4. **Screenshot every screen it verifies** — `browser_take_screenshot` with
   `filename: "$SLOTH_SCREENSHOTS_DIR/NN-<kebab-what>.png"`: an **absolute** path (a relative one lands in the
   process's working directory, where nothing will find it), a two-digit order, then lowercase letters, digits
   and dashes only. The screen the issue is about in its new state, each state the issue names, and the flow
   around it — at least one, rarely more than six. One screenshot per state, not one per click.
5. `browser_close`. Return raw data: the steps taken, pass / fail for each, every finding with what was seen,
   what could not be tested and why, and the list of screenshot files, each with a one-line caption saying
   what it shows.

A finding is a bug: fix it (**orchestrator:** hand it to the implementor verbatim), re-run the affected
checks of Step 4, and ask the tester to re-test — **and to re-screenshot what changed**, deleting the stale
PNGs first (`rm -f`) so the set in `$SLOTH_SCREENSHOTS_DIR` is only what is true now.

**Then stop the app** — after Step 4.6 when it runs, since the tests run against this app — unless `SLOTH_PREVIEW_HOURS` is above `0`, when it stays up for the hand-off in
Step 6, or `SLOTH_WARM_SLOTS=1`, when it stays up for the next run to inherit (`session` skill). The dev
servers are the run's biggest cost in memory, and the commit, the PR and the reviewer rounds
do not need them: kill every pid in `$SESSION_DIR/dev.pid` and `redis.pid` (their process groups too —
`kill -- -<pid>` then `kill <pid>`), empty both files, `SERVERS=stopped`. Keep the database. A re-test in
Step 5.5 or a rerun of the e2e file brings the app back up the same way, on the same database. Its report is the
browser part of the PR's `## Verification`; its files become the PR's `## Screenshots` (Step 5). A tester that
cannot reach the screen at all is a failed Step 4 (Step Q when you cannot fix it). Skip this step only when
the change has no screen — an API-only fix, a script — and say so in the PR.

## Step 4.6 — E2E tests from the criteria (e2e-writer subagent)

Runs when **all** of: `SLOTH_E2E=1`; the change has a flow a browser can drive (not an API-only fix, not a
script); Step 4.5 passed, or did not run because `SLOTH_CHROME=0` — the writer drives Playwright's own
browsers, not the tester's Chrome. Otherwise the PR's E2E line says why (below) and Step 5 follows.
`set_state working 4.6 "writing e2e tests"`.

**Before any spawn, two checks of your own:**

1. **The project has Playwright.** `Glob` for `playwright.config.*` from `$WT`, ignoring `node_modules`,
   `dist`, `build`, `.venv`. None → the line is `skipped — no Playwright setup`; Sloth adds no test
   framework to a project. Several → the one whose directory's `package.json` has a `test:e2e`-style
   script, else the one nearest the code that changed.
2. **The clock** (`session` skill). The writer needs time to write, to run, and to rerun once; without
   that plus Steps 5–6, the line is `skipped — out of time`.

Then spawn **one** e2e-writer subagent — `Agent`, `subagent_type: "sloth:e2e-writer"` (the agent this plugin
ships, `agents/e2e-writer.md`: its rules live there, not here), `model: "$SLOTH_E2E_MODEL"`,
`run_in_background: false` — and reuse it via `SendMessage` for every rerun. It runs **while the app from
Step 4 is still up** and only against that app: it never boots one. Its brief carries what it cannot read
for itself:

- the worktree `$WT` — it writes only test files there, on the branch already checked out — and the path
  of the Playwright config you found;
- the app's URL and how to sign in as each role the criteria name (from the project's run skill);
- the issue's number and title, and the **criteria**: the boxes under *Acceptance criteria* of the `## Spec`
  when Step 1.5 wrote one, quoted one per line; otherwise the behaviour the issue describes as a user sees
  it — one line per thing a user can see, the *Scope so far* items included. Nothing taken from the code;
- the time it has, in minutes;
- what to return: its case list, the files, the run command with its outcome, the findings, what it needs
  from the app, what it could not do. It commits nothing and never talks to GitHub or the board.

Read its report, not its transcript:

- A **finding** — a red test where the app does not do what a criterion says — is a bug in the change, not
  in the test: fix it (**orchestrator:** the implementor, the finding verbatim), re-run the Step 4 checks it
  touches, then `SendMessage` the writer to rerun its file. A criterion the change was never meant to meet
  is a scope question → Step Q with the criterion quoted, never a deleted test.
- **Needs from the app** — a test id, a seed the suite lacks — is a small change to the code: make it
  (**orchestrator:** the implementor), then the writer reruns. A `data-testid` for a test is in scope.
- **`could not run`** — the app stopped answering, browsers that will not install — is not a finding
  against the change: bring the app back (as Step 4 does) and ask for a rerun once; still not running →
  the line is `skipped — could not run: <the writer's reason>` and the tests stay in the commit, unrun.
- *Not testable end-to-end* items get their own line under the E2E line, as written.

Before Step 5 confirm the writer added nothing but spec files and helpers: `git status` shows no
`playwright.sloth.config.*` (the writer deletes it after its run), no Playwright output (its `outputDir` is
under `$SESSION_DIR`), no edit of its own under the application's source. The worktree also holds the
code changes from Step 3, which are expected. The test files are **part of the change**: same commit as the code, never a second PR.

**The reasons** an E2E line can give, when no tests were written: `skipped — no flow to drive`,
`skipped — no Playwright setup`, `skipped — out of time`, `skipped — could not run: <why>`.

## Step 5 — Commit, push, draft PR

Commit in the repo's style — `CLAUDE.md`'s convention if it defines one, otherwise `fix: <what changed>`.
Then:

```bash
git push -u origin "$BRANCH"
# with PNGs in $SLOTH_SCREENSHOTS_DIR — publish_shots is in the `session` skill; not into $BASE, that is the base branch
SHOTS=$(publish_shots "$SLOTH_SCREENSHOTS_DIR")
gh pr create --repo "$SLOTH_REPO" --base "$BASE" --head "$BRANCH" --draft \
  --title "<type>: <what changed>" --body-file "$SESSION_DIR/pr-body.md"
```

Body: exactly this shape, in this order, nothing before `Closes` and no section that is not listed here.
It is read by a reviewer and by the person who tests the card, on a phone as often as not — **under 40
lines** all told, one fact per line, no narration of the steps you took, no walk through the diff file by
file, no restating of the issue.

```markdown
Closes #ISSUE

## Why
<1–3 lines: the root cause, or what was missing>
Root cause left: <what it is, what still breaks>          # only when the fix removes the symptom and leaves the cause (Step 3)

## What changed
- <one line per change a reviewer has to know about — at most 6>

## Verification
- `<command>` → <what it showed, in a few words>            # one line per Step 4 check
- Tester (`$SLOTH_TESTER_MODEL`): <passed|N findings, all fixed> — <what was driven, every *Scope so far* item named>   # or: skipped — no screen
- E2E (`$SLOTH_E2E_MODEL`): <N tests for N criteria, all passing> — `<spec file>`    # or: skipped — <reason from Step 4.6>; always present
- Not testable end-to-end: <the criteria, and why>                     # only when the writer listed any
- Reviewer (`$SLOTH_REVIEWER_MODEL`): passed on round <N> of `$SLOTH_REVIEW_ROUNDS`
- Not verified: <what, and why>                                # or the single word `nothing`

## Screenshots
<see below>

## Design fidelity
<only for a design-driven fix: the written comparison from Step 3>
```

The tester, E2E and reviewer lines name the **subagent and the model it ran on** — a human reading the PR
sees who checked what; **orchestrator:** add `- Implementor (`$SLOTH_IMPLEMENTOR_MODEL`)` above them.
Write the reviewer line after Step 5.5 and re-edit the body then (`gh pr edit`). **No reviewer request, no
assignee** — a human picks it up from the board. Record `PR` / `PR_URL` in `state.json`.

The `E2E` line is **never absent** either, whatever the switch: `skipped — e2e off` with `SLOTH_E2E=0`, one of
Step 4.6's reasons, or the count. A reader then knows whether tests were ever in question.

`## Screenshots` is **never absent**. One of three:

- The tester saved PNGs — one `![<caption>]($SHOTS/<file>?raw=true)` per screenshot, in file order, with its
  caption from Step 4.5 as the line above the image or as the alt text. Never a file that was not taken.
- The change has no screen (API-only, a script) — the single line `No screen changed — nothing to show.`
- `SLOTH_CHROME=0`, no browser was attached — the single line `No browser attached to this session.`

## Step 5.5 — Reviewer-agent loop (max `$SLOTH_REVIEW_ROUNDS`)

Spawn **one** reviewer subagent (`Agent`, `model: "$SLOTH_REVIEWER_MODEL"`, `run_in_background: false`) and **reuse
it every round** via `SendMessage` — never a fresh reviewer per round. Its task: run
`/sloth:review <PR_URL> feedback-only` exactly as that command says (no PR comments, no board moves) and
report the verdict block verbatim. With a *Scope so far* comment on the issue (Step 1), say so in its task:
every numbered item on that list is a requirement, not only the latest order.

1. Round 1 via `Agent`; later rounds via `SendMessage`: "The PR has been updated — re-run the feedback-only review".
2. `OK to merge: yes` → Step 6.
3. Otherwise fix every bug and unmet requirement it lists (**orchestrator:** send the verdict block to the
   implementor verbatim and wait for its report), re-run Step 4, commit, push. Re-run the
   behavioural part of Step 4 and the tester (Step 4.5) only when the behaviour they exercised changed; the
   e2e writer (Step 4.6) reruns its file whenever the code it drives changed, and a criterion the reviewer
   adds gets its test the same way. Either rerun needs the app: bring it back up first, as Step 4 does — the
   app was stopped after Step 4.6 unless a warm slot or a preview keeps it. A changed test count or spec file
   is re-written into the E2E line of the body, like the screenshots below.
   When a fix changed **what a screen shows**, the tester re-screenshots it, the new set is published again
   (`SHOTS=$(publish_shots "$SLOTH_SCREENSHOTS_DIR")`, `session` skill — it writes a fresh timestamped
   directory) and the PR body is re-written to those URLs:
   `gh pr edit "$PR_URL" --body-file "$SESSION_DIR/pr-body.md"`. A body left pointing at the old set is wrong.
4. `$SLOTH_REVIEW_ROUNDS` rounds without a pass → Step Q with the remaining findings; the PR stays a draft.

Check the clock before each round (`session` skill). Without time for a round plus Step 6, go to Step Q.

## Step 6 — Ready for review → Code Review

The move is conditional: somebody may have decided about this head or this card since you last looked.
Read both before writing anything — the server's review leaves its verdict on the PR, on the very commit
it read, and a person moves cards by hand:

```bash
retry gh pr ready "$PR_URL"
HEAD=$(git rev-parse HEAD)
REJECTED=$(gh api "repos/$SLOTH_REPO/pulls/$PR/reviews" --paginate | jq -rs --arg bot "$SLOTH_BOT_PREFIX" --arg sha "$HEAD" \
  '[.[][] | select(.commit_id == $sha and (.body | startswith($bot)))] | last | (.body // "") | test("Review: \\*\\*failed\\*\\*")')
COLUMN=$(gh api graphql -f query="{ repository(owner: \"${SLOTH_REPO%/*}\", name: \"${SLOTH_REPO#*/}\") { issue(number: $SLOTH_ISSUE) {
  projectItems(first: 10) { nodes { project { number } fieldValueByName(name: \"Status\") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }" \
  --jq ".data.repository.issue.projectItems.nodes[] | select(.project.number == $SLOTH_PROJECT_NUMBER) | .fieldValueByName.name")
# Trello: COLUMN=$(curl -s "$SLOTH_BOARD_API/card/$SLOTH_ISSUE" | jq -r '.column // empty')
```

- `REJECTED` is `true` → the server's review already failed this head. **Do not move the card**: its findings
  are on the PR as review comments — take them as a review round (Step 5.5, item 3: fix, verify, push) and come
  back to this step with the new head. Writing Code Review over that verdict once left a rejected head marked
  as reviewed, in a column that never launches anything.
- `COLUMN` is neither empty nor `$SLOTH_COL_IN_PROGRESS_NAME` → a person moved the card meanwhile. Leave it
  where it is and say so in the report; the newer decision wins.
- Otherwise:

```bash
retry gh project item-edit --id "$ITEM_ID" --project-id "$SLOTH_PROJECT_ID" \
  --field-id "$SLOTH_STATUS_FIELD_ID" --single-select-option-id "$SLOTH_COL_CODE_REVIEW_ID"
# Trello: board_move "$SLOTH_ISSUE" "$SLOTH_COL_CODE_REVIEW_NAME"
```

The server reviews the PR there (`/sloth:review … final`, another agent on its own model) — it waits for this
session to end first, so the card has one owner at a time — and moves the card on: to `$SLOTH_COL_APPROVED_NAME`
for a human to test, or back to `$SLOTH_COL_IN_PROGRESS_NAME` with the findings as review comments — a new
run of this command then addresses them (Step 1, *Existing PR*). Never move the card to
`$SLOTH_COL_APPROVED_NAME` yourself.

With `SLOTH_PREVIEW_HOURS` above `0`, hand the running app over too: write `preview.json` as the **`session`**
skill's *Teardown* says — the app's one local URL and how to sign in, both from the project's run skill — and
leave the servers, database and worktree up. The server tunnels the app, posts the link on the PR and cleans up
after `SLOTH_PREVIEW_HOURS` hours. A project whose app cannot answer on one port gets no preview: tear down in Step 7.

## Step Q — Ask on the issue, then wait

Follow the needs-help protocol in the **`session`** skill: one numbered comment with every open question and
the done / left summary, card to `$SLOTH_COL_NEEDS_HELP_NAME`, `state: waiting`, wait up to
`$SLOTH_WAIT_HOURS` (inbox every minute, thread every 10), stop this session's servers after 30 idle
minutes but keep the code, resume with `max(remaining, 30 min)` when an answer arrives, exit after the
wait window. Never open or finish a PR built on a guess.

## Step 7 — Clean up, report

Teardown per the `session` skill: with `SLOTH_WARM_SLOTS=1` leave the servers and database running —
the server keeps them warm for the next run; otherwise stop this session's processes (if any are still
up) and drop its database. Either way `set_state done`; the worktree slot stays for the server to
return. After a preview hand-off (Step 6) skip the stopping and removing — only `set_state done`
with `SERVERS=preview`; the server takes the environment down later. The branch stays on the remote.
Delete `$SESSION_DIR/handoff.md` — a finished run leaves no handoff.

Finish with the report — it is the transcript's last message and the monitor shows it: branch, PR URL, files
changed, what Step 4 and the tester verified and what they did not, how many screenshots the PR carries, the e2e
tests written and their run, review rounds, where the card ended up. For a blocked run:
the question comment URL, whether an answer arrived, where the card is, and what is left.

## Rules

- **Fully autonomous** — never ask in chat, never guess; when blocked, Step Q and wait.
- **A card that cannot be built without guessing is refined first** (Step 1.5): the questions that change the
  code, at most five, at most two rounds, then a `## Spec` in the issue body that the tester and the reviewer
  hold the work to. No code before it.
- **Respect `$SLOTH_DEADLINE`** and keep `state.json` current; the server kills stale `working` sessions.
- **Check the inbox at every step boundary.** Orders override everything here — the admin's without limit, a
  developer's within the issue (`session` skill).
- Every comment starts with `$SLOTH_BOT_PREFIX`; **never write `$SLOTH_MENTION` in your own comments.**
  The tester runs on `$SLOTH_TESTER_MODEL`, the reviewer on `$SLOTH_REVIEWER_MODEL`, the implementor (orchestrator
  mode only) on `$SLOTH_IMPLEMENTOR_MODEL`, the e2e writer (`SLOTH_E2E=1` only) on `$SLOTH_E2E_MODEL`, any other
  subagent on `$SLOTH_MODEL`.
- **Orchestrator mode never edits code in this session**: one implementor subagent, spawned once and reused,
  makes every change to the application's code, and the e2e writer alone adds test files; this session reads,
  verifies, tests, reviews, commits, and talks to GitHub and the board.
- **The comment thread is part of the spec** — never re-ask what it answers.
- **A referenced design is matched exactly**; a difference is a bug, an unreachable design is a question.
- **A PR that changes a screen shows it**: the tester's screenshots, pushed with `publish_shots`, in
  `## Screenshots`. Never a screenshot that was not taken.
- **Never touch the checkout at `$SLOTH_RUNNER_ROOT`, a shared database, or a port another session uses.**
- **Test in the browser when there is one** (Step 4.5): the tester subagent's run — and a PNG of every screen
  it verified — is part of every PR that touches a screen.
- **With `SLOTH_E2E=1` the criteria get tests** (Step 4.6): one Playwright test per acceptance criterion, written
  by the e2e-writer agent into the project's own suite, run against the session's app, committed with the code.
  A red test is a bug in the change until the criterion itself is in question.
- Do not push on a failed Step 4; do not hand a PR over before the reviewer loop passes; the PR ends
  ready for review, with `Closes #ISSUE`, no reviewer and no assignee.
- Always clean up (Step 7), whether the run succeeds, waits out, or stops early — a preview hand-off (Step 6)
  is the one ending where the server cleans up instead.
