import { SKIP_LABEL } from '../board-types';
import { cfg } from '../config';
import type { ColumnRef } from '../config-types';
import { label, repoSlugs, several } from '../repos';
import { issueUrl, refKey, type IssueRef } from '../repo-types';
import * as trello from '../trello';
import type { TrelloCard, TrelloList } from '../trello';
import type { BoardItem, MoveOutcome } from './board';
import { gh, graphql } from './gh';
import { isDry, log } from './log';
import { chooseRepo } from './repo-choice';

/**
 * A Trello board as Sloth's board: its lists are the columns, its cards the work. The sessions work
 * GitHub issues and PRs — that is where the code, the comments and the reviews live — so every card
 * Sloth works is linked to an issue: a card that carries an issue's URL (an attachment, or the URL in
 * its description) of one of Sloth's repositories is that issue's card; a card in the pickup list that
 * carries none gets an issue opened for it, titled and described as the card is, in the repository the
 * card belongs in (`repo-choice.ts`), and the URL attached to the card so the link holds. The issue's
 * own facts a trigger needs — closed, `Fable: approved`, `Sloth: skip` — are read off GitHub in one
 * query per repository for every linked card, so a label on either side counts.
 */

/** The card of each linked issue and the issue of each linked card, from the last read — what a move and the comment mirror need. */
let cardIds = new Map<string, string>();
let issueIds = new Map<string, IssueRef>();
export const cardIdOf = (issue: IssueRef): string | undefined => cardIds.get(refKey(issue));
export const issueOfCard = (cardId: string): IssueRef | undefined => issueIds.get(cardId);

const boardId = () => cfg().project.id;

const issueUrlRe = (repo: string) => new RegExp(`https://github\\.com/${repo.replace(/[.]/g, '\\.')}/issues/(\\d+)\\b`, 'i');

/** The issue a card is linked to: the first issue URL of one of Sloth's repositories among its attachments, then its description. */
export function issueOf(card: TrelloCard, repos = repoSlugs()): IssueRef | undefined {
  const texts = [...(card.attachments ?? []).map((a) => a.url), card.desc ?? ''];
  for (const text of texts) {
    for (const repo of repos) {
      const m = issueUrlRe(repo).exec(text);
      if (m) return { repo, number: Number(m[1]) };
    }
  }
  return undefined;
}

const labelNames = (card: TrelloCard) => card.labels.map((l) => l.name).filter(Boolean);

/**
 * The issue already opened for this card, when the attaching failed last time: every issue Sloth opens
 * names the card's URL in its body, so the repositories are asked before a second one is opened.
 */
async function issueFor(card: TrelloCard): Promise<IssueRef | undefined> {
  for (const repo of repoSlugs()) {
    const r = await gh(['issue', 'list', '--repo', repo, '--state', 'all', '--search', `"${card.shortUrl}" in:body`, '--json', 'number', '--jq', '.[0].number']);
    const number = Number(r.out.trim());
    if (r.ok && number) return { repo, number };
  }
  return undefined;
}

/** Puts the issue's URL on the card — an attachment, or the description when Trello refuses that — with a comment saying where to talk. */
async function linkCard(card: TrelloCard, issue: IssueRef): Promise<void> {
  const link = issueUrl(issue);
  try {
    await trello.attach(card.id, link, `GitHub issue ${label(issue)}`);
  } catch (e) {
    log(`Trello card "${card.name}": issue ${label(issue)} not attached, writing it into the description — ${e instanceof Error ? e.message : String(e)}`);
    await trello.describe(card.id, `${card.desc?.trim() ? `${card.desc.trim()}\n\n` : ''}GitHub issue: ${link}`);
  }
  await trello.commentCard(card.id, `Sloth is on this card${several() ? ` in ${issue.repo}` : ''}. Comment here to talk to it — mention ${cfg().mention} to ask or to give an order — and it answers here.`);
}

/** A card the mirror met before the board read did — someone commented on it: linked to its issue, opened now when it has none. */
export async function linkCardToIssue(cardId: string): Promise<IssueRef | undefined> {
  const card = await trello.card(cardId);
  const issue = issueOf(card) ?? (labelNames(card).includes(SKIP_LABEL) ? undefined : await openIssue(card));
  if (issue) {
    cardIds.set(refKey(issue), card.id);
    issueIds.set(card.id, issue);
  }
  return issue;
}

