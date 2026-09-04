import { SKIP_LABEL } from '../board-types';
import { cfg } from '../config';
import type { ColumnRef } from '../config-types';
import * as trello from '../trello';
import type { TrelloCard, TrelloList } from '../trello';
import type { BoardItem } from './board';
import { gh, graphql } from './gh';
import { isDry, log } from './log';

/**
 * A Trello board as Sloth's board: its lists are the columns, its cards the work. The sessions work
 * GitHub issues and PRs — that is where the code, the comments and the reviews live — so every card
 * Sloth works is linked to an issue: a card that carries the issue's URL (an attachment, or the URL in
 * its description) is that issue's card; a card in the pickup list that carries none gets an issue opened
 * for it, titled and described as the card is, and the URL attached to the card so the link holds. The
 * issue's own facts a trigger needs — closed, `Fable: approved`, `Sloth: skip` — are read off GitHub in
 * one query for every linked card, so a label on either side counts.
 */

/** The card of each linked issue and the issue of each linked card, from the last read — what a move and the comment mirror need. */
let cardIds = new Map<number, string>();
let issueIds = new Map<string, number>();
export const cardIdOf = (issue: number): string | undefined => cardIds.get(issue);
export const issueOfCard = (cardId: string): number | undefined => issueIds.get(cardId);

const boardId = () => cfg().project.id;

const issueUrlRe = (repo: string) => new RegExp(`https://github\\.com/${repo.replace(/[.]/g, '\\.')}/issues/(\\d+)\\b`);

/** The issue a card is linked to: the first issue URL of the watched repository among its attachments, then its description. */
export function issueOf(card: TrelloCard, repo = cfg().repo): number | undefined {
  const re = issueUrlRe(repo);
  for (const a of card.attachments ?? []) {
    const m = re.exec(a.url);
    if (m) return Number(m[1]);
  }
  const m = re.exec(card.desc ?? '');
  return m ? Number(m[1]) : undefined;
}

const labelNames = (card: TrelloCard) => card.labels.map((l) => l.name).filter(Boolean);

/**
 * The issue already opened for this card, when the attaching failed last time: every issue Sloth opens
 * names the card's URL in its body, so the repository is asked before a second one is opened.
 */
async function issueFor(card: TrelloCard): Promise<number | undefined> {
  const r = await gh(['issue', 'list', '--repo', cfg().repo, '--state', 'all', '--search', `"${card.shortUrl}" in:body`, '--json', 'number', '--jq', '.[0].number']);
  const number = Number(r.out.trim());
  return r.ok && number ? number : undefined;
}

/** Puts the issue's URL on the card — an attachment, or the description when Trello refuses that — with a comment saying where to talk. */
async function linkCard(card: TrelloCard, number: number, link: string): Promise<void> {
  try {
    await trello.attach(card.id, link, `GitHub issue #${number}`);
  } catch (e) {
    log(`Trello card "${card.name}": issue #${number} not attached, writing it into the description — ${e instanceof Error ? e.message : String(e)}`);
    await trello.describe(card.id, `${card.desc?.trim() ? `${card.desc.trim()}\n\n` : ''}GitHub issue: ${link}`);
  }
  await trello.commentCard(card.id, `Sloth is on this card. Comment here to talk to it — mention ${cfg().mention} to ask or to give an order — and it answers here.`);
}

/** A card the mirror met before the board read did — someone commented on it: linked to its issue, opened now when it has none. */
export async function linkCardToIssue(cardId: string): Promise<number | undefined> {
  const card = await trello.card(cardId);
  const issue = issueOf(card) ?? (labelNames(card).includes(SKIP_LABEL) ? undefined : await openIssue(card));
  if (issue) {
    cardIds.set(issue, card.id);
    issueIds.set(card.id, issue);
  }
  return issue;
}

