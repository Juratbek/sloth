import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { canOrder, roleOf } from '../roles';
import type { Role } from '../roles';
import { gh } from './gh';
import { isDry, log, write } from './log';
import { isPaused } from './pause';
import { issueAlive, issueDir } from './session-dirs';
import { launch, statusReply } from './spawn';

const LOOKBACK = 60 * 60; // search window; the seen/ markers do the real de-duplication

interface Comment {
  id: number;
  login: string;
  body: string;
}

/** Issues whose comments changed in the window and mention Sloth — one search call per tick. */
async function mentioned(since: string): Promise<number[]> {
  const c = cfg();
  const q = `repo:${c.repo} is:issue "${c.mention}" in:comments updated:>=${since}`;
  const r = await gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '--jq', '.items[].number']);
  if (!r.ok) {
    log(`comment search failed: ${r.err.split('\n')[0]}`);
    return [];
  }
  return r.out.split('\n').filter(Boolean).map(Number);
}

/** The comments of one issue since the window opened. Bodies come base64'd so newlines survive. */
async function commentsOf(issue: number, since: string): Promise<Comment[]> {
  const r = await gh([
    'api', `repos/${cfg().repo}/issues/${issue}/comments?since=${since}`, '--paginate',
    '--jq', '.[] | { id: .id, login: .user.login, body: .body } | tojson | @base64',
  ]);
  if (!r.ok) return [];
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(Buffer.from(line, 'base64').toString('utf8')) as Comment);
}

/** Hands a comment to the session that is already working on the issue, with the author's role. */
function deliver(issue: number, c: Comment, role: Role): void {
  const dir = path.join(issueDir(issue), 'inbox');
  if (isDry()) {
    log(`dry-run: would deliver comment ${c.id} by ${c.login} (${role}) to #${issue}`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, `${c.id}.md`), `author: ${c.login}\nrole: ${role}\ncomment: ${c.id}\n\n${c.body}\n`);
  log(`#${issue} inbox <- comment ${c.id} by ${c.login} (${role})`);
}

/** A question ends with `?`; everything else from someone who may order is an order. */
const isOrder = (c: Comment, role: Role) => canOrder(role) && !c.body.trimEnd().endsWith('?');

/**
 * Trigger 3 — `@sloth` comments from the team. A live session gets the comment in its inbox;
 * otherwise an order (admin or developer) starts a session and anything else gets a status reply.
 * A login with no role is ignored, and marked seen so it is not looked at again. Everything else is
 * marked seen only after it was acted on, so a comment that found every slot busy is retried next tick.
 */
export async function comments(): Promise<void> {
  const c = cfg();
  const since = new Date(Date.now() - LOOKBACK * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const mention = new RegExp(c.mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const seenDir = path.join(c.stateDir, 'seen');
  fs.mkdirSync(seenDir, { recursive: true });

  for (const issue of await mentioned(since)) {
    for (const comment of await commentsOf(issue, since)) {
      if (!mention.test(comment.body) || comment.body.startsWith(c.botPrefix)) continue;
      const seen = path.join(seenDir, String(comment.id));
      if (fs.existsSync(seen)) continue;
      const role = roleOf(c.roles, comment.login);
      if (!role) log(`#${issue} ignored comment ${comment.id} by ${comment.login} (no role)`);
      else if (issueAlive(issue)) deliver(issue, comment, role);
      else if (isOrder(comment, role)) {
        // Left unseen on purpose: an order held back by the pause is picked up when Sloth resumes.
        if (isPaused()) {
          log(`paused: skipped order on #${issue}`);
          continue;
        }
        const order = `Order from ${comment.login} (${role}, issue comment ${comment.id}): ${comment.body}`;
        if (!(await launch(issue, order))) continue;
      } else statusReply(issue, String(comment.id));
      if (!isDry()) write(seen, '');
    }
  }
}
