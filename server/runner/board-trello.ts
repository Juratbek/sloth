import { SKIP_LABEL } from '../board-types';
import { cfg } from '../config';
import { DEFAULT_COLUMN_NAMES, OPTIONAL_COLUMNS, OPT_IN_COLUMNS } from '../config-types';
import type { ColumnRef, ColumnRole, ConfigColumns } from '../config-types';
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

const ROLES: ColumnRole[] = ['pickup', 'inProgress', 'needsHelp', 'codeReview', 'approved', 'qa', 'done'];

/** The card of each linked issue, from the last read — what a move needs and the read already knows. */
let cardIds = new Map<number, string>();

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

/** Opens the issue a pickup card stands for and links the two, or says it would. Returns the number, or nothing when it could not. */
async function openIssue(card: TrelloCard): Promise<number | undefined> {
  const c = cfg();
  if (isDry()) {
    log(`dry-run: would open an issue for Trello card "${card.name}"`);
    return undefined;
  }
  const body = `${card.desc?.trim() ? `${card.desc.trim()}\n\n` : ''}---\nTrello card: ${card.shortUrl}`;
  const r = await gh(['issue', 'create', '--repo', c.repo, '--title', card.name, '--body', body]);
  const number = Number(/\/issues\/(\d+)\s*$/.exec(r.out.trim())?.[1]);
  if (!r.ok || !number) {
    log(`Trello card "${card.name}": issue not opened — ${(r.err || r.out).split('\n')[0]}`);
    return undefined;
  }
  const link = `https://github.com/${c.repo}/issues/${number}`;
  try {
    await trello.attach(card.id, link, `GitHub issue #${number}`);
    await trello.commentCard(card.id, `Sloth opened ${link} for this card. Talk to Sloth in that issue's comments; the card follows the work.`);
  } catch (e) {
    // The issue is open with the card's URL in its body, so the next read links the two again by that: no second issue.
    log(`Trello card "${card.name}": issue #${number} opened but not attached — ${e instanceof Error ? e.message : String(e)}`);
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
      assignees: [],
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
  if (found) cardIds.set(issue, found.id);
  return found?.id;
}

/** Moves an issue's card to a list, at the top of it. */
export async function moveTrelloCard(issue: number, listId: string): Promise<boolean> {
  if (isDry()) {
    log(`dry-run: would move #${issue} to Trello list ${listId}`);
    return true;
  }
  try {
    const card = await cardOf(issue);
    if (!card) {
      log(`#${issue} move failed: no Trello card is linked to it`);
      return false;
    }
    await trello.moveCard(card, listId);
    return true;
  } catch (e) {
    log(`#${issue} move failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return false;
  }
}

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

const asked = (role: ColumnRole, wanted: Record<ColumnRole, ColumnRef>) => !OPT_IN_COLUMNS.includes(role) || !!(wanted[role].id || wanted[role].name);
const byName = (lists: TrelloList[], name: string) => lists.find((l) => l.name.toLowerCase() === name.toLowerCase());

/**
 * Resolves the column roles to real lists, creating the missing ones — the flow lists right after the
 * pickup list, Done at the far right — the way `ensureColumns` does for a Status field.
 */
export async function ensureTrelloLists(board: string, wanted: Record<ColumnRole, ColumnRef>): Promise<ConfigColumns> {
  let lists = await trello.lists(board);
  const resolve = (role: ColumnRole): TrelloList | undefined =>
    asked(role, wanted) ? (lists.find((l) => l.id === wanted[role].id) ?? byName(lists, wanted[role].name || DEFAULT_COLUMN_NAMES[role])) : undefined;
  const pickup = resolve('pickup');
  if (!pickup) throw new Error(`the watched list "${wanted.pickup.name}" is not on this board`);
  const nameOf = (role: ColumnRole) => wanted[role].name || DEFAULT_COLUMN_NAMES[role];
  const middle = (['inProgress', 'needsHelp', 'codeReview', 'approved', 'qa'] as ColumnRole[]).filter((role) => asked(role, wanted) && !resolve(role));
  const last = (['done'] as ColumnRole[]).filter((role) => asked(role, wanted) && !resolve(role));
  if (middle.length || last.length) {
    log(`creating Trello lists: ${[...middle, ...last].map(nameOf).join(', ')}`);
    const after = lists.find((l) => l.pos > pickup.pos);
    const gap = after ? (after.pos - pickup.pos) / (middle.length + 1) : 1024;
    for (const [i, role] of middle.entries()) await trello.createList(board, nameOf(role), pickup.pos + gap * (i + 1));
    for (const role of last) await trello.createList(board, nameOf(role), 'bottom');
    lists = await trello.lists(board);
  }
  const out = {} as ConfigColumns;
  for (const role of ROLES) {
    const found = resolve(role);
    if (!found && OPTIONAL_COLUMNS.includes(role) && !asked(role, wanted)) {
      out[role] = { id: '', name: '' };
      continue;
    }
    if (!found) throw new Error(`could not resolve the ${role} list`);
    out[role] = { id: found.id, name: found.name };
  }
  return out;
}
