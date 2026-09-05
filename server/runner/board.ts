import { skipped } from '../board-types';
import { cfg } from '../config';
import { isConfigured, label } from '../repos';
import type { IssueRef, PrRef } from '../repo-types';
import { fetchTrelloBoard, moveTrelloCard } from './board-trello';
import { gh, graphql } from './gh';
import { isDry, log } from './log';

/**
 * The board Sloth watches, behind one reader and one writer whatever it is: a GitHub Projects (v2) board
 * (below — the Status field's options are the columns) or a Trello board (`board-trello.ts` — its lists
 * are). `cfg().project.provider` says which; every trigger sees the same `BoardItem`s and moves a card the
 * same way. What is *not* the board's — the PRs wired to an issue, a review's verdict — is GitHub's on
 * either, and stays below. A card is an issue in one of the configured repositories; a Projects board may
 * hold issues of others too, and those are not Sloth's — left out, and said once.
 */
const onTrello = () => cfg().project.provider === 'trello';

export interface BoardItem extends IssueRef {
  title: string;
  status: string;
  labels: string[];
  assignees: string[];
  /** The issue is closed — by a merged PR or by hand. */
  closed: boolean;
  /** Where the card's `priorityField` option sits in that field's option list; undefined when it has none. */
  priority?: number;
}

/** The option a card holds in the priority field, and the field's own options — their order is the ranking. */
const PRIORITY_VALUE = `priority: fieldValueByName(name: $priority) {
  ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2SingleSelectField { options { id } } } } }`;

// One lean read of the whole board per tick. `gh project item-list` costs ~203 rate-limit points (it
// pulls 100 field values per item); asking only for Status / labels / assignees costs ~2 per page.
const boardQuery = (priority: string) => `query($id: ID!, $cursor: String${priority ? ', $priority: String!' : ''}) {
  node(id: $id) { ... on ProjectV2 { items(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      ${priority ? PRIORITY_VALUE : ''}
      content { __typename ... on Issue { number title state repository { nameWithOwner } labels(first: 20) { nodes { name } }
        assignees(first: 10) { nodes { login } } } }
    } } } } }`;

interface RawNode {
  fieldValueByName?: { name?: string };
  priority?: { optionId?: string; field?: { options?: { id: string }[] } };
  content?: { __typename?: string; number?: number; title?: string; state?: string; repository?: { nameWithOwner?: string }; labels?: { nodes: { name: string }[] }; assignees?: { nodes: { login: string }[] } };
}

/** A card's rank: the index of its option in the field, so the field's own order is the order work is taken in. */
function rankOf(n: RawNode): number | undefined {
  const at = (n.priority?.field?.options ?? []).findIndex((o) => o.id === n.priority?.optionId);
  return n.priority?.optionId && at >= 0 ? at : undefined;
}

/** The repositories a board card was found in that Sloth is not configured for — said once each. */
const foreign = new Set<string>();

/** A card of a repository Sloth does not work in is not a card of Sloth's; a board read from before the field names none. */
function mine(n: RawNode): string | undefined {
  const repo = n.content?.repository?.nameWithOwner ?? cfg().repos[0]?.slug ?? '';
  if (isConfigured(repo)) return repo;
  if (!foreign.has(repo)) {
    foreign.add(repo);
    log(`board: cards of ${repo || 'an unknown repository'} are left alone — it is not one of Sloth's repositories`);
  }
  return undefined;
}

/** Every issue card on the board, in board order; `undefined` when the board could not be read. */
export const fetchBoard = (): Promise<BoardItem[] | undefined> => (onTrello() ? fetchTrelloBoard() : fetchGithubBoard());