/** Opens the issue a pickup card stands for and links the two, or says it would. Returns the issue, or nothing when it could not. */
async function openIssue(card: TrelloCard): Promise<IssueRef | undefined> {
  if (isDry()) {
    log(`dry-run: would open an issue for Trello card "${card.name}"`);
    return undefined;
  }
  let issue = await issueFor(card);
  if (!issue) {
    const { slug, reason } = await chooseRepo(card.name, card.desc ?? '');
    const where = several() ? `\nRepository: ${slug} — ${reason}` : '';
    const body = `${card.desc?.trim() ? `${card.desc.trim()}\n\n` : ''}---\nTrello card: ${card.shortUrl}${where}`;
    const r = await gh(['issue', 'create', '--repo', slug, '--title', card.name, '--body', body]);
    const number = Number(/\/issues\/(\d+)\s*$/.exec(r.out.trim())?.[1]);
    if (!r.ok || !number) {
      log(`Trello card "${card.name}": issue not opened in ${slug} — ${(r.err || r.out).split('\n')[0]}`);
      return undefined;
    }
    issue = { repo: slug, number };
  }
  try {
    await linkCard(card, issue);
  } catch (e) {
    // Left unlinked on the card; the next read finds the issue by the card's URL in its body and tries again.
    log(`Trello card "${card.name}": issue ${label(issue)} opened but not linked — ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  log(`Trello card "${card.name}" → issue ${label(issue)}`);
  return issue;
}

interface IssueFacts {
  closed: boolean;
  labels: string[];
}

/** Closed or not, and the labels, of every linked issue — fifty per query, one query series per repository. */
async function issueFacts(issues: IssueRef[]): Promise<Map<string, IssueFacts>> {
  const out = new Map<string, IssueFacts>();
  for (const repo of [...new Set(issues.map((i) => i.repo))]) {
    const numbers = [...new Set(issues.filter((i) => i.repo === repo).map((i) => i.number))];
    const [owner, name] = repo.split('/');
    for (let at = 0; at < numbers.length; at += 50) {
      const chunk = numbers.slice(at, at + 50);
      const parts = chunk.map((n) => `i${n}: issue(number: ${n}) { state labels(first: 20) { nodes { name } } }`).join(' ');
      const data = await graphql(`{ repository(owner: "${owner}", name: "${name}") { ${parts} } }`);
      for (const [key, value] of Object.entries(data.repository ?? {}) as [string, any][]) {
        if (!value) continue;
        out.set(refKey({ repo, number: Number(key.slice(1)) }), { closed: value.state === 'CLOSED', labels: (value.labels?.nodes ?? []).map((l: { name: string }) => l.name) });
      }
    }
  }
  return out;
}

/** A card whose issue Sloth would open: in the pickup list, no issue yet, no `Sloth: skip` on it. */
const wantsIssue = (card: TrelloCard, pickup: string) => card.idList === pickup && !labelNames(card).includes(SKIP_LABEL);

/**
 * Every linked card on the board as a `BoardItem`, in list order and top to bottom within a list — the
 * position is the priority, so the order the cards are dragged into is the order they are taken in. An
 * unlinked card outside the pickup list is a note, not work, and is left out.
 */
export async function fetchTrelloBoard(): Promise<BoardItem[] | undefined> {
  const pickup = cfg().statusField.columns.pickup.id;
  let lists: TrelloList[];
  let cards: TrelloCard[];
  try {
    [lists, cards] = await Promise.all([trello.lists(boardId()), trello.cards(boardId())]);
  } catch (e) {
    log(`board fetch failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return undefined;
  }
  const listName = new Map(lists.map((l) => [l.id, l.name]));
  const linked: { card: TrelloCard; issue: IssueRef }[] = [];
  for (const card of cards) {
    const issue = issueOf(card) ?? (wantsIssue(card, pickup) ? await openIssue(card) : undefined);
    if (issue) linked.push({ card, issue });
  }
  let facts: Map<string, IssueFacts>;
  try {
    facts = await issueFacts(linked.map((l) => l.issue));
  } catch (e) {
    log(`board fetch failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return undefined;
  }
  cardIds = new Map(linked.map((l) => [refKey(l.issue), l.card.id]));
  issueIds = new Map(linked.map((l) => [l.card.id, l.issue]));
  const rank = new Map<string, number>();
  return linked.map(({ card, issue }) => {
    const at = rank.get(card.idList) ?? 0;
    rank.set(card.idList, at + 1);
    const f = facts.get(refKey(issue));
    return {
      ...issue,
      title: card.name,
      status: listName.get(card.idList) ?? '',
      labels: [...new Set([...labelNames(card), ...(f?.labels ?? [])])],
      assignees: (card.members ?? []).map((m) => m.username).filter(Boolean),
      closed: f?.closed ?? false,
      priority: at,
    };
  });
}

/** The card of an issue: what the last read knew, else the board asked again — a card added since, or a Sloth just started. */
async function cardOf(issue: IssueRef): Promise<string | undefined> {
  const known = cardIds.get(refKey(issue));
  if (known) return known;
  const found = (await trello.cards(boardId())).find((c) => {
    const i = issueOf(c);
    return i && refKey(i) === refKey(issue);
  });
  if (found) {
    cardIds.set(refKey(issue), found.id);
    issueIds.set(found.id, issue);
  }
  return found?.id;
}

/** An issue with no card gets one, in the list it is being moved to — an issue opened on GitHub and ordered there is work like any other. */
async function cardFor(issue: IssueRef, listId: string): Promise<string | undefined> {
  const r = await gh(['issue', 'view', String(issue.number), '--repo', issue.repo, '--json', 'title', '--jq', '.title']);
  if (!r.ok) {
    log(`${label(issue)} has no Trello card and its title could not be read: ${r.err.split('\n')[0]}`);
    return undefined;
  }
  const link = issueUrl(issue);
  const card = await trello.createCard(listId, r.out.trim() || label(issue), `GitHub issue: ${link}`, link);
  cardIds.set(refKey(issue), card.id);
  issueIds.set(card.id, issue);
  log(`${label(issue)} -> new Trello card "${card.name}"`);
  return card.id;
}

/** Trello answers a rate limit with 429 and a slow client with 408: neither says the move is impossible. */
const TRANSIENT = [408, 425, 429];

/**
 * Moves an issue's card to a list, at the top of it. A 4xx from Trello is its answer and stands — except
 * the ones above; anything else, a socket reset or a 5xx, is the board being out of reach for a moment and
 * says nothing about whether the move is possible (`MoveOutcome`).
 */
export async function moveTrelloCard(issue: IssueRef, listId: string): Promise<MoveOutcome> {
  if (isDry()) {
    log(`dry-run: would move ${label(issue)} to Trello list ${listId}`);
    return 'moved';
  }
  try {
    const card = (await cardOf(issue)) ?? (await cardFor(issue, listId));
    if (!card) return 'unavailable';
    await trello.moveCard(card, listId);
    return 'moved';
  } catch (e) {
    log(`${label(issue)} move failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return e instanceof trello.TrelloError && e.status < 500 && !TRANSIENT.includes(e.status) ? 'refused' : 'unavailable';
  }
}

export { ensureTrelloLists } from './board-trello-lists';

/** Every open list on the board, left to right, as the columns a session may move a card to. */
export async function trelloColumns(): Promise<ColumnRef[]> {
  return (await trello.lists(boardId())).map(({ id, name }) => ({ id, name }));
}

/** The skip label exists on the board, so a person can put it on a card from Trello. */
export async function ensureTrelloSkipLabel(): Promise<void> {
  if (isDry()) {
    log(`dry-run: would create the "${SKIP_LABEL}" label on the Trello board`);
    return;
  }
  try {
    const have = await trello.labels(boardId());
    if (!have.some((l) => l.name === SKIP_LABEL)) await trello.createLabel(boardId(), SKIP_LABEL, 'red');
  } catch (e) {
    log(`label "${SKIP_LABEL}" not created on the Trello board: ${e instanceof Error ? e.message : String(e)}`);
  }
}
