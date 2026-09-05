import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVED_LABEL, MARKERS, OWN_BRANCH, SKIP_LABEL, ensureSkipLabel, markerFiles, skipped, statePath, unapprove } from '../server/runner/markers';
import { setDry } from '../server/runner/log';
import { called, fail, onGh, resetGh } from './gh-mock';
import { configure, readLog, ref, root, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

/**
 * The bookkeeping both `triggers.ts` and `lifecycle.ts` read: the "already done this head" markers under
 * the state directory, the branches Sloth owns, and the two labels — the one on GitHub that records a
 * pass, and the one a person puts on an issue to keep Sloth off it.
 */

/** Marker files for a kind, written the way `launchApproved` / `launchQa` write them. */
function markers(kind: 'review' | 'approved' | 'qa', ...names: string[]): void {
  fs.mkdirSync(statePath(MARKERS[kind]), { recursive: true });
  for (const name of names) fs.writeFileSync(statePath(MARKERS[kind], name), '');
}

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  setDry(false);
});

describe('statePath', () => {
  it('is under the configured state directory', () => {
    expect(statePath('reviewed', '30-abc')).toBe(path.join(root(), 'state', 'reviewed', '30-abc'));
  });
});

describe('markerFiles', () => {
  it('finds one PR’s markers whatever head they were written for, and only that PR’s', () => {
    markers('approved', '30-abc', '30-def', '3-abc', '31-abc');
    expect(markerFiles('approved', ref(30)).sort()).toEqual(['30-abc', '30-def']);
    expect(markerFiles('approved', ref(3))).toEqual(['3-abc']);
  });

  it('keeps each kind’s markers apart — a review’s live beside an approved review’s, not among them', () => {
    markers('review', '30-abc');
    markers('approved', '30-def');
    markers('qa', '30-ghi');
    expect(markerFiles('review', ref(30))).toEqual(['30-abc']);
    expect(markerFiles('approved', ref(30))).toEqual(['30-def']);
    expect(markerFiles('qa', ref(30))).toEqual(['30-ghi']);
  });

  it('is empty before anything has ever been marked', () => {
    expect(markerFiles('review', ref(30))).toEqual([]);
  });
});

describe('OWN_BRANCH', () => {
  it('matches the branches /sloth:implement pushes to and nothing a human named', () => {
    expect(OWN_BRANCH.test('sloth/issue-42-add-login')).toBe(true);
    expect(OWN_BRANCH.test('sloth/issue-7')).toBe(true);
    expect(OWN_BRANCH.test('feature/sloth/issue-7')).toBe(false);
    expect(OWN_BRANCH.test('sloth/spike')).toBe(false);
    expect(OWN_BRANCH.test('main')).toBe(false);
  });
});

describe('skipped', () => {
  it('is the label a person puts on an issue, and no other', () => {
    expect(skipped({ labels: [SKIP_LABEL] })).toBe(true);
    expect(skipped({ labels: ['bug', APPROVED_LABEL] })).toBe(false);
    expect(skipped({ labels: [] })).toBe(false);
  });
});

describe('ensureSkipLabel', () => {
  it('creates the label in the repo, forcing it so a second boot only refreshes it', async () => {
    await ensureSkipLabel();
    expect(called(new RegExp(`^gh label create ${SKIP_LABEL} --repo acme/widgets .*--force$`))).toHaveLength(1);
  });

  it('says so and carries on when GitHub refuses — the label is a convenience, not the boot', async () => {
    onGh(/label create/, fail('HTTP 403: Resource not accessible\nsecond line'));
    await expect(ensureSkipLabel()).resolves.toBeUndefined();
    expect(readLog().join('\n')).toMatch(/label "Sloth: skip" not created in acme\/widgets: HTTP 403: Resource not accessible/);
    expect(readLog().join('\n')).not.toMatch(/second line/);
  });

  it('only logs in a dry run', async () => {
    setDry(true);
    await ensureSkipLabel();
    expect(called(/label create/)).toHaveLength(0);
    expect(readLog().join('\n')).toMatch(/dry-run: would create the "Sloth: skip" label in acme\/widgets/);
    setDry(false);
  });
});

describe('unapprove', () => {
  it('takes the pass label back off the issue and says why', async () => {
    await unapprove(ref(42), 'the head that earned it is gone');
    expect(called(new RegExp(`^gh issue edit 42 --repo acme/widgets --remove-label ${APPROVED_LABEL}$`))).toHaveLength(1);
    expect(readLog().join('\n')).toMatch(/#42 lost "Fable: approved": the head that earned it is gone/);
  });

  it('reports a refusal instead of claiming the label is gone', async () => {
    onGh(/issue edit/, fail('HTTP 404: label not found\ndetail'));
    await unapprove(ref(42), 'its checks turned red');
    const logged = readLog().join('\n');
    expect(logged).toMatch(/#42 label removal failed: HTTP 404: label not found/);
    expect(logged).not.toMatch(/#42 lost/);
  });

  it('only logs in a dry run', async () => {
    setDry(true);
    await unapprove(ref(42), 'why');
    expect(called(/issue edit/)).toHaveLength(0);
    expect(readLog().join('\n')).toMatch(/dry-run: would remove "Fable: approved" from #42 — why/);
    setDry(false);
  });
});
