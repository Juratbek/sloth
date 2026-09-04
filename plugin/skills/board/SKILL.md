---
name: board
description: >-
  GitHub Projects (v2) board operations for Sloth sessions: the cheap GraphQL
  board reads (never `gh project item-list`), moving a card between columns with
  the ids from the environment, deriving an option id by column name, finding an
  issue's wired PR, and the `retry` helper for flaky `gh` calls. Use from any
  command that reads or moves a card (implement, review, status).
---

# Board operations

Every id comes from the environment the server set for this session — never hard-code one.

**Which board:** `SLOTH_BOARD` is `github` (a Projects v2 board — everything below applies) or `trello`
(a Trello board whose lists are the columns — read **Trello boards** at the end first: the `gh project`
calls below do not apply there, and `SLOTH_BOARD_API` replaces them).

| Variable | Holds |
|---|---|
| `SLOTH_BOARD` | `github` or `trello` |
| `SLOTH_BOARD_API` | Sloth's own board API on this machine, `http://127.0.0.1:<port>/api/board` — the reads and moves on a Trello board |
| `SLOTH_REPO` | `owner/repo` |
| `SLOTH_PROJECT_ID` | Project node id (`PVT_…`) |
| `SLOTH_PROJECT_NUMBER` / `SLOTH_PROJECT_OWNER` | Project number and its owner login |
| `SLOTH_STATUS_FIELD_ID` | Single-select field id (`PVTSSF_…`) |
| `SLOTH_COL_PICKUP_ID` / `_NAME` | Column Sloth takes work from |
| `SLOTH_COL_IN_PROGRESS_ID` / `_NAME` | Claimed / being worked on |
| `SLOTH_COL_NEEDS_HELP_ID` / `_NAME` | Parked, waiting for a human (may be empty) |
| `SLOTH_COL_CODE_REVIEW_ID` / `_NAME` | Handed over: the server runs `/sloth:review <pr> final` on every card here |
| `SLOTH_COL_APPROVED_ID` / `_NAME` | Passed that review; a human tests it here. Only a passing `/sloth:review … final` moves a card in (may be empty) |
| `SLOTH_COL_QA_ID` / `_NAME` | The merged fixes the daily QA sweep tests on the QA branch (`/sloth:qa`); the server moves a card out on the verdict, a session never does (may be empty) |
| `SLOTH_COL_DONE_ID` / `_NAME` | Where a closed issue's card ends up, and a card that passed the QA sweep — the server moves it; a session never needs to (may be empty) |
| `SLOTH_COLUMNS` | **Every** Status column on the board, in board order: JSON `[{"id","name"}]` — the seven above and all the others (Planning, Backlog…) |

```bash
OWNER=${SLOTH_REPO%%/*}; NAME=${SLOTH_REPO##*/}
```

An empty `SLOTH_PROJECT_ID` or `SLOTH_STATUS_FIELD_ID` means the session was launched without a board:
do the work, skip every move, and say so in the report. Never pass an empty id to `item-edit`.

## Never `gh project item-list`

`gh project item-list` costs **~200 GraphQL rate-limit points** per call (100 field values per item; the
hourly quota is 5000). The queries below cost 1–2 points. Never use `item-list` in a command or a skill.

## One issue's item id and column — 1 point, read-only

```bash
gh api graphql -f query="{ repository(owner: \"$OWNER\", name: \"$NAME\") { issue(number: $N) {
  projectItems(first: 10) { nodes { id project { number }
    fieldValueByName(name: \"Status\") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }" \
  --jq ".data.repository.issue.projectItems.nodes[] | select(.project.number == $SLOTH_PROJECT_NUMBER) | \"\(.id) \(.fieldValueByName.name)\""
```

Empty output means the issue is not on the board. When you are going to move the card anyway, skip this
read and use `item-add` — it also costs 1 point and returns the item id.

## Whole board — 2 points per page of 100

Only when a command genuinely needs every card. Read it **once** per run and filter the snapshot with `jq`.

