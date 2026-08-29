import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { gh } from './gh';
import { isDry, log } from './log';
import { APPROVED_LABEL, SKIP_LABEL, skipped } from '../board-types';
import type { Kind } from './session-dirs';

/**
 * The bookkeeping both `triggers.ts` and `lifecycle.ts` read: the dedupe markers under
 * `~/.sloth/state/`, the branches Sloth owns, and the one marker that lives on GitHub instead of on
 * disk — the `Fable: approved` label — and the `Sloth: skip` label people use to hold a card back.
 * Keeping them here means neither module has to import the other.
 */

export const statePath = (...parts: string[]) => path.join(cfg().stateDir, ...parts);

/**
 * Where each kind keeps its "already done this head" markers: `<pr>-<sha>` for a review (`reviewed` is the
 * older kind's, see `Kind`), `<issue>-<sha of the QA branch>` for a QA test.
 */
export const MARKERS: Record<Exclude<Kind, 'issue'>, string> = { review: 'reviewed', approved: 'approved', qa: 'qa' };

/** The `<pr>-…` markers of one PR, whatever head they were written for. */
export function markerFiles(kind: Exclude<Kind, 'issue'>, pr: number): string[] {
  try {
    return fs.readdirSync(statePath(MARKERS[kind])).filter((f) => f.startsWith(`${pr}-`));
  } catch {
    return [];
  }
}

/** The branches `/sloth:implement` pushes to — the PRs whose checks and branches are Sloth's to fix and delete. */
export const OWN_BRANCH = /^sloth\/issue-\d+/;

/** The label `/sloth:review <pr> final` puts on a wired issue whose PR passed; a failing review removes it. */
export { APPROVED_LABEL };

/** The label a person puts on an issue to keep Sloth off it (`skipped` reads it off a card). */
export { SKIP_LABEL, skipped };

/**
 * At start-up: the skip label exists in the repo, so a person can apply it from the issue page. `--force`
 * makes this idempotent — an existing label keeps its name and gets the colour and description refreshed.
 */
export async function ensureSkipLabel(): Promise<void> {
  if (!cfg().configured) return;
  if (isDry()) {
    log(`dry-run: would create the "${SKIP_LABEL}" label in ${cfg().repo}`);
    return;
  }
  const r = await gh([
    'label', 'create', SKIP_LABEL, '--repo', cfg().repo, '--color', 'd93f0b',
    '--description', 'A human owns this issue — Sloth leaves it alone', '--force',
  ]);
  if (!r.ok) log(`label "${SKIP_LABEL}" not created: ${r.err.split('\n')[0]}`);
}

/** Takes the pass back: the head that earned it is gone, or its checks turned red after it. */
export async function unapprove(issue: number, why: string): Promise<void> {
  if (isDry()) {
    log(`dry-run: would remove "${APPROVED_LABEL}" from #${issue} — ${why}`);
    return;
  }
  const r = await gh(['issue', 'edit', String(issue), '--repo', cfg().repo, '--remove-label', APPROVED_LABEL]);
  if (r.ok) log(`#${issue} lost "${APPROVED_LABEL}": ${why}`);
  else log(`#${issue} label removal failed: ${r.err.split('\n')[0]}`);
}
