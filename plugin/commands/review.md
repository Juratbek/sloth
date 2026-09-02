---
description: Assess a PR against its wired issue — does it resolve it, is it safe to merge, does it add bugs or unnecessary changes — rate it 0–10, comment inline on the findings, and move the wired issue back to In Progress; in final mode the verdict is always posted on the PR, and a pass labels the issue `Fable: approved` and moves its card to Approved for a human to test
argument-hint: <PR number or URL> [feedback-only|final]
allowed-tools: Bash, Read, Grep, Glob, Skill, ToolSearch
---

# Review a PR against its wired issue

Assess the PR in `$ARGUMENTS` (a PR URL or a bare number in `$SLOTH_REPO`; `$SLOTH_PR` when set) and produce
the fixed-format verdict below. When the assessment finds something, leave inline review comments on the PR
and move its wired issue back to `$SLOTH_COL_IN_PROGRESS_NAME`. Never change code, never approve or request
changes, never close the issue, never merge.

Ids, the wired-PR query and `retry` come from the **`board`** skill; comment conventions from the
**`session`** skill.

## Feedback-only mode

If `$ARGUMENTS` contains `feedback-only`, this review runs inside the autonomous fix loop
(`/sloth:implement` Step 5.5): the implementer fixes what you report and asks you again. In this mode
**skip Steps 4 and 5 entirely** — post nothing on the PR, move nothing on the board — and return only the
Step 6 block, with every bug and unmet requirement as a bullet inside it so the implementer can act. When
re-asked on the same PR, **re-read the diff** (`gh pr diff`) — it has changed — and judge the new state, not
your memory of the old one.

## Final mode

If `$ARGUMENTS` contains `final`, this is the server's review of a card in `$SLOTH_COL_CODE_REVIEW_NAME`
(trigger 4): the PR was handed over — by the implement session after its own reviewer loop, or by the human
who wrote it — and this is the independent look it gets before a human tests it. Nobody reviews it after
you: what you pass goes to `$SLOTH_COL_APPROVED_NAME` and a person tries it from the preview link. Everything
else applies unchanged, plus three things: Step 4 **always** submits the review, pass or fail, with the verdict
in its body; Step 5 moves the card on a pass too — to `$SLOTH_COL_APPROVED_NAME`; and Step 5.5: the wired issue
carries the label **`Fable: approved`** exactly when this review passed.

## 1. Resolve the PR and its wired issue

```bash
gh pr view <N> --repo "$SLOTH_REPO" \
  --json number,title,body,state,isDraft,baseRefName,headRefName,closingIssuesReferences
```

`closingIssuesReferences` is the **only** source of the wired issue — never guess it from the title or the
branch name. No wired issue → say so, assess mergeability, bugs and scope only, answer "Resolves the issue"
with `no wired issue`, and skip the board move (still leave the comments).

```bash
gh issue view <issue> --repo "$SLOTH_REPO" --json title,body,comments
```

The issue's comment thread carries requirements too — read it, not just the body.

## 2. Read the diff

```bash
gh pr diff <N> --repo "$SLOTH_REPO"
gh api "repos/$SLOTH_REPO/pulls/<N>/files" --paginate     # the line map for inline comments
```

Read the surrounding files for context; checking the branch out is only needed when the diff alone is
ambiguous.

## 3. Assess

1. **Issue resolution** — does the diff implement what the issue asks? Check every requirement and
   acceptance criterion in the body *and* the thread, not just the headline.
2. **Merge safety / new bugs** — defects the diff introduces: logic errors, missed edge cases, broken
   callers, security or tenant-scoping leaks, missing cache invalidation, non-atomic multi-step writes, and
   **violations of the project's own rules** — read the repo's `CLAUDE.md` / `AGENTS.md` and the rule files
   relevant to the changed code before citing one. A divergence from the project's documented behaviour is a
   bug.
3. **Scope** — changes unrelated to the wired issue: drive-by refactors, formatting churn in untouched code,
   features nobody asked for. A small refactor that directly enables the fix is fine, not "unnecessary".
4. **Checks** — `gh pr checks <N> --repo "$SLOTH_REPO"`; a failing required check is a bug: "OK to merge" is
   no. Say which check failed and why in the review body; a check still running is not a failure.
