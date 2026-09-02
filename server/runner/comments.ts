import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { canOrder, roleOf } from '../roles';
import type { Role } from '../roles';
import { gh, graphql } from './gh';
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

/** Where a comment was written: the issue itself, or a PR — then `issue` is the one the PR closes. */
interface Thread {
  /** The number the comments are read from and replies go to. */
  number: number;
  /** The issue the thread belongs to — the PR's own number when it closes none. */
  issue: number;
  pr?: number;
  /** The PR→issue lookup failed: what this PR is wired to is unknown, so nothing may be decided from it. */
  unknown?: boolean;
}

/** Issues and PRs whose comments changed in the window and mention Sloth — one search call per tick. */
async function mentioned(since: string): Promise<{ number: number; isPr: boolean }[]> {
  const c = cfg();
  const q = `repo:${c.repo} "${c.mention}" in:comments updated:>=${since}`;
  const r = await gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '--jq', '.items[] | "\\(.number) \\(.pull_request != null)"']);
  if (!r.ok) {
    log(`comment search failed: ${r.err.split('\n')[0]}`);
    return [];
  }
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [n, pr] = line.split(' ');
      return { number: Number(n), isPr: pr === 'true' };
    });
}

/**
 * The issue a PR belongs to: the first one it closes (`Closes #n`), else the number in a
 * `sloth/issue-<n>-…` head branch. A PR wired to neither is its own thread — but only when GitHub
 * answered: a lookup that failed says nothing about the wiring, and reading it as "wired to nothing"
 * would answer a real order with "this PR is not linked to an issue" and mark it seen for good.
 */
async function threadOfPr(pr: number): Promise<Thread> {
  const [owner, name] = cfg().repo.split('/');
  try {
    const data = await graphql(
      `{ repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr}) { headRefName closingIssuesReferences(first: 5) { nodes { number } } } } }`,
    );
    const p = data.repository?.pullRequest ?? {};
    const closes = Number(p.closingIssuesReferences?.nodes?.[0]?.number);
    const branch = Number(/^sloth\/issue-(\d+)-/.exec(String(p.headRefName ?? ''))?.[1]);
    const issue = closes || branch;
    if (issue) return { number: pr, issue, pr };
  } catch (e) {
    const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
    log(`PR #${pr}: issue lookup failed (${why}) — its comments wait for the next tick`);
    return { number: pr, issue: pr, pr, unknown: true };
  }
  return { number: pr, issue: pr, pr };
}

/** The conversation comments of one issue or PR since the window opened. Bodies come base64'd so newlines survive. */
async function commentsOf(number: number, since: string): Promise<Comment[]> {
  const r = await gh([
    'api', `repos/${cfg().repo}/issues/${number}/comments?since=${since}`, '--paginate',
    '--jq', '.[] | { id: .id, login: .user.login, body: .body } | tojson | @base64',
  ]);
  if (!r.ok) return [];
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(Buffer.from(line, 'base64').toString('utf8')) as Comment);
}

const where = (t: Thread) => (t.pr ? `PR #${t.pr}` : `#${t.issue}`);

/** Hands a comment to the session that is already working on the issue, with the author's role and where it was written. */
function deliver(t: Thread, c: Comment, role: Role): void {
  const dir = path.join(issueDir(t.issue), 'inbox');
  if (isDry()) {
    log(`dry-run: would deliver comment ${c.id} by ${c.login} (${role}) on ${where(t)} to #${t.issue}`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const head = [`author: ${c.login}`, `role: ${role}`, `comment: ${c.id}`, ...(t.pr ? [`pr: ${t.pr}`] : [])];
  write(path.join(dir, `${c.id}.md`), `${head.join('\n')}\n\n${c.body}\n`);
  log(`#${t.issue} inbox <- comment ${c.id} by ${c.login} (${role}) on ${where(t)}`);
}

/** A PR that closes no issue has no Sloth work behind it: say so where the comment was written. */
async function unwiredReply(t: Thread, c: Comment): Promise<void> {
  if (isDry()) {
    log(`dry-run: would tell ${c.login} on PR #${t.number} that it is wired to no issue (comment ${c.id})`);
    return;
  }
  const body = `${cfg().botPrefix} This PR is not linked to an issue (no \`Closes #n\`), so there is no Sloth session behind it. Mention me on the issue, or link one to the PR.`;
  const r = await gh(['api', `repos/${cfg().repo}/issues/${t.number}/comments`, '-f', `body=${body}`]);
  if (!r.ok) log(`PR #${t.number} reply failed: ${r.err.split('\n')[0]}`);
  else log(`PR #${t.number}: told ${c.login} the PR is wired to no issue (comment ${c.id})`);
}

/** A question ends with `?`; everything else from someone who may order is an order. */
const isOrder = (c: Comment, role: Role) => canOrder(role) && !c.body.trimEnd().endsWith('?');

/**
 * Trigger 3 — `@sloth` comments from the team, on an issue or on a PR (which counts as its issue's
 * thread; replies go where the comment was written). A live session gets the comment in its inbox;
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

  for (const { number, isPr } of await mentioned(since)) {
    const t: Thread = isPr ? await threadOfPr(number) : { number, issue: number };
    // Nothing is answered and nothing is marked seen while the wiring is unknown, so the next tick
    // — with GitHub back — reads this thread again and the order still lands.
    if (t.unknown) continue;
    const unwired = isPr && t.issue === t.pr;
    for (const comment of await commentsOf(number, since)) {
      if (!mention.test(comment.body) || comment.body.startsWith(c.botPrefix)) continue;
      const seen = path.join(seenDir, String(comment.id));
      if (fs.existsSync(seen)) continue;
      const role = roleOf(c.roles, comment.login);
      if (!role) log(`${where(t)} ignored comment ${comment.id} by ${comment.login} (no role)`);
      else if (unwired) await unwiredReply(t, comment);
      else if (issueAlive(t.issue)) deliver(t, comment, role);
      else if (isOrder(comment, role)) {
        // Left unseen on purpose: an order held back by the pause is picked up when Sloth resumes.
        if (isPaused()) {
          log(`paused: skipped order on ${where(t)}`);
          continue;
        }
        const origin = t.pr ? `PR #${t.pr} comment ${comment.id}` : `issue comment ${comment.id}`;
        const order = `Order from ${comment.login} (${role}, ${origin}): ${comment.body}`;
        if (!(await launch(t.issue, order))) continue;
      } else if (!statusReply(t.issue, String(comment.id), t.pr)) {
        // Left unseen when it is held, exactly like an order: the question is answered on a later tick.
        continue;
      }
      if (!isDry()) write(seen, '');
    }
  }
}
