import path from 'node:path';
import { cfg } from '../config';
import { canAnswer, roleOf } from '../roles';
import type { Role } from '../roles';
import { freeIn } from './board';
import type { BoardItem } from './board';
import { gh } from './gh';
import { isDry, log, remove } from './log';
import { isBlocked, issueAlive, issueDir } from './session-dirs';
import { launch } from './spawn';

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
async function answerOn(issue: number): Promise<Answer | undefined> {
  const c = cfg();
  const r = await gh([
    'api', `repos/${c.repo}/issues/${issue}/comments`, '--paginate',
    '--jq', `.[] | [.id, .user.login, (.body | startswith(${JSON.stringify(c.botPrefix)}))] | @tsv`,
  ]);
  if (!r.ok) {
    log(`#${issue} thread read failed: ${r.err.split('\n')[0]}`);
    return undefined;
  }
  let answer: Answer | undefined;
  let asked = false;
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [id, login, sloth] = line.split('\t');
    if (sloth === 'true') {
      asked = true;
      answer = undefined;
      continue;
    }
    const role = roleOf(c.roles, login);
    if (asked && role && canAnswer(role)) answer ??= { id: Number(id), login, role };
  }
  return answer;
}

/**
 * Trigger 6 — parked cards whose thread got an answer. A needs-help card (or a card blocked in place
 * when no such column is configured) with no live session is relaunched once a team member's comment
 * is newer than Sloth's last comment on the issue. Only the thread is consulted, so a card parked before
 * a reboot, or by a session that has since died, counts the same as one parked a minute ago. A session
 * that parks again writes a newer Sloth comment, so the card waits for the next answer.
 */
export async function answered(board: BoardItem[]): Promise<void> {
  const col = cfg().statusField.columns;
  const parked = [
    ...(col.needsHelp.name ? freeIn(board, col.needsHelp.name) : []),
    ...freeIn(board, col.inProgress.name).filter((issue) => isBlocked(issueDir(issue))),
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