async function fetchGithubBoard(): Promise<BoardItem[] | undefined> {
  const items: BoardItem[] = [];
  let cursor: string | undefined;
  try {
    for (;;) {
      const field = cfg().priorityField;
      const vars = [
        '-F', `id=${cfg().project.id}`,
        ...(cursor ? ['-F', `cursor=${cursor}`] : []),
        ...(field ? ['-F', `priority=${field}`] : []),
      ];
      const page = (await graphql(boardQuery(field), vars)).node?.items;
      for (const n of (page?.nodes ?? []) as RawNode[]) {
        if (n.content?.__typename !== 'Issue' || !n.content.number) continue;
        const repo = mine(n);
        if (!repo) continue;
        items.push({
          repo,
          number: n.content.number,
          title: n.content.title ?? '',
          status: n.fieldValueByName?.name ?? '',
          labels: (n.content.labels?.nodes ?? []).map((l) => l.name),
          assignees: (n.content.assignees?.nodes ?? []).map((a) => a.login),
          closed: n.content.state === 'CLOSED',
          priority: rankOf(n),
        });
      }
      if (!page?.pageInfo?.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }
  } catch (e) {
    log(`board fetch failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return undefined;
  }
  return items;
}

/** Cards in one column that no human has held back — the `Sloth: skip` label means a person owns the card. */
export const freeIn = (board: BoardItem[], column: string): BoardItem[] => board.filter((i) => i.status === column && !skipped(i));

/**
 * The same cards, in the order work should be taken in: the board's priority field first — its options
 * top to bottom — and everything unprioritised after them, each group still in board order (`sort` is
 * stable). With no `priorityField` configured no card has a rank and this is plain board order.
 */
export const pickupOrder = (board: BoardItem[], column: string): BoardItem[] =>
  board.filter((i) => i.status === column && !skipped(i)).sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));

/** Moves an issue's card to a column — a Status option, or a Trello list — adding it to a Projects board first if it is not on it. */
export async function moveCard(issue: IssueRef, optionId: string): Promise<boolean> {
  const c = cfg();
  if (!optionId) {
    log(`${label(issue)} move skipped: empty option id`);
    return false;
  }
  if (onTrello()) return moveTrelloCard(issue, optionId);
  if (isDry()) {
    log(`dry-run: would move ${label(issue)} to ${optionId}`);
    return true;
  }
  const add = await gh([
    'project', 'item-add', String(c.project.number), '--owner', c.project.owner,
    '--url', `https://github.com/${issue.repo}/issues/${issue.number}`, '--format', 'json', '--jq', '.id',
  ]);
  if (!add.ok) {
    log(`${label(issue)} move failed (item-add): ${add.err.split('\n')[0]}`);
    return false;
  }
  const edit = await gh([
    'project', 'item-edit', '--id', add.out, '--project-id', c.project.id,
    '--field-id', c.statusField.id, '--single-select-option-id', optionId,
  ]);
  if (!edit.ok) log(`${label(issue)} move failed (item-edit): ${edit.err.split('\n')[0]}`);
  return edit.ok;
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';
/** The PR head's combined check status: `NONE` when the repository runs no checks. */
export type Checks = 'SUCCESS' | 'PENDING' | 'FAILURE' | 'NONE';
export interface WiredPr {
  issue: IssueRef;
  /** The PR, in its own repository — the issue's, or another of Sloth's when the work spans two. */
  pr: PrRef;
  sha: string;
  /** The head branch — `sloth/issue-<n>-…` marks a PR Sloth wrote itself. */
  head: string;
  /** The branch the PR merges into — what a conflict round-trip merges into the head. */
  base: string;
  state: PrState;
  /** Still a draft on GitHub. Reviewed like any other — the column is the signal — but never merged. */
  draft: boolean;
  checks: Checks;
  /** GitHub's word on whether the head merges cleanly into its base; `UNKNOWN` while it is still computing. */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** What Sloth's last review said about *this* head (`reviewVerdict`); undefined when none was posted on it. */
  verdict?: Verdict;
}
export interface WiredOptions {
  /** Which PR states to return. */
  states?: PrState[];
}

/**
 * A Vercel deployment refused at the account — `Deployment was blocked` (a spend cap, a paused project),
 * a git author without access to the team — says nothing about the code on the branch. GitHub's rollup is
 * all-or-nothing, so one such status would keep every head red for ever: no session can fix it, no PR
 * merges, and trigger 7 burns a run on it per head. A real Vercel build failure carries neither message
 * and still counts.
 */
const ACCOUNT_FAILURE = /deployment was blocked|must have access to the project on vercel/i;

interface CheckNode {
  state?: string; // StatusContext
  description?: string;
  conclusion?: string | null; // CheckRun; null while it runs
}
interface Rollup {
  state?: string;
  contexts?: { nodes?: CheckNode[] };
}

const contextChecks = (n: CheckNode): Checks => {
  if (n.state) {
    if (n.state === 'SUCCESS') return 'SUCCESS';
    if (n.state !== 'FAILURE' && n.state !== 'ERROR') return 'PENDING';
    return ACCOUNT_FAILURE.test(n.description ?? '') ? 'SUCCESS' : 'FAILURE';
  }
  if (n.conclusion === undefined || n.conclusion === null) return 'PENDING';
  return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(n.conclusion) ? 'SUCCESS' : 'FAILURE';
};

/** The rollup's word, except that a red one is re-read check by check with the account-level failures left out. */
function checksOf(rollup: Rollup | undefined): Checks {
  const state = rollup?.state;
  if (state === 'SUCCESS') return 'SUCCESS';
  if (!state) return 'NONE';
  if (state !== 'FAILURE' && state !== 'ERROR') return 'PENDING';
  const nodes = rollup?.contexts?.nodes ?? [];
  if (!nodes.length) return 'FAILURE';
  const each = nodes.map(contextChecks);
  return each.includes('FAILURE') ? 'FAILURE' : each.includes('PENDING') ? 'PENDING' : 'SUCCESS';
}

export type Verdict = 'passed' | 'failed';
interface ReviewNode {
  body?: string;
  commit?: { oid?: string };
}
const REVIEW_FIELDS = 'reviews(last: 30) { nodes { body commit { oid } } }';
const ROLLUP_FIELDS = `statusCheckRollup { state contexts(first: 100) { nodes {
  ... on StatusContext { state description } ... on CheckRun { conclusion } } } }`;
const PR_FIELDS = `number state isDraft headRefOid headRefName baseRefName mergeable repository { nameWithOwner } commits(last: 1) { nodes { commit { ${ROLLUP_FIELDS} } } } ${REVIEW_FIELDS}`;

/**
 * The verdict `/sloth:review … final` posted on a PR for the head `sha`, read off the PR itself: the
 * review's body opens with the bot prefix and says `Review: **passed**` or `Review: **failed**`
 * (`plugin/commands/review.md`, Step 4). The latest one on that head counts. A verdict lives on GitHub,
 * where nothing on this machine can lose it — the marker under `state/approved/` only says a review was
 * started, and a card moved after the verdict landed would otherwise be a card nobody remembers the
 * verdict of. A human's review, or one on an older head, is not a verdict.
 */
export function verdictOf(reviews: ReviewNode[] | undefined, sha: string): Verdict | undefined {
  const prefix = cfg().botPrefix;
  let verdict: Verdict | undefined;
  for (const r of reviews ?? []) {
    if (r.commit?.oid !== sha || !r.body?.startsWith(prefix)) continue;
    const m = /Review: \*\*(passed|failed)\*\*/.exec(r.body);
    if (m) verdict = m[1] as Verdict;
  }
  return verdict;
}

/** `verdictOf` for one PR, for a caller that has no board read in hand — `reap`, judging a review that just ended. */
export async function reviewVerdict(pr: PrRef, sha: string): Promise<Verdict | undefined> {
  const [owner, name] = pr.repo.split('/');
  try {
    const data = await graphql(`{ repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { ${REVIEW_FIELDS} } } }`);
    return verdictOf(data.repository?.pullRequest?.reviews?.nodes, sha);
  } catch (e) {
    log(`PR #${pr.number} review lookup failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return undefined;
  }
}

/**
 * The PRs wired to these issues — one aliased query per repository for all of its issues; open ones by
 * default, drafts included. A GitHub approval on the PR changes nothing, and neither does the draft flag:
 * the column a card sits in is the signal, never the PR's own state. A PR in another repository that
 * closes the issue (`Closes owner/name#12`) is wired like one in its own.
 */
export async function wiredPrs(issues: IssueRef[], { states = ['OPEN'] }: WiredOptions = {}): Promise<WiredPr[]> {
  const out: WiredPr[] = [];
  for (const repo of [...new Set(issues.map((i) => i.repo))]) {
    const numbers = [...new Set(issues.filter((i) => i.repo === repo).map((i) => i.number))];
    const [owner, name] = repo.split('/');
    const parts = numbers.map((n) => `i${n}: issue(number: ${n}) { closedByPullRequestsReferences(first: 5) { nodes { ${PR_FIELDS} } } }`).join(' ');
    try {
      const data = await graphql(`{ repository(owner: "${owner}", name: "${name}") { ${parts} } }`);
      for (const [key, value] of Object.entries(data.repository ?? {}) as [string, any][]) {
        for (const p of ((value?.closedByPullRequestsReferences?.nodes ?? []) as any[]).filter((p) => states.includes(p.state))) {
          out.push({
            issue: { repo, number: Number(key.slice(1)) },
            pr: { repo: p.repository?.nameWithOwner ?? repo, number: p.number as number },
            sha: p.headRefOid as string,
            head: String(p.headRefName ?? ''),
            base: String(p.baseRefName ?? ''),
            state: p.state as PrState,
            draft: !!p.isDraft,
            checks: checksOf(p.commits?.nodes?.[0]?.commit?.statusCheckRollup),
            mergeable: p.mergeable === 'MERGEABLE' || p.mergeable === 'CONFLICTING' ? p.mergeable : 'UNKNOWN',
            verdict: verdictOf(p.reviews?.nodes, p.headRefOid),
          });
        }
      }
    } catch (e) {
      log(`wired PR lookup failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  return out;
}