5. **Proof** — for a PR on a `sloth/issue-*` branch (Sloth's own): if the diff changes what a user sees —
   screens, components, templates, styles, copy — the body must have a `## Screenshots` section with at least
   one image per changed screen, each linking under `https://github.com/$SLOTH_REPO/blob/$SLOTH_ASSETS_BRANCH/`.
   Check one is really there:
   ```bash
   gh api "repos/$SLOTH_REPO/contents/<path>?ref=$SLOTH_ASSETS_BRANCH" --jq .sha    # a 404 is a dead image
   ```
   A missing section, `No screen changed` on a diff that clearly changes one, or a dead image is an **unmet
   requirement**: "OK to merge" is no. `No browser attached to this session.` is accepted as written. On a PR
   from any other branch screenshots are welcome, never required.

## 4. Comment on the PR — whenever "OK to merge" is no, and always in final mode

Clean and resolves its issue, **not** in final mode → submit nothing; the verdict block is the whole output.

Otherwise submit **one** review with `event: "COMMENT"`: an inline comment per bug, plus a body bullet per
unmet requirement. In final mode the body opens with the verdict, so whoever follows the card sees the
result on the PR — a pass has no inline comments and an empty `comments` array.

```bash
cat > /tmp/sloth-review-<N>.json <<'EOF'
{
  "event": "COMMENT",
  "body": "<one line: how many bugs — plus a bullet per unmet requirement, if any>",
  "comments": [
    { "path": "src/foo/foo.ts", "line": 42, "side": "RIGHT",
      "body": "<the problem, the rule it breaks if any, and the fix>" }
  ]
}
EOF
retry gh api "repos/$SLOTH_REPO/pulls/<N>/reviews" --method POST --input /tmp/sloth-review-<N>.json
```

Body in final mode — the first line is `$SLOTH_BOT_PREFIX`, the second the verdict, then the findings:

```
**Sloth:**
Review: **passed** — <rating>/10, resolves #<issue>, no new bugs. Labelled `Fable: approved`; card in <Approved column name>, ready for a human to test.
```

```
**Sloth:**
Review: **failed** — <rating>/10. <how many bugs>; card back to <In Progress column name>.
- <unmet requirement, where it is missing>
```

- `line` is the **new-file** line number and must fall inside a diff hunk, or GitHub rejects the whole
  review. Use `"side": "LEFT"` with the old-file line for a removed line; add `"start_line"` +
  `"start_side"` for a range.
- A bug that cannot be tied to a diff line goes as a body bullet naming the path. So does every unmet
  requirement — name it from the issue and say where it is missing. Never invent a diff line.
- One comment per bug: the problem, the rule when it is a convention violation, the fix. No praise, no nits,
  no restating what the code does.
- Never `APPROVE`, never `REQUEST_CHANGES`. First line of the review body is `$SLOTH_BOT_PREFIX`.

## 5. Move the wired issue — whenever "OK to merge" is no, and on a pass in final mode

New bugs, or the PR does not resolve its issue, or both → move that issue's card to
`$SLOTH_COL_IN_PROGRESS_NAME` (`board` skill: single-issue read for `ITEM_ID`, then `item-edit` with
`$SLOTH_COL_IN_PROGRESS_ID`). Not on the board, or already there → leave it and note that in the report.

Final mode, "OK to merge" **yes** → move it to `$SLOTH_COL_APPROVED_NAME` the same way, with
`$SLOTH_COL_APPROVED_ID`; the server then tells the issue it is ready to test, with the preview link. An empty
`$SLOTH_COL_APPROVED_ID` means the board has no such column: leave the card where it is and say so in the
report. Outside final mode a pass moves nothing.

Only ever move the issue wired to **this** PR.

## 5.5. Label the wired issue — final mode only

"OK to merge" **yes** → add `Fable: approved` to the wired issue. **No** → remove it, so a label an earlier
review left there does not outlive a rejected new head. Create the label first: a repository that
never had it rejects the add.

```bash
retry gh label create "Fable: approved" --repo "$SLOTH_REPO" --color 6f42c1 \
  --description "Passed Sloth's review — ready for a human to test" --force
retry gh issue edit <issue> --repo "$SLOTH_REPO" --add-label "Fable: approved"       # OK to merge: yes
retry gh issue edit <issue> --repo "$SLOTH_REPO" --remove-label "Fable: approved"    # OK to merge: no
```

Only ever label the issue wired to **this** PR; no wired issue → nothing to label. Outside final mode
never touch the label.

## 6. Record the end, report

Final mode: mark the run finished before the block (`set_state` is in the **`session`** skill):

```bash
set_state done 6 "Review: <passed|failed> — <rating>/10"
```

The server reads it, and reads the verdict off the PR as well — a run that ends `working` with no review
on the head is one that died, and its head is reviewed again. Never skip the review submission in Step 4:
the PR is the record.

Respond with exactly this block and nothing else — no text before or after, no justification paragraph:

```
Rating: <0–10>
Resolves the issue: <yes/no>
OK to merge: <yes/no>
New bugs: <yes/no>
Unnecessary changes: <yes/no>
Review comment: <review URL, or none — never none in final mode>
Issue moved to: <In Progress / Approved / nowhere — issue number, or n/a>
Fable: approved label: <added/removed — issue number, or n/a>
```

The only permitted additions are inside the block:

- "New bugs" **yes** → a bullet list, each `file:line — one-line description`.
- "Unnecessary changes" **yes** → a bullet list of the unrelated changes.

Rating: 9–10 fully resolves it, clean, no scope creep; 7–8 resolves it with minor nits; 5–6 mostly, with
real gaps or scope creep; 3–4 partial or introduces bugs; 0–2 does not resolve it or is unsafe to merge.

## Rules

1. Never change code, never `APPROVE` / `REQUEST_CHANGES`, never close the issue or merge. In feedback-only
   mode, never submit any review and never move a card.
2. The wired issue comes from `closingIssuesReferences` only.
3. Outside feedback-only mode, the comments and the move to In Progress happen **exactly** when "OK to merge"
   is no. A clean PR that still leaves a requirement unimplemented gets both. Final mode adds two things: the
   review is submitted on every verdict, so a pass leaves a body-only review saying so, and a pass moves the
   card to Approved — the only way a card ever gets there.
4. "OK to merge" is **no** whenever the PR introduces a bug or fails to resolve its wired issue.
5. Base every claim on the actual diff and issue text — cite `file:line` for each bug, in the block and in
   the comment.
6. A Sloth PR that changes a screen proves it with `## Screenshots` (Assess 5); a missing or dead screenshot
   is an unmet requirement. On a human's PR an image is **never** required and its absence never lowers the
   rating.
7. The `Fable: approved` label is touched in final mode only, on the wired issue only, and mirrors this
   review's "OK to merge": yes adds it, no removes it. The label never stands alone: the review body on
   the PR says the same thing in words, whichever way the verdict went, and the card sits where the verdict
   put it — Approved on a pass, In Progress on a fail.
