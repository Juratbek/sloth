import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import type { BlockedCard } from '../board-types';
import { label, tag, untagName } from '../repos';
import { refKey, type IssueRef } from '../repo-types';
import type { BoardItem } from './board';
import { comment } from './gh';
import { isDry, log, nowSec, readFile, remove, write } from './log';
import { MARKERS, markerFiles, statePath } from './markers';
import { helpMentions, notify } from './notify';
import { qaDir } from './session-dirs';

/**
 * The cards Sloth has given up on. Every other way a run ends badly hands the card to a human where a
 * human is looking — `park` comments and moves it to the needs-help column — but the QA sweep had one
 * ending that told nobody: `maxRetries + 1` tests of one head that all died before writing a verdict.
 * The sweep wrote the same "tested this head" marker a passed test writes and moved on, so the card sat
 * in QA looking untested, and nothing short of the QA branch moving would ever pick it up again.
 *
 * A block is that ending made visible and undoable: one file per issue under `state/blocked/`, a comment
 * on the issue, the `blocked` webhook event, a badge on the card and a row on the home panel with the
 * button that lifts it. It clears itself when the card leaves the QA column, because a card a human has
 * moved on is no longer the sweep's to give up on.
 */

const dir = () => statePath('blocked');
const fileOf = (issue: IssueRef) => path.join(dir(), tag(String(issue.number), issue.repo));

export function blockedOf(issue: IssueRef): BlockedCard | undefined {
  try {
    return { ...(JSON.parse(readFile(fileOf(issue)) ?? '') as BlockedCard), repo: issue.repo };
  } catch {
    return undefined;
  }
}

export const isCardBlocked = (issue: IssueRef): boolean => fs.existsSync(fileOf(issue));

/** Every blocked card, newest block first — what the home panel lists. */
export function blockedCards(): BlockedCard[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return [];
  }
  return names
    .map((n) => untagName(n))
    .filter(({ base }) => /^\d+$/.test(base))
    .flatMap(({ base, repo }) => blockedOf({ repo, number: Number(base) }) ?? [])
    .sort((a, b) => b.at - a.at);
}

/**
 * Gives up on a card, once: the record, then the comment and the webhook. Already blocked is not blocked
 * again — the sweep meets the card on every head of the branch, and one give-up is one announcement.
 */
export async function block(item: BoardItem, reason: string, sha: string): Promise<void> {
  if (isCardBlocked(item)) return;
  const c = cfg();
  const cc = helpMentions();
  const column = c.statusField.columns.qa.name;
  const body = `${c.botPrefix} ${reason} The card is **blocked**: Sloth will not test it again on its own. Unblock it from the monitor to hand it back to the sweep, or move the card out of **${column}** to clear the block.${cc ? `\n\ncc ${cc}` : ''}`;
  if (isDry()) {
    log(`dry-run: would block ${label(item)} — ${reason}`);
    return;
  }
  write(fileOf(item), JSON.stringify({ repo: item.repo, issue: item.number, title: item.title, reason, sha, at: nowSec() } satisfies BlockedCard));
  log(`${label(item)} blocked: ${reason}`);
  await comment(item.repo, item.number, body);
  await notify('blocked', { issue: item, title: item.title, column, text: `${label(item)} is blocked: ${reason}` });
}

/**
 * Hands a blocked card back to the sweep. The block goes, and with it the two things that would make the
 * next sweep skip it or give up on it a second time: the "already tested this head" markers, and the
 * run's own count of tests that ended without a verdict. Returns false when the card was not blocked.
 */
export function unblock(issue: IssueRef, why: string): boolean {
  if (!isCardBlocked(issue)) return false;
  if (isDry()) {
    log(`dry-run: would unblock ${label(issue)} — ${why}`);
    return true;
  }
  remove(fileOf(issue));
  for (const f of markerFiles('qa', issue)) remove(statePath(MARKERS.qa, f));
  remove(path.join(qaDir(issue), 'retries'));
  log(`${label(issue)} unblocked (${why}) — the QA sweep will test it again`);
  return true;
}

/** A card that has left the QA column is no longer the sweep's: its block leaves with it. */
export function pruneBlocked(board: BoardItem[]): void {
  const column = cfg().statusField.columns.qa.name;
  const inQa = new Set(board.filter((i) => i.status === column && !i.closed).map(refKey));
  for (const b of blockedCards()) {
    const issue = { repo: b.repo, number: b.issue };
    if (!inQa.has(refKey(issue))) unblock(issue, column ? `the card left ${column}` : 'no QA column');
  }
}
