---
description: Assess a PR against its wired issue — does it resolve it, is it safe to merge, does it add bugs or unnecessary changes — rate it 0–10, comment inline on the findings, and move the wired issue back to In Progress; in final mode a pass labels the issue `Fable: approved`
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

If `$ARGUMENTS` contains `final`, this is the server's last review before merge (trigger 5): a human moved
the card to `$SLOTH_COL_APPROVED_NAME` and waits for the verdict. Everything else applies unchanged, plus
Step 5.5: the wired issue carries the label **`Fable: approved`** exactly when this review passed.

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

## 4. Comment on the PR — whenever "OK to merge" is no

Clean and resolves its issue → submit nothing; the verdict block is the whole output.

Otherwise submit **one** review with `event: "COMMENT"`: an inline comment per bug, plus a body bullet per
unmet requirement.

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

- `line` is the **new-file** line number and must fall inside a diff hunk, or GitHub rejects the whole
  review. Use `"side": "LEFT"` with the old-file line for a removed line; add `"start_line"` +
  `"start_side"` for a range.
- A bug that cannot be tied to a diff line goes as a body bullet naming the path. So does every unmet
  requirement — name it from the issue and say where it is missing. Never invent a diff line.
- One comment per bug: the problem, the rule when it is a convention violation, the fix. No praise, no nits,
  no restating what the code does.
- Never `APPROVE`, never `REQUEST_CHANGES`. First line of the review body is `$SLOTH_BOT_PREFIX`.

## 5. Move the wired issue back — whenever "OK to merge" is no

New bugs, or the PR does not resolve its issue, or both → move that issue's card to
`$SLOTH_COL_IN_PROGRESS_NAME` (`board` skill: single-issue read for `ITEM_ID`, then `item-edit` with
`$SLOTH_COL_IN_PROGRESS_ID`). Not on the board, or already there → leave it and note that in the report.
Only ever move the issue wired to **this** PR.

## 5.5. Label the wired issue — final mode only

"OK to merge" **yes** → add `Fable: approved` to the wired issue. **No** → remove it, so a label an earlier
final review left there does not outlive a rejected new head. Create the label first: a repository that
never had it rejects the add.

```bash
retry gh label create "Fable: approved" --repo "$SLOTH_REPO" --color 6f42c1 \
  --description "Passed Sloth's final review on the Fable model" --force
retry gh issue edit <issue> --repo "$SLOTH_REPO" --add-label "Fable: approved"       # OK to merge: yes
retry gh issue edit <issue> --repo "$SLOTH_REPO" --remove-label "Fable: approved"    # OK to merge: no
```

Only ever label the issue wired to **this** PR; no wired issue → nothing to label. Outside final mode
never touch the label.

## 6. Report

Respond with exactly this block and nothing else — no text before or after, no justification paragraph:

```
Rating: <0–10>
Resolves the issue: <yes/no>
OK to merge: <yes/no>
New bugs: <yes/no>
Unnecessary changes: <yes/no>
Review comment: <review URL, or none>
Issue moved to In Progress: <yes/no — issue number, or n/a>
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
3. Outside feedback-only mode, the comments and the board move happen **exactly** when "OK to merge" is no.
   A clean PR that still leaves a requirement unimplemented gets both.
4. "OK to merge" is **no** whenever the PR introduces a bug or fails to resolve its wired issue.
5. Base every claim on the actual diff and issue text — cite `file:line` for each bug, in the block and in
   the comment.
6. A missing image, gif or video is **never** a finding and never lowers the rating: Sloth runs headless, so
   PRs describe verification and design fidelity in words.
7. The `Fable: approved` label is touched in final mode only, on the wired issue only, and mirrors this
   review's "OK to merge": yes adds it, no removes it.
