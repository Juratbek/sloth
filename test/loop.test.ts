import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../server/runner/loop';
import { snapshot } from '../server/runner/board-snapshot';
import { setDry } from '../server/runner/log';
import { onGh, resetGh } from './gh-mock';
import { resetSpawn } from './child-process-mock';
import { configure, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

const board = (numbers: number[]) => ({
  data: {
    node: {
      items: {
        pageInfo: { hasNextPage: false },
        nodes: numbers.map((n) => ({
          fieldValueByName: { name: 'Todo' },
          content: { __typename: 'Issue', number: n, title: `Issue ${n}`, labels: { nodes: [] }, assignees: { nodes: [{ login: 'bob' }] } },
        })),
      },
    },
  },
});

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
});

describe('a board tick', () => {
  it('keeps the board it read, so the home panel needs no fetch of its own', async () => {
    onGh(/items\(first: 100/, board([5, 6]));
    await tick({ board: true });
    expect(snapshot()?.items.map((i) => i.number)).toEqual([5, 6]);
  });

  it('keeps it in a dry run too — reading the board is harmless', async () => {
    onGh(/items\(first: 100/, board([9]));
    await tick({ board: true, dryRun: true });
    expect(snapshot()?.items.map((i) => i.number)).toEqual([9]);
  });

  it('leaves the last one alone when the read fails', async () => {
    onGh(/items\(first: 100/, board([1]));
    await tick({ board: true });
    onGh(/items\(first: 100/, { ok: false, out: '', err: 'HTTP 502' });
    await tick({ board: true });
    expect(snapshot()?.items.map((i) => i.number)).toEqual([1]);
  });
});
