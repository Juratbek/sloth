import path from 'node:path';
import { cfg } from '../config';
import { label } from '../repos';
import type { IssueRef } from '../repo-types';
import { canAnswer, roleOf } from '../roles';
import type { Role } from '../roles';
import { wroteIt } from './bot';
import { freeIn } from './board';
import type { BoardItem } from './board';
import { parkedColumns } from './columns';
import { gh } from './gh';
import { isDry, log, remove } from './log';
import { isBlocked, issueAlive, issueDir } from './session-dirs';
import { launch } from './spawn';
import { mirrorAuthor } from './trello-mirror';

interface Answer {
  id: number;
  login: string;
  role: Role;
}

/**
 * The first comment from someone with a role after Sloth's last comment on the issue — the answer a
 * parked card waits for. Undefined when Sloth never wrote there (a human parked the card by hand) or
 * nobody on the team replied since; a comment from a login with no role does not count.
 */
async function answerOn(issue: IssueRef): Promise<Answer | undefined> {
  const c = cfg();
  const r = await gh([
    'api', `repos/${issue.repo}/issues/${issue.number}/comments`, '--paginate',
    '--jq', '.[] | [.id, .user.login, (.body | @base64)] | @tsv',
  ]);
  if (!r.ok) {
    log(`${label(issue)} thread read failed: ${r.err.split('\n')[0]}`);
    return undefined;
  }
  let answer: Answer | undefined;
  let asked = false;
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [id, author, encoded] = line.split('\t');
    const body = Buffer.from(encoded ?? '', 'base64').toString('utf8');
    // Sloth's own comment is the question this card waits on an answer to — but only when Sloth wrote it.
    if (wroteIt(author ?? '', body)) {
      asked = true;
      answer = undefined;
      continue;
    }
    // A comment the Trello mirror copied onto the issue is its Trello author's answer, not the login that copied it.
    const { login } = mirrorAuthor({ id: Number(id), login: author, body });
    const role = roleOf(c.roles, login);
    if (asked && role && canAnswer(role)) answer ??= { id: Number(id), login, role };
  }
  return answer;
}

/**
 * Trigger 6 — parked cards whose thread got an answer. A needs-help card, or one parked in place, with no
 * live session is relaunched once a team member's comment is newer than Sloth's last comment on the issue.
 * Only the thread is consulted, so a card parked before a reboot, or by a session that has since died,
 * counts the same as one parked a minute ago. A session that parks again writes a newer Sloth comment, so
 * the card waits for the next answer.
 *
 * A card is parked in place — a `blocked` marker, the card left where it stood — whenever the move to
 * needs-help was refused or there is no needs-help column, and `park` is called with the card in Code
 * Review (a review given up or stopped) and in Approved (a PR closed unmerged) as well as In Progress.
 * Only In Progress used to be scanned for the marker, so a review given up on a board with no needs-help
 * column left its card in Code Review for good: nothing looked there again, and the park comment's promise
 * that answering in the thread continues the work was not kept. Every column a card can be parked in is
 * scanned instead — not the pickup column, which the same comment offers as the way to start over.
 */
export async function answered(board: BoardItem[]): Promise<void> {
  const col = cfg().statusField.columns;
  const needsHelp = col.needsHelp.name;
  const parked = [
    ...(needsHelp ? freeIn(board, needsHelp) : []),
    ...parkedColumns()
      .filter((name) => name !== needsHelp)
      .flatMap((name) => freeIn(board, name))
      .filter((issue) => isBlocked(issueDir(issue))),
  ];
  for (const issue of parked) {
    if (issueAlive(issue)) continue;
    const answer = await answerOn(issue);
    if (!answer) continue;
    const hint = `Answer from ${answer.login} (${answer.role}) in the issue thread (comment ${answer.id}): re-read the whole thread and continue where the last session stopped.`;
    if (!(await launch(issue, hint))) break;
    if (!isDry()) remove(path.join(issueDir(issue), 'retries'));
  }
}
