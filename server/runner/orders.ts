import { SKIP_LABEL, skipped } from '../board-types';
import { cfg } from '../config';
import { label } from '../repos';
import { refKey, type IssueRef } from '../repo-types';
import { canOrder, type Role } from '../roles';
import { snapshot } from './board-snapshot';
import { gh } from './gh';
import { isDry, log } from './log';
import { isBlocked, issueDir, reviewAlive, stateOf } from './session-dirs';
import type { Comment, Thread } from './comments';

/**
 * What trigger 3 has to know about one comment before it acts on it: how to name it, whether it is an
 * order or a question, whether the card it is on is waiting for an answer, whether an order may start a
 * session at all — and how to write back where the comment was written.
 */

/** Where a comment was written: the issue itself, or a PR. */
export const where = (t: Thread): string => (t.pr ? `PR #${t.pr.number}` : label(t.issue));
/** How a comment is named in the log and in an order: a review comment says so, since its id lives in another namespace. */
export const kindOf = (c: Comment): string => (c.review ? 'review comment' : 'comment');
/** The seen marker. Review comments and conversation comments are numbered apart, so the marker says which it is. */
export const seenKey = (c: Comment): string => (c.review ? `review-${c.id}` : String(c.id));

/** A question ends with `?`; everything else from someone who may order is an order. */
export const isOrder = (c: Comment, role: Role): boolean => canOrder(role) && !c.body.trimEnd().endsWith('?');

/** Sloth's answer, in the thread the comment was written in — a review thread's reply goes under its comment. */
export async function replyTo(t: Thread, c: Comment, body: string): Promise<boolean> {
  const endpoint = c.review ? `repos/${t.repo}/pulls/${t.number}/comments/${c.id}/replies` : `repos/${t.repo}/issues/${t.number}/comments`;
  const r = await gh(['api', endpoint, '-f', `body=${cfg().botPrefix} ${body}`]);
  if (!r.ok) log(`${where(t)} reply failed: ${r.err.split('\n')[0]}`);
  return r.ok;
}

/** A PR that closes no issue has no Sloth work behind it: say so where the comment was written. */
export async function unwiredReply(t: Thread, c: Comment): Promise<void> {
  if (isDry()) {
    log(`dry-run: would tell ${c.login} on PR #${t.number} that it is wired to no issue (${kindOf(c)} ${c.id})`);
    return;
  }
  const said = await replyTo(t, c, 'This PR is not linked to an issue (no `Closes #n`), so there is no Sloth session behind it. Mention me on the issue, or link one to the PR.');
  if (said) log(`PR #${t.number}: told ${c.login} the PR is wired to no issue (${kindOf(c)} ${c.id})`);
}

/**
 * Whether this card is waiting for a human's answer: parked in the needs-help column, blocked in place
 * where there is none, or left by a run that stopped to ask. Any of the three makes a team member's
 * comment the answer trigger 6 relaunches on, which is what the docs promise — "on a card in *Sloth
 * needs help*, a comment from anyone on the team is the answer the session waits for".
 *
 * It matters here because of what a status reply would do instead. The reply is a `**Sloth:**` comment,
 * and `answerOn` reads Sloth's last comment as the question being asked: a reply written *after* the
 * tester's answer cancels it, the next board tick finds nothing newer than Sloth, and the card stays
 * parked for ever. The board is the previous tick's read, which is enough — the two markers cover a
 * card parked since it was taken.
 */
export function awaitingAnswer(issue: IssueRef): boolean {
  const dir = issueDir(issue);
  if (isBlocked(dir) || stateOf(dir).state === 'waiting') return true;
  const column = cfg().statusField.columns.needsHelp.name;
  return !!column && (snapshot()?.items ?? []).some((i) => refKey(i) === refKey(issue) && i.status === column);
}

/** Whether a human has taken this card over, on the board the loop last read. */
const heldByHuman = (issue: IssueRef): boolean => (snapshot()?.items ?? []).some((i) => refKey(i) === refKey(issue) && skipped(i));

/**
 * Why an order may not start a session on this card now — one actor owns a card at a time, and a card a
 * human took over is not Sloth's to start work on at all.
 *
 * `wait` means the order is left unseen and lands on a later tick: a live review is reading the diff of
 * the very branch the session would push to, and would post its verdict on a head that had moved under
 * it and move the card by that verdict. Trigger 4 waits for an implement session for the same reason;
 * nothing used to wait the other way round, so `@sloth address the review comments`, written while the
 * review ran, started a second actor on the card. `Sloth: skip` is the other direction and is final:
 * `launch` has no check of its own, and the order path was the only caller that did not filter for the
 * label — a comment could put Sloth back on a card a person had taken by hand.
 */
export interface OrderHold {
  /** For `watcher.log`. */
  why: string;
  /** What to write back in the thread the order was given in, so nobody is left waiting on a silence. */
  reply: string;
}

/**
 * Both holds answer and are marked seen rather than left for a later tick. Leaving the comment unseen
 * looked kinder — the order would land once the review ended — but `commentsOf` reads only the last hour
 * (`LOOKBACK`) and a review may run to its whole budget, so an order held that way could fall out of the
 * window and never be acted on at all, after Sloth had already put 👀 on it.
 */
export function orderHold(issue: IssueRef): OrderHold | undefined {
  if (reviewAlive(issue)) {
    return {
      why: 'the review of its PR is still running',
      reply: 'The review of this card is still running, and one actor owns a card at a time — I have not started on this. Say the word again once the verdict is on the PR.',
    };
  }
  if (heldByHuman(issue)) {
    return {
      why: `the card is labelled ${SKIP_LABEL}, so a human owns it`,
      reply: `This card is labelled **${SKIP_LABEL}**, so a person owns it and Sloth leaves it alone. Take the label off and say the word again for Sloth to pick it up.`,
    };
  }
  return undefined;
}
