import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A tick is a dozen independent errands. One that throws used to end the pass: everything after it was
 * skipped for that tick and the log said only `tick failed: …`, naming the error and not the errand.
 * Each step is on its own now — the throw is logged with its name and the tick carries on.
 */
const h = vi.hoisted(() => ({ ran: [] as string[], failing: '' }));

vi.mock('../server/runner/triggers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/runner/triggers')>();
  const watch = <K extends 'reviews' | 'handover' | 'retryStranded' | 'pickup'>(name: K) =>
    (async (...args: Parameters<(typeof real)[K]>) => {
      h.ran.push(name);
      if (h.failing === name) throw new Error(`${name} exploded`);
      return (real[name] as (...a: unknown[]) => Promise<void>)(...args);
    }) as (typeof real)[K];
  return { ...real, reviews: watch('reviews'), handover: watch('handover'), retryStranded: watch('retryStranded'), pickup: watch('pickup') };
});
vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

import { setDry } from '../server/runner/log';
import { tick } from '../server/runner/loop';
import { onGh, resetGh } from './gh-mock';
import { resetSpawn } from './child-process-mock';
import { configure, readLog, wipe } from './harness';

const EMPTY_BOARD = { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [] } } } };

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
  h.ran = [];
  h.failing = '';
  onGh(/items\(first: 100/, EMPTY_BOARD);
});

describe('a step that throws', () => {
  it('does not take the rest of the tick with it', async () => {
    h.failing = 'reviews';
    await tick({ board: true });
    // Everything after the review still had its turn — the card in In Progress and the pickup column
    // are not held hostage by a review that could not be read.
    expect(h.ran).toEqual(['reviews', 'handover', 'retryStranded', 'pickup']);
  });

  it('is logged under the name of the step, and not as the whole tick failing', async () => {
    h.failing = 'handover';
    await tick({ board: true });
    const log = readLog().join('\n');
    expect(log).toContain('step handover failed: handover exploded');
    expect(log).not.toMatch(/tick failed/);
  });

  it('leaves the ticks after it alone', async () => {
    h.failing = 'pickup';
    await tick({ board: true });
    h.failing = '';
    h.ran = [];
    await tick({ board: true });
    expect(h.ran).toEqual(['reviews', 'handover', 'retryStranded', 'pickup']);
  });
});
