import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBoard, moveCard, unassignedIn, wiredPrs } from '../server/runner/board';
import { setDry } from '../server/runner/log';
import { called, onGh, resetGh } from './gh-mock';
import { configure, readLog } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

const item = (number: number, status: string, extra: Record<string, unknown> = {}) => ({
  fieldValueByName: { name: status },
  content: { __typename: 'Issue', number, title: `Issue ${number}`, labels: { nodes: [] }, assignees: { nodes: [] }, ...extra },
});

beforeEach(() => {
  configure();
  resetGh();
  setDry(false);
});

describe('fetchBoard', () => {
  it('walks every page and keeps issues only, in board order', async () => {
    onGh(/api graphql .*cursor=c1/, { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [item(3, 'Done', { state: 'CLOSED' })] } } } });
    onGh(/api graphql/, {
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
            nodes: [item(1, 'Todo', { assignees: { nodes: [{ login: 'bob' }] } }), { content: { __typename: 'PullRequest', number: 9 } }, item(2, 'Todo', { labels: { nodes: [{ name: 'bug' }] } })],
          },
        },
      },
    });
    const board = await fetchBoard();
    expect(board?.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(board?.[0].assignees).toEqual(['bob']);
    expect(board?.[1].labels).toEqual(['bug']);
    expect(board?.map((i) => i.closed)).toEqual([false, false, true]);
    expect(unassignedIn(board!, 'Todo')).toEqual([2]);
  });
  it('returns undefined and logs when the read fails', async () => {
    onGh(/api graphql/, { ok: false, out: '', err: 'HTTP 502\nmore' });
    expect(await fetchBoard()).toBeUndefined();
    expect(readLog().at(-1)).toMatch(/board fetch failed: HTTP 502$/);
  });
});

describe('moveCard', () => {
  it('adds the card then edits its Status', async () => {
    onGh(/project item-add/, 'ITEM_1');
    expect(await moveCard(42, 'opt-wip')).toBe(true);
    expect(called(/project item-edit --id ITEM_1 .*--single-select-option-id opt-wip/)).toHaveLength(1);
  });
  it('refuses an empty option and only logs in a dry run', async () => {
    expect(await moveCard(42, '')).toBe(false);
    setDry(true);
    expect(await moveCard(42, 'opt-wip')).toBe(true);
    expect(called(/project/)).toHaveLength(0);
    expect(readLog().at(-1)).toMatch(/dry-run: would move #42/);
  });
});

describe('wiredPrs', () => {
  const rollup = (state: string) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } } ] } });
  it('keeps open, non-draft, unapproved PRs by default, with their checks and mergeability', async () => {
    onGh(/api graphql/, {
      data: {
        repository: {
          i1: { closedByPullRequestsReferences: { nodes: [{ number: 10, state: 'OPEN', isDraft: false, headRefOid: 'aaa', headRefName: 'sloth/issue-1-x', reviewDecision: null, mergeable: 'MERGEABLE', ...rollup('FAILURE') }] } },
          i2: { closedByPullRequestsReferences: { nodes: [{ number: 11, state: 'OPEN', isDraft: true, headRefOid: 'bbb', headRefName: 'feat' }, { number: 12, state: 'MERGED', isDraft: false, headRefOid: 'ccc', headRefName: 'old' }] } },
          i3: { closedByPullRequestsReferences: { nodes: [{ number: 13, state: 'OPEN', isDraft: false, headRefOid: 'ddd', headRefName: 'ok', reviewDecision: 'APPROVED', mergeable: 'CONFLICTING', ...rollup('PENDING') }] } },
        },
      },
    });
    expect(await wiredPrs([1, 2, 3])).toEqual([
      { issue: 1, pr: 10, sha: 'aaa', head: 'sloth/issue-1-x', state: 'OPEN', checks: 'FAILURE', mergeable: 'MERGEABLE' },
    ]);
    expect((await wiredPrs([1, 2, 3], { unapprovedOnly: false })).map((p) => [p.pr, p.checks, p.mergeable])).toEqual([
      [10, 'FAILURE', 'MERGEABLE'],
      [13, 'PENDING', 'CONFLICTING'],
    ]);
    // A repository that runs no checks reports no rollup at all — that is not a pending one.
    expect((await wiredPrs([2], { states: ['MERGED'] })).map((p) => [p.pr, p.state, p.checks])).toEqual([[12, 'MERGED', 'NONE']]);
  });
  it('asks nothing for no issues and survives a failed lookup', async () => {
    expect(await wiredPrs([])).toEqual([]);
    expect(called(/graphql/)).toHaveLength(0);
    onGh(/api graphql/, { ok: false, out: '', err: 'boom' });
    expect(await wiredPrs([1])).toEqual([]);
  });
});
