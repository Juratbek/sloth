import { trelloCredentials } from './trello-credentials';

/**
 * The Trello REST API, as much of it as a board provider needs: lists, cards, labels, attachments,
 * comments and webhooks. Authenticated with the key and token in force (`trello-credentials.ts` — set
 * in the UI, or in the environment) — a board is only offered in the wizard, and only watched, while
 * both are there. Every call is one `fetch`, retried once the way `gh` is.
 */

export { TRELLO_KEY, TRELLO_SECRET, TRELLO_TOKEN, trelloReady } from './trello-credentials';
const API = 'https://api.trello.com/1';

export interface TrelloList {
  id: string;
  name: string;
  pos: number;
  closed: boolean;
}
export interface TrelloLabel {
  id: string;
  name: string;
  color: string | null;
}
export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  pos: number;
  closed: boolean;
  shortUrl: string;
  labels: TrelloLabel[];
  attachments?: { url: string; name: string }[];
  members?: TrelloMember[];
}
/** One comment on a card — a `commentCard` action of the board. */
export interface TrelloComment {
  id: string;
  date: string;
  cardId: string;
  memberId: string;
  username: string;
  text: string;
}
export interface TrelloWebhook {
  id: string;
  callbackURL: string;
  idModel: string;
  active: boolean;
}
export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  closed: boolean;
}
export interface TrelloMember {
  id: string;
  username: string;
}

export class TrelloError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined>;

function url(path: string, params: Params): string {
  const { key, token } = trelloCredentials();
  const u = new URL(`${API}${path}`);
  u.searchParams.set('key', key);
  u.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

/**
 * The key and the token out of anything on its way to a log, the state directory or the Settings page.
 * Every call carries them in the query string, which never reaches a message — but `/tokens/<token>/webhooks`
 * carries the token in the path, and the path is what a failed call is named by. The token opens every
 * board its member is on, for reading and for writing, so it is worth this on every error text.
 */
function redact(text: string): string {
  const { key, token } = trelloCredentials();
  let out = text;
  for (const secret of [token, key]) if (secret && secret.length > 3) out = out.split(secret).join('\u2026');
  return out;
}

async function once<T>(method: string, path: string, params: Params): Promise<T> {
  const res = await fetch(url(path, params), { method, headers: { accept: 'application/json' } });
  if (!res.ok) throw new TrelloError(redact(`Trello ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`), res.status);
  return (await res.json()) as T;
}

/** One Trello call; a transport error or a 5xx is retried once, a 4xx is what it is. */
export async function trello<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, params: Params = {}): Promise<T> {
  try {
    return await once<T>(method, path, params);
  } catch (e) {
    if (e instanceof TrelloError && e.status < 500) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return once<T>(method, path, params);
  }
}

export const me = () => trello<TrelloMember>('GET', '/members/me', { fields: 'id,username' });

/** Every open board the token's member is on. */
export async function boards(): Promise<TrelloBoard[]> {
  const all = await trello<TrelloBoard[]>('GET', '/members/me/boards', { fields: 'id,name,url,closed', filter: 'open' });
  return all.filter((b) => !b.closed);
}

/** The board's open lists, left to right. */
export async function lists(boardId: string): Promise<TrelloList[]> {
  const all = await trello<TrelloList[]>('GET', `/boards/${boardId}/lists`, { fields: 'id,name,pos,closed', filter: 'open' });
  return all.filter((l) => !l.closed).sort((a, b) => a.pos - b.pos);
}

/** A new list at the far right of the board — or right after `after`, when given. */
export const createList = (boardId: string, name: string, pos: number | 'bottom' = 'bottom') =>
  trello<TrelloList>('POST', '/lists', { name, idBoard: boardId, pos });

/** Every open card on the board with its labels and attachment urls, top to bottom within each list. */
export async function cards(boardId: string): Promise<TrelloCard[]> {
  const all = await trello<TrelloCard[]>('GET', `/boards/${boardId}/cards`, {
    fields: 'id,name,desc,idList,pos,closed,shortUrl,labels',
    attachments: true,
    attachment_fields: 'url,name',
    members: true,
    member_fields: 'id,username',
    filter: 'open',
  });
  return all.filter((c) => !c.closed).sort((a, b) => a.pos - b.pos);
}

/** One card, with what `cards` reads of every card. */
export const card = (cardId: string) =>
  trello<TrelloCard>('GET', `/cards/${cardId}`, { fields: 'id,name,desc,idList,pos,closed,shortUrl,labels', attachments: true, attachment_fields: 'url,name', members: true, member_fields: 'id,username' });

/** A new card at the top of a list, with `link` attached to it. */
export const createCard = (listId: string, name: string, desc: string, link: string) => trello<TrelloCard>('POST', '/cards', { idList: listId, name, desc, urlSource: link, pos: 'top' });

interface RawAction {
  id: string;
  date: string;
  data?: { card?: { id?: string }; text?: string };
  memberCreator?: { id?: string; username?: string };
}

/** Every comment written on the board since `since` (ISO), oldest first — one call for the whole board. */
export async function boardComments(boardId: string, since: string): Promise<TrelloComment[]> {
  const raw = await trello<RawAction[]>('GET', `/boards/${boardId}/actions`, { filter: 'commentCard', since, limit: 1000, fields: 'id,date,data', memberCreator_fields: 'id,username' });
  return raw
    .filter((a) => a.data?.card?.id && typeof a.data.text === 'string')
    .map((a) => ({ id: a.id, date: a.date, cardId: a.data!.card!.id!, memberId: a.memberCreator?.id ?? '', username: a.memberCreator?.username ?? '', text: a.data!.text! }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The webhooks this token owns. */
export const webhooks = () => trello<TrelloWebhook[]>('GET', `/tokens/${trelloCredentials().token}/webhooks`);
export const createWebhook = (boardId: string, callbackURL: string) => trello<TrelloWebhook>('POST', '/webhooks', { idModel: boardId, callbackURL, description: 'Sloth' });
export const updateWebhook = (id: string, boardId: string, callbackURL: string) => trello<TrelloWebhook>('PUT', `/webhooks/${id}`, { idModel: boardId, callbackURL, active: true });

export const moveCard = (cardId: string, listId: string) => trello<TrelloCard>('PUT', `/cards/${cardId}`, { idList: listId, pos: 'top' });

export const describe = (cardId: string, desc: string) => trello<TrelloCard>('PUT', `/cards/${cardId}`, { desc });

export const attach = (cardId: string, link: string, name: string) => trello('POST', `/cards/${cardId}/attachments`, { url: link, name });

export const commentCard = (cardId: string, text: string) => trello('POST', `/cards/${cardId}/actions/comments`, { text });

export const labels = (boardId: string) => trello<TrelloLabel[]>('GET', `/boards/${boardId}/labels`, { fields: 'id,name,color' });

export const createLabel = (boardId: string, name: string, color: string) => trello<TrelloLabel>('POST', '/labels', { name, color, idBoard: boardId });
