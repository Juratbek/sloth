import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import * as trello from '../trello';
import type { TrelloComment } from '../trello';
import { roleOf } from '../roles';
import { cardIdOf, issueOfCard, linkCardToIssue } from './board-trello';
import { deliver } from './comments';
import { gh } from './gh';
import { isDry, log, write } from './log';
import { issueDir, stateOf } from './session-dirs';

/**
 * The card's comments and the issue's are one conversation. A person on a Trello board writes on the
 * card — that is the board they use; the sessions, the status replies and the park comments write on
 * the GitHub issue behind it — that is the thread they read. So every comment on a linked card is
 * copied onto its issue with the author's name on it (`**@name on Trello:**`), where trigger 3 reads it
 * as that person's — `mirrorAuthor` gives it back its author and its body — and every comment on a
 * linked issue that is not such a copy is copied onto the card: Sloth's own words as they are, a
 * person's under their GitHub login. Once each way, remembered under `state/mirrored/`; the window is
 * the last hour, like the mention search, and nothing older than the first run of the mirror is copied.
 *
 * The header is honoured only on a comment this mirror wrote (`c-<comment id>` under `state/mirrored/`):
 * anyone who can write on the issue can type `**@admin on Trello:**`, and without the marker that line
 * would make them the admin. Off Trello no comment is ever a copy.
 */

const LOOKBACK = 60 * 60;
const HEADER = /^\*\*@([\w.-]+) on Trello:\*\*\n\n?/;
const ownWords = (body: string) => body.startsWith(cfg().botPrefix);

const mirrorDir = () => path.join(cfg().stateDir, 'mirrored');
const seen = (key: string) => fs.existsSync(path.join(mirrorDir(), key));
const mark = (key: string) => {
  if (!isDry()) write(path.join(mirrorDir(), key), '');
};

/** When the mirror first ran on this machine — the floor under the window, so an old conversation is not copied on the first tick. */
function floor(): number {
  const file = path.join(mirrorDir(), 'started');
  try {
    const at = Number(fs.readFileSync(file, 'utf8'));
    if (at) return at;
  } catch {
    /* first run */
  }
  const now = Date.now();
  fs.mkdirSync(mirrorDir(), { recursive: true });
  fs.writeFileSync(file, String(now));
  return now;
}

const since = () => new Date(Math.max(Date.now() - LOOKBACK * 1000, floor())).toISOString().replace(/\.\d+Z$/, 'Z');

/** A copy this mirror made, as trigger 3 should see it: the Trello author's name and their own words. Any other comment as it is, header or not. */
export function mirrorAuthor<T extends { id: number; login: string; body: string }>(c: T): T {
  if (cfg().project.provider !== 'trello' || !seen(`c-${c.id}`)) return c;
  const m = HEADER.exec(c.body);
  return m ? { ...c, login: m[1], body: c.body.slice(m[0].length) } : c;
}

const PRUNE_AFTER = 30 * 24 * 60 * 60 * 1000;
let pruned = false;
/** The markers outlive the window they guard by a month, then go — one file per comment for ever is not a state directory. */
function prune(): void {
  if (pruned) return;
  pruned = true;
  const dir = mirrorDir();
  const cutoff = Date.now() - PRUNE_AFTER;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'started') continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      /* gone already */
    }
  }
}

/** The issues the mirror just wrote on: trigger 3 reads them this very tick, ahead of the search index. */
const pending = new Set<number>();
export function takePending(): number[] {
  const out = [...pending];
  pending.clear();
  return out;
}

let myId: string | undefined;
async function me(): Promise<string> {
  return (myId ??= (await trello.me()).id);
}

/** The Trello token's own comments are Sloth's — never copied back. */
const mine = (c: TrelloComment, id: string) => c.memberId === id;

/** Card comments onto their issues. A comment on a card that has no issue yet gets one opened — a person talking to Sloth on a card is work. */
async function cardsToIssues(): Promise<void> {
  const self = await me();
  const mention = new RegExp(cfg().mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  for (const c of await trello.boardComments(cfg().project.id, since())) {
    const key = `t-${c.id}`;
    if (mine(c, self) || seen(key) || !c.username) continue;
    let issue = issueOfCard(c.cardId);
    if (!issue && mention.test(c.text)) issue = await linkCardToIssue(c.cardId);
    if (!issue) {
      mark(key);
      continue;
    }
    const body = `**@${c.username} on Trello:**\n\n${c.text}`;
    if (isDry()) {
      log(`dry-run: would copy Trello comment by ${c.username} onto #${issue}`);
      continue;
    }
    const copied = await gh(['api', `repos/${cfg().repo}/issues/${issue}/comments`, '-f', `body=${body}`, '--jq', '.id']);
    if (!copied.ok) {
      log(`#${issue} <- Trello comment by ${c.username} failed: ${copied.err.split('\n')[0]}`);
      continue;
    }
    log(`#${issue} <- Trello comment by ${c.username}`);
    mark(key);
    const id = Number(copied.out.trim());
    if (id) mark(`c-${id}`);
    const role = roleOf(cfg().roles, c.username);
    // Trigger 3 reads a mention and decides; anything else written to a session that is waiting for an
    // answer is delivered as the session's own thread poll would find it, without the wait.
    if (mention.test(c.text) || !role || !id || stateOf(issueDir(issue)).state !== 'waiting') pending.add(issue);
    else {
      deliver({ number: issue, issue }, { id, login: c.username, body: c.text }, role);
      write(path.join(cfg().stateDir, 'seen', String(id)), '');
    }
  }
}

interface IssueComment {
  id: number;
  issue: number;
  login: string;
  body: string;
}

/** Every conversation comment in the repository since the window opened — one paginated call, the PRs' included and dropped. */
async function issueComments(): Promise<IssueComment[]> {
  const r = await gh([
    'api', `repos/${cfg().repo}/issues/comments?since=${since()}&per_page=100`, '--paginate',
    '--jq', '.[] | { id: .id, issue: (.issue_url | split("/") | last | tonumber), login: .user.login, body: .body } | tojson | @base64',
  ]);
  if (!r.ok) {
    log(`mirror: issue comments not read — ${r.err.split('\n')[0]}`);
    return [];
  }
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(Buffer.from(line, 'base64').toString('utf8')) as IssueComment);
}

/** Issue comments onto their cards: Sloth's as they are, a person's under their login, a copy never. */
async function issuesToCards(): Promise<void> {
  for (const c of await issueComments()) {
    const key = `g-${c.id}`;
    if (seen(key) || HEADER.test(c.body)) continue;
    const card = cardIdOf(c.issue);
    if (!card) continue;
    const text = ownWords(c.body) ? c.body : `**@${c.login} on GitHub:**\n\n${c.body}`;
    if (isDry()) {
      log(`dry-run: would copy comment ${c.id} on #${c.issue} onto its Trello card`);
      continue;
    }
    try {
      await trello.commentCard(card, text);
      log(`#${c.issue} -> Trello card: comment ${c.id} by ${c.login}`);
      mark(key);
    } catch (e) {
      log(`#${c.issue} -> Trello card failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
}

/** Both ways, the cards first so a question written on a card is on its issue before trigger 3 reads. Nothing to do off Trello. */
export async function mirrorComments(): Promise<void> {
  if (cfg().project.provider !== 'trello') return;
  fs.mkdirSync(mirrorDir(), { recursive: true });
  prune();
  try {
    await cardsToIssues();
  } catch (e) {
    log(`mirror: card comments not read — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  await issuesToCards();
}
