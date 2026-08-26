import { cfg } from '../config';
import { gh, graphql } from './gh';
import { isDry, log } from './log';

export interface BoardItem {
  number: number;
  status: string;
  labels: string[];
  assignees: string[];
}

// One lean read of the whole board per tick. `gh project item-list` costs ~203 rate-limit points (it
// pulls 100 field values per item); asking only for Status / labels / assignees costs ~2 per page.
const BOARD_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) { ... on ProjectV2 { items(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      content { __typename ... on Issue { number labels(first: 20) { nodes { name } }
        assignees(first: 10) { nodes { login } } } }
    } } } } }`;

interface RawNode {
  fieldValueByName?: { name?: string };
  content?: { __typename?: string; number?: number; labels?: { nodes: { name: string }[] }; assignees?: { nodes: { login: string }[] } };
}

/** Every issue card on the board, in board order. */
export async function fetchBoard(): Promise<BoardItem[] | undefined> {
  const items: BoardItem[] = [];
  let cursor: string | undefined;
  try {
    for (;;) {
      const vars = ['-F', `id=${cfg().project.id}`, ...(cursor ? ['-F', `cursor=${cursor}`] : [])];
      const page = (await graphql(BOARD_QUERY, vars)).node?.items;
      for (const n of (page?.nodes ?? []) as RawNode[]) {
        if (n.content?.__typename !== 'Issue' || !n.content.number) continue;
        items.push({
          number: n.content.number,
          status: n.fieldValueByName?.name ?? '',
          labels: (n.content.labels?.nodes ?? []).map((l) => l.name),
          assignees: (n.content.assignees?.nodes ?? []).map((a) => a.login),
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

/** Cards in one column that no human has claimed — an assignee means a person owns the card. */
export const unassignedIn = (board: BoardItem[], column: string): number[] =>
  board.filter((i) => i.status === column && i.assignees.length === 0).map((i) => i.number);

/** Moves an issue's card to a Status option, adding it to the board first if it is not on it. */
export async function moveCard(issue: number, optionId: string): Promise<boolean> {
  const c = cfg();
  if (!optionId) {
    log(`#${issue} move skipped: empty option id`);
    return false;
  }
  if (isDry()) {
    log(`dry-run: would move #${issue} to ${optionId}`);
    return true;
  }
  const add = await gh([
    'project', 'item-add', String(c.project.number), '--owner', c.project.owner,
    '--url', `https://github.com/${c.repo}/issues/${issue}`, '--format', 'json', '--jq', '.id',
  ]);
  if (!add.ok) {
    log(`#${issue} move failed (item-add): ${add.err.split('\n')[0]}`);
    return false;
  }
  const edit = await gh([
    'project', 'item-edit', '--id', add.out, '--project-id', c.project.id,
    '--field-id', c.statusField.id, '--single-select-option-id', optionId,
  ]);
  if (!edit.ok) log(`#${issue} move failed (item-edit): ${edit.err.split('\n')[0]}`);
  return edit.ok;
}

export interface WiredPr {
  issue: number;
  pr: number;
  sha: string;
  /** The head branch — `sloth/issue-<n>-…` marks a PR Sloth wrote itself. */
  head: string;
}

/**
 * The open, non-draft PRs wired to these issues — one aliased query for all of them. By default a PR a
 * human already approved on GitHub is left out; trigger 5 asks for all of them, since the Approved
 * column itself is the signal there.
 */
export async function wiredPrs(issues: number[], { unapprovedOnly = true } = {}): Promise<WiredPr[]> {
  if (!issues.length) return [];
  const [owner, name] = cfg().repo.split('/');
  const parts = issues
    .map((n) => `i${n}: issue(number: ${n}) { closedByPullRequestsReferences(first: 5) { nodes { number state isDraft headRefOid headRefName reviewDecision } } }`)
    .join(' ');
  try {
    const data = await graphql(`{ repository(owner: "${owner}", name: "${name}") { ${parts} } }`);
    return Object.entries(data.repository ?? {}).flatMap(([key, value]: [string, any]) =>
      ((value?.closedByPullRequestsReferences?.nodes ?? []) as any[])
        .filter((p) => p.state === 'OPEN' && !p.isDraft && (!unapprovedOnly || p.reviewDecision !== 'APPROVED'))
        .map((p) => ({ issue: Number(key.slice(1)), pr: p.number as number, sha: p.headRefOid as string, head: String(p.headRefName ?? '') })),
    );
  } catch (e) {
    log(`wired PR lookup failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return [];
  }
}
