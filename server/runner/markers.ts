import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { label, repoSlugs, tag, untagName } from '../repos';
import type { IssueRef, PrRef } from '../repo-types';
import { ensureTrelloSkipLabel } from './board-trello';
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
 * A marker named after an issue or a PR, tagged with its repository (`repos.ts` `tag`): `finished/12`,
 * `handed/30-<sha>` — with `@owner~name` on the end in every repository but the legacy one.
 */
export const marker = (dir: string, base: string, ref: IssueRef): string => statePath(dir, tag(base, ref.repo));
/** The `<pr>-<sha>` marker of one head, in the directory `kind` keeps them in (`MARKERS`). */
export const headMarker = (kind: Exclude<Kind, 'issue'>, pr: PrRef, sha: string): string => marker(MARKERS[kind], `${pr.number}-${sha}`, pr);

/**
 * Where each kind keeps its "already done this head" markers: `<pr>-<sha>` for a review (`reviewed` is the
 * older kind's, see `Kind`), `<issue>-<sha of the QA branch>` for a QA test.
 */
export const MARKERS: Record<Exclude<Kind, 'issue'>, string> = { review: 'reviewed', approved: 'approved', qa: 'qa', smoke: 'smoke' };

/** The `<pr>-…` markers of one PR, whatever head they were written for — that PR's, in its repository. */
export function markerFiles(kind: Exclude<Kind, 'issue'>, pr: PrRef): string[] {
  try {
    return fs.readdirSync(statePath(MARKERS[kind])).filter((f) => {
      const { base, repo } = untagName(f);
      return repo === pr.repo && base.startsWith(`${pr.number}-`);
    });
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
 * At start-up: the skip label exists in every repository, so a person can apply it from the issue page.
 * `--force` makes this idempotent — an existing label keeps its name and gets the colour and description refreshed.
 */
export async function ensureSkipLabel(): Promise<void> {
  if (!cfg().configured) return;
  // A Trello board's cards carry Trello labels; the issue-side label below is created as well, since a label on either side holds a card back.
  if (cfg().project.provider === 'trello') await ensureTrelloSkipLabel();
  for (const repo of repoSlugs()) {
    if (isDry()) {
      log(`dry-run: would create the "${SKIP_LABEL}" label in ${repo}`);
      continue;
    }
    const r = await gh(['label', 'create', SKIP_LABEL, '--repo', repo, '--color', 'd93f0b', '--description', 'A human owns this issue — Sloth leaves it alone', '--force']);
    if (!r.ok) log(`label "${SKIP_LABEL}" not created in ${repo}: ${r.err.split('\n')[0]}`);
  }
}

/** Takes the pass back: the head that earned it is gone, or its checks turned red after it. */
export async function unapprove(issue: IssueRef, why: string): Promise<void> {
  if (isDry()) {
    log(`dry-run: would remove "${APPROVED_LABEL}" from ${label(issue)} — ${why}`);
    return;
  }
  const r = await gh(['issue', 'edit', String(issue.number), '--repo', issue.repo, '--remove-label', APPROVED_LABEL]);
  if (r.ok) log(`${label(issue)} lost "${APPROVED_LABEL}": ${why}`);
  else log(`${label(issue)} label removal failed: ${r.err.split('\n')[0]}`);
}