```bash
Q='query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $cursor) {
  pageInfo { hasNextPage endCursor }
  nodes {
    fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    content { __typename ... on Issue { number labels(first: 20) { nodes { name } } assignees(first: 10) { nodes { login } } } }
  } } } } }'
N_JQ='[.data.node.items.nodes[] | select(.content.__typename == "Issue")
  | { number: .content.number, status: (.fieldValueByName.name // ""),
      labels: [.content.labels.nodes[].name], assignees: [.content.assignees.nodes[].login] }]'

cursor=""; board='[]'
while :; do
  if [ -z "$cursor" ]; then page=$(gh api graphql -f query="$Q" -F id="$SLOTH_PROJECT_ID");
  else page=$(gh api graphql -f query="$Q" -F id="$SLOTH_PROJECT_ID" -f cursor="$cursor"); fi
  board=$(jq -n --argjson a "$board" --argjson c "$(jq "$N_JQ" <<<"$page")" '$a + $c')
  [ "$(jq -r '.data.node.items.pageInfo.hasNextPage' <<<"$page")" = true ] || break
  cursor=$(jq -r '.data.node.items.pageInfo.endCursor' <<<"$page")
done
echo "$board" >/tmp/sloth-board.json    # [{number,status,labels,assignees}] in board order
```

## Move a card

`item-add` is idempotent — it returns the existing item when the issue is already on the board — so it is
the safest way to get the item id:

```bash
ITEM_ID=$(retry gh project item-add "$SLOTH_PROJECT_NUMBER" --owner "$SLOTH_PROJECT_OWNER" \
  --url "$ISSUE_URL" --format json --jq '.id')
retry gh project item-edit --id "$ITEM_ID" --project-id "$SLOTH_PROJECT_ID" \
  --field-id "$SLOTH_STATUS_FIELD_ID" --single-select-option-id "$SLOTH_COL_IN_PROGRESS_ID"
```

Swap the last argument for `$SLOTH_COL_NEEDS_HELP_ID` / `$SLOTH_COL_CODE_REVIEW_ID` / `$SLOTH_COL_PICKUP_ID`.
Keep `ITEM_ID` for the rest of the run; every later move reuses it.

## Move a card to any column by name

A human may ask for a column that is not one of Sloth's own ("move it to Planning", "put it in Backlog").
Every column is in `$SLOTH_COLUMNS`; match the name case-insensitively and move as above:

```bash
OPT=$(jq -r --arg n "Planning" '.[] | select(.name | ascii_downcase == ($n | ascii_downcase)) | .id' <<<"$SLOTH_COLUMNS")
[ -n "$OPT" ] && retry gh project item-edit --id "$ITEM_ID" --project-id "$SLOTH_PROJECT_ID" \
  --field-id "$SLOTH_STATUS_FIELD_ID" --single-select-option-id "$OPT"
```

Empty `OPT` → the column does not exist (or `SLOTH_COLUMNS` is empty; then fall back to the field-list
lookup below with that name). Never create a column; say in the thread which columns exist and stop.
The only column a session never moves a card **into** on its own is `$SLOTH_COL_APPROVED_NAME` — a card gets
there one way, a passing `/sloth:review … final`.

## Re-derive an option id by column name

Use when `item-edit` rejects an id as stale, or when the variable is empty but the column name is known:

```bash
OPT=$(gh project field-list "$SLOTH_PROJECT_NUMBER" --owner "$SLOTH_PROJECT_OWNER" --format json \
  --jq ".fields[] | select(.name==\"Status\") | .options[] | select(.name==\"$SLOTH_COL_NEEDS_HELP_NAME\") | .id")
```

Empty means the column was renamed or deleted. Do not move the card, `touch "$SLOTH_SESSION_DIR/blocked"`,
and say so in the report.

## An issue's wired PR

Development-section linkage only — never guess from titles or branch names:

```bash
gh api graphql -f query="{ repository(owner: \"$OWNER\", name: \"$NAME\") { issue(number: $N) {
  closedByPullRequestsReferences(first: 5) { nodes { number state url isDraft headRefName headRefOid reviewDecision } } } } }" \
  --jq '.data.repository.issue.closedByPullRequestsReferences.nodes[]'
```

From a PR, the reverse is `gh pr view <PR> --repo "$SLOTH_REPO" --json closingIssuesReferences`.

## `retry` — flaky `gh` calls

Creating a PR, moving a card, commenting, assigning and requesting review fail transiently (network blips,
rate limits, 5xx, board eventual consistency right after `item-add`). Wrap those calls:

```bash
retry() {
  local -i n=0 max=4; local delays=(5 15 30)
  until "$@"; do
    n+=1
    if (( n >= max )); then echo "FAILED after $max attempts: $*" >&2; return 1; fi
    echo "Attempt $n failed; retrying in ${delays[n-1]}s..." >&2
    sleep "${delays[n-1]}"
  done
}
```

- Shell state does not persist between Bash calls — define `retry` in the same invocation that uses it.
- Retry only transient failures. A 404, "no commits between branches", an unknown login, or
  "can not request review from the author" is permanent: stop and handle it.
- If a call still fails after every retry, finish what did succeed and report exactly which call failed.
  Never swallow it.

## Trello boards (`SLOTH_BOARD=trello`)

The card is a Trello card linked to the GitHub issue you are working; the issue, its comments, the PR and
the reviews are on GitHub exactly as on a Projects board. Only the *board* is different, and the server
speaks Trello for you: `SLOTH_PROJECT_ID` holds the Trello board id, `SLOTH_STATUS_FIELD_ID` the same,
every `SLOTH_COL_*_ID` a Trello list id, and `SLOTH_COLUMNS` every list on the board. Nothing here needs a
Trello key — the calls go to Sloth, on this machine.

**Never run `gh project …` on a Trello board** — the issue is on no Projects board, and `item-add` would
put it on none. Use these instead, wherever a step above says `item-edit` or reads a column:

```bash
# the column the card is in (as of the last board read; empty = no card linked to this issue)
COLUMN=$(curl -s "$SLOTH_BOARD_API/card/$SLOTH_ISSUE" | jq -r '.column // empty')

# move the card — by column name (case-insensitive) or list id; the server moves it on Trello.
# Retries a connection failure or a 5xx on its own; a 400 is permanent (its `error` says why) and is printed, not retried.
board_move() {
  local out code n
  for n in 1 2 3 4; do
    out=$(curl -s -w '\n%{http_code}' -X POST "$SLOTH_BOARD_API/move" -H 'content-type: application/json' \
      -d "$(jq -n --argjson issue "$1" --arg column "$2" '{issue: $issue, column: $column}')")
    code=${out##*$'\n'}
    case "$code" in
      200) return 0 ;;
      4??) echo "board_move $1 -> $2 refused: ${out%$'\n'*}" >&2; return 2 ;;
    esac
    echo "board_move $1 -> $2: attempt $n failed (${code:-no answer}); retrying" >&2
    sleep $((n * 10))
  done
  echo "FAILED after 4 attempts: board_move $1 -> $2" >&2
  return 1
}
board_move "$SLOTH_ISSUE" "$SLOTH_COL_IN_PROGRESS_NAME"     # claim
board_move "$SLOTH_ISSUE" "$SLOTH_COL_CODE_REVIEW_NAME"     # hand over
board_move "$SLOTH_ISSUE" "$SLOTH_COL_NEEDS_HELP_NAME"      # park (Step Q)
board_move "$SLOTH_ISSUE" "Planning"                        # a column a human asked for, from $SLOTH_COLUMNS
```

Do not wrap `board_move` in `retry`: it retries what is worth retrying. A `400` names the problem in its
JSON (`error`) — an unknown column lists the ones that exist; report it the way you would an `item-edit`
that failed. `ITEM_ID` does not exist on Trello: skip every step that
derives or keeps it. The wired-PR query and every `gh issue` / `gh pr` call are unchanged.
