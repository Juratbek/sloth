import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { gh } from './gh';
import { isDry, log } from './log';
import type { Kind } from './session-dirs';

/**
 * The bookkeeping both `triggers.ts` and `lifecycle.ts` read: the dedupe markers under
 * `~/.sloth/state/`, the branches Sloth owns, and the one marker that lives on GitHub instead of on
 * disk — the `Fable: approved` label. Keeping them here means neither module has to import the other.
 */

export const statePath = (...parts: string[]) => path.join(cfg().stateDir, ...parts);

/** Where each review kind keeps its `<pr>-<sha>` "already reviewed this head" markers. */
export const MARKERS: Record<Exclude<Kind, 'issue'>, string> = { review: 'reviewed', approved: 'approved' };

/** The `<pr>-…` markers of one PR, whatever head they were written for. */
export function markerFiles(kind: Exclude<Kind, 'issue'>, pr: number): string[] {
  try {
    return fs.readdirSync(statePath(MARKERS[kind])).filter((f) => f.startsWith(`${pr}-`));
  } catch {
    return [];
  }
}

/** The branches `/sloth:implement` pushes to — its reviewer loop already vetted that head before the hand-off. */
export const OWN_BRANCH = /^sloth\/issue-\d+/;

/** The label `/sloth:review <pr> final` puts on a wired issue whose PR passed; a failing final review removes it. */
export const APPROVED_LABEL = 'Fable: approved';

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