/** Opens the issue a pickup card stands for and links the two, or says it would. Returns the number, or nothing when it could not. */
async function openIssue(card: TrelloCard): Promise<number | undefined> {
  const c = cfg();
  if (isDry()) {
    log(`dry-run: would open an issue for Trello card "${card.name}"`);
    return undefined;
  }
  let number = await issueFor(card);
  if (!number) {
    const body = `${card.desc?.trim() ? `${card.desc.trim()}\n\n` : ''}---\nTrello card: ${card.shortUrl}`;
    const r = await gh(['issue', 'create', '--repo', c.repo, '--title', card.name, '--body', body]);
    number = Number(/\/issues\/(\d+)\s*$/.exec(r.out.trim())?.[1]);
    if (!r.ok || !number) {
      log(`Trello card "${card.name}": issue not opened — ${(r.err || r.out).split('\n')[0]}`);
      return undefined;
    }
  }
  const link = `https://github.com/${c.repo}/issues/${number}`;
  try {
    await linkCard(card, number, link);
  } catch (e) {
    // Left unlinked on the card; the next read finds the issue by the card's URL in its body and tries again.
    log(`Trello card "${card.name}": issue #${number} opened but not linked — ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  log(`Trello card "${card.name}" → issue #${number}`);
  return number;
}

interface IssueFacts {
  closed: boolean;
  labels: string[];
}

/** Closed or not, and the labels, of every linked issue — fifty per query. */
async function issueFacts(numbers: number[]): Promise<Map<number, IssueFacts>> {
  const out = new Map<number, IssueFacts>();
  const [owner, name] = cfg().repo.split('/');
  for (let at = 0; at < numbers.length; at += 50) {
    const chunk = numbers.slice(at, at + 50);
    const parts = chunk.map((n) => `i${n}: issue(number: ${n}) { state labels(first: 20) { nodes { name } } }`).join(' ');
    const data = await graphql(`{ repository(owner: "${owner}", name: "${name}") { ${parts} } }`);
    for (const [key, value] of Object.entries(data.repository ?? {}) as [string, any][]) {
      if (!value) continue;
      out.set(Number(key.slice(1)), { closed: value.state === 'CLOSED', labels: (value.labels?.nodes ?? []).map((l: { name: string }) => l.name) });
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
  const linked: { card: TrelloCard; issue: number }[] = [];
  for (const card of cards) {
    const issue = issueOf(card) ?? (wantsIssue(card, pickup) ? await openIssue(card) : undefined);
    if (issue) linked.push({ card, issue });
  }
  let facts: Map<number, IssueFacts>;
  try {
    facts = await issueFacts(linked.map((l) => l.issue));
  } catch (e) {
    log(`board fetch failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return undefined;
  }
  cardIds = new Map(linked.map((l) => [l.issue, l.card.id]));
  issueIds = new Map(linked.map((l) => [l.card.id, l.issue]));
  const rank = new Map<string, number>();
  return linked.map(({ card, issue }) => {
    const at = rank.get(card.idList) ?? 0;
    rank.set(card.idList, at + 1);
    const f = facts.get(issue);
    return {
      number: issue,
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
async function cardOf(issue: number): Promise<string | undefined> {
  const known = cardIds.get(issue);
  if (known) return known;
  const found = (await trello.cards(boardId())).find((c) => issueOf(c) === issue);
  if (found) {
    cardIds.set(issue, found.id);
    issueIds.set(found.id, issue);
  }
  return found?.id;
}

/** An issue with no card gets one, in the list it is being moved to — an issue opened on GitHub and ordered there is work like any other. */
async function cardFor(issue: number, listId: string): Promise<string | undefined> {
  const c = cfg();
  const r = await gh(['issue', 'view', String(issue), '--repo', c.repo, '--json', 'title', '--jq', '.title']);
  if (!r.ok) {
    log(`#${issue} has no Trello card and its title could not be read: ${r.err.split('\n')[0]}`);
    return undefined;
  }
  const link = `https://github.com/${c.repo}/issues/${issue}`;
  const card = await trello.createCard(listId, r.out.trim() || `#${issue}`, `GitHub issue: ${link}`, link);
  cardIds.set(issue, card.id);
  issueIds.set(card.id, issue);
  log(`#${issue} -> new Trello card "${card.name}"`);
  return card.id;
}

/** Moves an issue's card to a list, at the top of it. */
export async function moveTrelloCard(issue: number, listId: string): Promise<boolean> {
  if (isDry()) {
    log(`dry-run: would move #${issue} to Trello list ${listId}`);
    return true;
  }
  try {
    const card = (await cardOf(issue)) ?? (await cardFor(issue, listId));
    if (!card) return false;
    await trello.moveCard(card, listId);
    return true;
  } catch (e) {
    log(`#${issue} move failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return false;
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
