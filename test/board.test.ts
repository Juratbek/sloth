import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBoard, freeIn, moveCard, pickupOrder, reviewVerdict, wiredPrs } from '../server/runner/board';
import { setDry } from '../server/runner/log';
import { called, onGh, resetGh } from './gh-mock';
import { configure, readLog } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

const item = (number: number, status: string, extra: Record<string, unknown> = {}, priority?: unknown) => ({
  fieldValueByName: { name: status },
  ...(priority ? { priority } : {}),
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
            nodes: [item(1, 'Todo', { assignees: { nodes: [{ login: 'bob' }] }, labels: { nodes: [{ name: 'Sloth: skip' }] } }), { content: { __typename: 'PullRequest', number: 9 } }, item(2, 'Todo', { labels: { nodes: [{ name: 'bug' }] } })],
          },
        },
      },
    });
    const board = await fetchBoard();
    expect(board?.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(board?.[0].assignees).toEqual(['bob']);
    expect(board?.[1].labels).toEqual(['bug']);
    expect(board?.map((i) => i.closed)).toEqual([false, false, true]);
    expect(freeIn(board!, 'Todo')).toEqual([2]);
  });
  it('ranks a card by the position of its option in the priority field', async () => {
    const options = { options: [{ id: 'p-high' }, { id: 'p-med' }, { id: 'p-low' }] };
    onGh(/api graphql/, {
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: false },
            nodes: [
              item(1, 'Todo', {}, { optionId: 'p-low', field: options }),
              item(2, 'Todo'),
              item(3, 'Todo', {}, { optionId: 'p-high', field: options }),
              item(4, 'Todo', {}, { optionId: 'gone', field: options }),
              item(5, 'Todo', { labels: { nodes: [{ name: 'Sloth: skip' }] } }, { optionId: 'p-high', field: options }),
            ],
          },
        },
      },
    });
    const board = (await fetchBoard())!;
    expect(board.map((i) => i.priority)).toEqual([2, undefined, 0, undefined, 0]);
    expect(called(/-F priority=Priority/)).toHaveLength(1);
    // Ranked first, board order within a rank, unranked last — and never a card labelled Sloth: skip.
    expect(pickupOrder(board, 'Todo')).toEqual([3, 1, 2, 4]);
  });
  it('asks for no priority value when the field is turned off', async () => {
    configure({ priorityField: '' });
    onGh(/api graphql/, { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [item(1, 'Todo')] } } } });
    expect((await fetchBoard())?.[0].priority).toBeUndefined();
    expect(called(/priority/)).toHaveLength(0);
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
  const rollup = (state: string, ...contexts: Record<string, unknown>[]) => ({
    commits: { nodes: [{ commit: { statusCheckRollup: { state, ...(contexts.length ? { contexts: { nodes: contexts } } : {}) } } }] },
  });
  /** Sloth reviews as they sit on the PR: `(sha, verdict)` pairs, oldest first. */
  const reviewed = (...pairs: string[]) => ({
    reviews: { nodes: Array.from({ length: pairs.length / 2 }, (_, i) => ({ body: `**Sloth:**\nReview: **${pairs[2 * i + 1]}** — 8/10.`, commit: { oid: pairs[2 * i] } })) },
  });
  it('keeps open PRs by default — draft or ready, approved on GitHub or not — with their checks and mergeability', async () => {
    onGh(/api graphql/, {
      data: {
        repository: {
          i1: { closedByPullRequestsReferences: { nodes: [{ number: 10, state: 'OPEN', isDraft: false, headRefOid: 'aaa', headRefName: 'sloth/issue-1-x', baseRefName: 'main', mergeable: 'MERGEABLE', ...rollup('FAILURE'), ...reviewed('aaa', 'failed', 'aaa', 'passed') }] } },
          i2: { closedByPullRequestsReferences: { nodes: [{ number: 11, state: 'OPEN', isDraft: true, headRefOid: 'bbb', headRefName: 'feat' }, { number: 12, state: 'MERGED', isDraft: false, headRefOid: 'ccc', headRefName: 'old' }] } },
          i3: { closedByPullRequestsReferences: { nodes: [{ number: 13, state: 'OPEN', isDraft: false, headRefOid: 'ddd', headRefName: 'ok', reviewDecision: 'APPROVED', mergeable: 'CONFLICTING', ...rollup('PENDING'), ...reviewed('old', 'passed') }] } },
        },
      },
    });
    expect(await wiredPrs([1, 2, 3])).toEqual([
      // The latest Sloth verdict on the current head counts; one on an older head is none.
      { issue: 1, pr: 10, sha: 'aaa', head: 'sloth/issue-1-x', base: 'main', state: 'OPEN', draft: false, checks: 'FAILURE', mergeable: 'MERGEABLE', verdict: 'passed' },
      { issue: 2, pr: 11, sha: 'bbb', head: 'feat', base: '', state: 'OPEN', draft: true, checks: 'NONE', mergeable: 'UNKNOWN' },
      { issue: 3, pr: 13, sha: 'ddd', head: 'ok', base: '', state: 'OPEN', draft: false, checks: 'PENDING', mergeable: 'CONFLICTING' },
    ]);
    // A repository that runs no checks reports no rollup at all — that is not a pending one.
    expect((await wiredPrs([2], { states: ['MERGED'] })).map((p) => [p.pr, p.state, p.checks])).toEqual([[12, 'MERGED', 'NONE']]);
  });
  it('leaves account-level Vercel failures out of a red rollup; a real failure still counts', async () => {
    const pr = (n: number, r: object) => ({ number: n, state: 'OPEN', isDraft: false, headRefOid: 'aaa', headRefName: 'x', mergeable: 'MERGEABLE', ...r });
    const blocked = { state: 'FAILURE', description: 'Deployment was blocked' };
    const noAccess = { state: 'ERROR', description: 'Git author sarzeez must have access to the project on Vercel to create deployments.' };
    onGh(/api graphql/, {
      data: {
        repository: {
          // Every failure is Vercel refusing at the account: the head is green.
          i1: { closedByPullRequestsReferences: { nodes: [pr(10, rollup('FAILURE', blocked, noAccess, { state: 'SUCCESS' }, { conclusion: 'SUCCESS' }))] } },
          // A failing check run beside them is a failure of the code.
          i2: { closedByPullRequestsReferences: { nodes: [pr(11, rollup('FAILURE', blocked, { conclusion: 'FAILURE' }))] } },
          // A blocked deployment beside a running check: still pending, not failed.
          i3: { closedByPullRequestsReferences: { nodes: [pr(12, rollup('FAILURE', noAccess, { conclusion: null }))] } },
          // A real Vercel build failure carries another message and counts.
          i4: { closedByPullRequestsReferences: { nodes: [pr(13, rollup('FAILURE', { state: 'FAILURE', description: 'Deployment failed' }))] } },
          // A red rollup whose checks could not be read stays red.
          i5: { closedByPullRequestsReferences: { nodes: [pr(14, rollup('FAILURE'))] } },
        },
      },
    });
    expect((await wiredPrs([1, 2, 3, 4, 5])).map((p) => [p.pr, p.checks])).toEqual([
      [10, 'SUCCESS'],
      [11, 'FAILURE'],
      [12, 'PENDING'],
      [13, 'FAILURE'],
      [14, 'FAILURE'],
    ]);
  });
  it('reads one PR’s verdict for its head, ignoring a human’s review and a verdict on another head', async () => {
    onGh(/pullRequest\(number: 10\)/, { data: { repository: { pullRequest: { reviews: { nodes: [
      { body: 'LGTM', commit: { oid: 'aaa' } },
      { body: '**Sloth:**\nReview: **failed** — 5/10.', commit: { oid: 'aaa' } },
      { body: '**Sloth:**\nReview: **passed** — 9/10.', commit: { oid: 'bbb' } },
    ] } } } } });
    expect(await reviewVerdict(10, 'aaa')).toBe('failed');
    expect(await reviewVerdict(10, 'bbb')).toBe('passed');
    expect(await reviewVerdict(10, 'ccc')).toBeUndefined();
    resetGh();
    onGh(/api graphql/, { ok: false, out: '', err: 'boom' });
    expect(await reviewVerdict(10, 'aaa')).toBeUndefined();
    expect(readLog().at(-1)).toMatch(/PR #10 review lookup failed: boom/);
  });
  it('asks nothing for no issues and survives a failed lookup', async () => {
    expect(await wiredPrs([])).toEqual([]);
    expect(called(/graphql/)).toHaveLength(0);
    onGh(/api graphql/, { ok: false, out: '', err: 'boom' });
    expect(await wiredPrs([1])).toEqual([]);
  });
});
