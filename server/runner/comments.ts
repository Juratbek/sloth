import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { canAnswer, canOrder, roleOf } from '../roles';
import type { Role } from '../roles';
import { gh, graphql, react } from './gh';
import { isDry, log, remove, write } from './log';
import { isPaused } from './pause';
import { snapshot } from './board-snapshot';
import { isBlocked, issueAlive, issueDir, stateOf } from './session-dirs';
import { launch, statusReply } from './spawn';

const LOOKBACK = 60 * 60; // search window; the seen/ markers do the real de-duplication

interface Comment {
  id: number;
  login: string;
  body: string;
  /** Written on a line of the PR's diff (a review comment), not in its conversation; `path` / `line` say where. */
  review?: boolean;
  path?: string;
  line?: number;
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

/** What to read on one number this tick: its conversation, its review threads (a PR only), or both. */
interface Source {
  isPr: boolean;
  conversation: boolean;
  review: boolean;
}

/** One search, every page: a page is 30 by default and a busy hour would leave the rest unread and unmarked for ever. */
async function search(q: string, what: string): Promise<{ number: number; isPr: boolean }[]> {
  const r = await gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${q}`, '-F', 'per_page=100', '--paginate', '--jq', '.items[] | "\\(.number) \\(.pull_request != null)"']);
  if (!r.ok) {
    log(`${what} search failed: ${r.err.split('\n')[0]}`);
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
 * Where to look this tick. Issues and PRs whose conversation changed in the window and mentions Sloth
 * come from one search — but GitHub's index reads conversations only, never the comments on a diff line.
 * A review comment does bump its PR's `updated_at`, so every PR touched in the window has its review
 * threads read too, whether or not the search saw a mention there: two search calls per tick, and one
 * review-comments call per recently touched PR.
 */
async function sources(since: string): Promise<Map<number, Source>> {
  const c = cfg();
  const out = new Map<number, Source>();
  for (const { number, isPr } of await search(`repo:${c.repo} "${c.mention}" in:comments updated:>=${since}`, 'comment')) {
    out.set(number, { isPr, conversation: true, review: out.get(number)?.review ?? false });
  }
  for (const { number } of await search(`repo:${c.repo} is:pr updated:>=${since}`, 'review comment')) {
    out.set(number, { isPr: true, conversation: out.get(number)?.conversation ?? false, review: true });
  }
  return out;
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

/** Bodies come base64'd so newlines survive the line-per-comment output. */
const decode = (r: { ok: boolean; out: string }): Comment[] =>
  r.ok
    ? r.out
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(Buffer.from(line, 'base64').toString('utf8')) as Comment)
    : [];

/** The conversation comments of one issue or PR since the window opened. */
async function commentsOf(number: number, since: string): Promise<Comment[]> {
  return decode(await gh([
    'api', `repos/${cfg().repo}/issues/${number}/comments?since=${since}`, '--paginate',
    '--jq', '.[] | { id: .id, login: .user.login, body: .body } | tojson | @base64',
  ]));
}

/**
 * The comments on the diff of one PR since the window opened — every thread's opener and every reply
 * alike. `line` is where the comment sits on the current head, or where it sat when it was written
 * once the code under it has moved.
 */
async function reviewCommentsOf(pr: number, since: string): Promise<Comment[]> {
  return decode(await gh([
    'api', `repos/${cfg().repo}/pulls/${pr}/comments?since=${since}`, '--paginate',
    '--jq', '.[] | { id: .id, login: .user.login, body: .body, review: true, path: .path, line: (.line // .original_line) } | tojson | @base64',
  ]));
}

const where = (t: Thread) => (t.pr ? `PR #${t.pr}` : `#${t.issue}`);
/** How a comment is named in the log and in an order: a review comment says so, since its id lives in another namespace. */
const kindOf = (c: Comment) => (c.review ? 'review comment' : 'comment');
/** The seen marker. Review comments and conversation comments are numbered apart, so the marker says which it is. */
const seenKey = (c: Comment) => (c.review ? `review-${c.id}` : String(c.id));

/** Hands a comment to the session that is already working on the issue, with the author's role and where it was written. */
function deliver(t: Thread, c: Comment, role: Role): void {
  const dir = path.join(issueDir(t.issue), 'inbox');
  if (isDry()) {
    log(`dry-run: would deliver ${kindOf(c)} ${c.id} by ${c.login} (${role}) on ${where(t)} to #${t.issue}`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const head = [
    `author: ${c.login}`, `role: ${role}`, `comment: ${c.id}`,
    ...(t.pr ? [`pr: ${t.pr}`] : []),
    ...(c.review ? ['thread: review', ...(c.path ? [`path: ${c.path}`] : []), ...(c.line ? [`line: ${c.line}`] : [])] : []),
  ];
  write(path.join(dir, `${seenKey(c)}.md`), `${head.join('\n')}\n\n${c.body}\n`);
  log(`#${t.issue} inbox <- ${kindOf(c)} ${c.id} by ${c.login} (${role}) on ${where(t)}`);
}

/** A PR that closes no issue has no Sloth work behind it: say so where the comment was written — in its review thread when that is where. */
async function unwiredReply(t: Thread, c: Comment): Promise<void> {
  if (isDry()) {
    log(`dry-run: would tell ${c.login} on PR #${t.number} that it is wired to no issue (${kindOf(c)} ${c.id})`);
    return;
  }
  const body = `${cfg().botPrefix} This PR is not linked to an issue (no \`Closes #n\`), so there is no Sloth session behind it. Mention me on the issue, or link one to the PR.`;
  const endpoint = c.review ? `repos/${cfg().repo}/pulls/${t.number}/comments/${c.id}/replies` : `repos/${cfg().repo}/issues/${t.number}/comments`;
  const r = await gh(['api', endpoint, '-f', `body=${body}`]);
  if (!r.ok) log(`PR #${t.number} reply failed: ${r.err.split('\n')[0]}`);
  else log(`PR #${t.number}: told ${c.login} the PR is wired to no issue (${kindOf(c)} ${c.id})`);
}

/** A question ends with `?`; everything else from someone who may order is an order. */
const isOrder = (c: Comment, role: Role) => canOrder(role) && !c.body.trimEnd().endsWith('?');

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
function awaitingAnswer(issue: number): boolean {
  const dir = issueDir(issue);
  if (isBlocked(dir) || stateOf(dir).state === 'waiting') return true;
  const column = cfg().statusField.columns.needsHelp.name;
  return !!column && (snapshot()?.items ?? []).some((i) => i.number === issue && i.status === column);
}

/**
 * Trigger 3 — `@sloth` comments from the team, on an issue or on a PR (which counts as its issue's
 * thread; replies go where the comment was written — a comment on a line of the diff is answered in
 * that review thread). A live session gets the comment in its inbox; otherwise an order (admin or
 * developer) starts a session and anything else gets a status reply. A login with no role is ignored,
 * and marked seen so it is not looked at again. Everything else is marked seen only after it was acted
 * on, so a comment that found every slot busy is retried next tick.
 */
export async function comments(): Promise<void> {
  const c = cfg();
  const since = new Date(Date.now() - LOOKBACK * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const mention = new RegExp(c.mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const seenDir = path.join(c.stateDir, 'seen');
  fs.mkdirSync(seenDir, { recursive: true });

  for (const [number, source] of await sources(since)) {
    const t: Thread = source.isPr ? await threadOfPr(number) : { number, issue: number };
    // Nothing is answered and nothing is marked seen while the wiring is unknown, so the next tick
    // — with GitHub back — reads this thread again and the order still lands.
    if (t.unknown) continue;
    const unwired = source.isPr && t.issue === t.pr;
    const found = [
      ...(source.conversation ? await commentsOf(number, since) : []),
      ...(source.review ? await reviewCommentsOf(number, since) : []),
    ];
    for (const comment of found) {
      if (!mention.test(comment.body) || comment.body.startsWith(c.botPrefix)) continue;
      const seen = path.join(seenDir, seenKey(comment));
      if (fs.existsSync(seen)) continue;
      const role = roleOf(c.roles, comment.login);
      const named = `${kindOf(comment)} ${comment.id}`;
      // Read, whatever happens to it next: the 👀 says so on the comment itself. A login with no role
      // gets none — Sloth does not talk to strangers, not even with a reaction.
      if (role && !isDry()) await react(c.repo, comment.id, 'eyes', !!comment.review);
      if (!role) log(`${where(t)} ignored ${named} by ${comment.login} (no role)`);
      else if (unwired) await unwiredReply(t, comment);
      else if (issueAlive(t.issue)) deliver(t, comment, role);
      else if (isOrder(comment, role)) {
        // Left unseen on purpose: an order held back by the pause is picked up when Sloth resumes.
        if (isPaused()) {
          log(`paused: skipped order on ${where(t)}`);
          continue;
        }
        const origin = t.pr ? `PR #${t.pr} ${named}` : `issue ${named}`;
        const order = `Order from ${comment.login} (${role}, ${origin}): ${comment.body}`;
        if (!(await launch(t.issue, order))) continue;
      } else if (canAnswer(role) && awaitingAnswer(t.issue)) {
        // The comment is the answer the card is parked for, and a status reply here would be a newer
        // Sloth comment that cancels it. Trigger 6 relaunches on a conversation comment; it reads the
        // conversation only, so an answer written in a review thread is relaunched on from here.
        if (!comment.review) {
          log(`${where(t)}: ${named} by ${comment.login} (${role}) answers a parked card — trigger 6 has it`);
        } else {
          if (isPaused()) {
            log(`paused: skipped answer on ${where(t)}`);
            continue;
          }
          const hint = `Answer from ${comment.login} (${role}) in a review thread on PR #${t.pr} (review comment ${comment.id}): re-read the whole thread, the issue and the PR, and continue where the last session stopped.`;
          if (!(await launch(t.issue, hint))) continue;
          if (!isDry()) remove(path.join(issueDir(t.issue), 'retries'));
        }
      } else if (!statusReply(t.issue, String(comment.id), t.pr, !!comment.review)) {
        // Left unseen when it is held, exactly like an order: the question is answered on a later tick.
        continue;
      }
      if (!isDry()) write(seen, '');
    }
  }
}
