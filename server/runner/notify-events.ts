import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import type { WebhookEvent } from '../config-types';
import { label, tag, untagName } from '../repos';
import { refKey, type IssueRef } from '../repo-types';
import type { BoardItem } from './board';
import { isDry, remove, write } from './log';
import { APPROVED_LABEL, marker, skipped, statePath } from './markers';
import { notifies, notify } from './notify';
import { previewLink } from './preview';

/**
 * The webhook events that are read off the board rather than raised where they happen. Each one is a
 * *state* a card can be in — parked, handed to a reviewer, approved, closed — announced once when the
 * card enters it and remembered under `state/notified/`; the marker goes when the card leaves the state,
 * so the same card coming back is announced again. Reading states instead of watching for moves catches
 * the ones a session made, the ones the server made and the ones a human made by hand, all the same.
 */

/** The needs-help markers have always been `state/notified/<issue>`; the newer events get a directory each. */
const dirOf = (event: WebhookEvent) => (event === 'needsHelp' ? statePath('notified') : statePath('notified', event));
const markerOf = (event: WebhookEvent, issue: IssueRef) => path.join(dirOf(event), tag(String(issue.number), issue.repo));

/** Only the issues: the per-event directories live beside the needs-help markers. */
function announced(event: WebhookEvent): IssueRef[] {
  try {
    return fs
      .readdirSync(dirOf(event))
      .map((f) => untagName(f))
      .filter(({ base }) => /^\d+$/.test(base))
      .map(({ base, repo }) => ({ repo, number: Number(base) }));
  } catch {
    return [];
  }
}

interface State {
  event: WebhookEvent;
  /** The cards this event is true of right now. */
  of: (board: BoardItem[]) => BoardItem[];
  /** Announced for none of these — they are still in the state, so no marker is dropped either. */
  skip?: (item: BoardItem) => boolean;
  line: (item: BoardItem) => string;
}

const inColumn = (board: BoardItem[], column: string) => (column ? board.filter((i) => i.status === column) : []);

const STATES: State[] = [
  {
    event: 'needsHelp',
    of: (b) => inColumn(b, cfg().statusField.columns.needsHelp.name),
    skip: skipped,
    line: (i) => `Sloth needs help with ${label(i)} ${i.title}`,
  },
  {
    event: 'codeReview',
    of: (b) => inColumn(b, cfg().statusField.columns.codeReview.name),
    line: (i) => `${label(i)} ${i.title} is in ${i.status} — its PR awaits Sloth's review`,
  },
  {
    event: 'finalPassed',
    of: (b) => inColumn(b, cfg().statusField.columns.approved.name).filter((i) => i.labels.includes(APPROVED_LABEL)),
    line: (i) => {
      const link = previewLink(i);
      return `${label(i)} ${i.title} passed its review — in ${i.status}, ready for a human to test${link ? `: ${link}` : ''}`;
    },
  },
  {
    // Only what Sloth itself filed away (trigger 6's marker): every issue the board ever closed is not news.
    event: 'merged',
    of: (b) => b.filter((i) => i.closed && fs.existsSync(marker('finished', String(i.number), i))),
    line: (i) => `${label(i)} ${i.title} is closed — Sloth is done with it`,
  },
];

/**
 * The other half of `finalPassed`: a card that carried the label and does not any more. Leaving the
 * Approved column is not enough — trigger 6 files a merged card to Done with its label still on, and
 * that is a card whose review passed, not one whose review has to happen again. A card that left the
 * board entirely says nothing either.
 */
async function unapproved(item: BoardItem | undefined): Promise<void> {
  if (!item || item.labels.includes(APPROVED_LABEL)) return;
  await notify('finalFailed', {
    issue: item,
    title: item.title,
    column: item.status,
    text: `${label(item)} ${item.title} lost its "${APPROVED_LABEL}" label — its review has to happen again`,
  });
}

/** Every board-read event of one tick. Nothing at all happens without a webhook URL. */
export async function boardEvents(board: BoardItem[]): Promise<void> {
  if (!cfg().helpWebhook) return;
  const byKey = new Map(board.map((i) => [refKey(i), i]));
  for (const { event, of, skip, line } of STATES) {
    const cards = of(board);
    const still = new Set(cards.map(refKey));
    const before = announced(event);
    for (const f of before) {
      if (still.has(refKey(f))) continue;
      remove(markerOf(event, f));
      // The label going is the failing verdict.
      if (event === 'finalPassed') await unapproved(byKey.get(refKey(f)));
    }
    const done = new Set(before.map(refKey));
    for (const item of cards) {
      if (done.has(refKey(item)) || skip?.(item)) continue;
      // The marker records the state, not the announcement: `finalFailed` is only ever raised by a
      // `finalPassed` marker going, so someone subscribed to the one and not the other still needs both
      // written. Only a webhook that was tried and failed leaves none, so the next tick tries again.
      const sent = notifies(event)
        ? await notify(event, { issue: item, title: item.title, column: item.status, text: line(item) })
        : true;
      if (sent && !isDry()) write(markerOf(event, item), '');
    }
  }
}
