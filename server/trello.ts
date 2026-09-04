import { envValue } from './config';

/**
 * The Trello REST API, as much of it as a board provider needs: lists, cards, labels, attachments and
 * comments. Authenticated with an API key and a token from the environment Sloth runs in
 * (`SLOTH_TRELLO_KEY` / `SLOTH_TRELLO_TOKEN`, `.env` works too) — a board is only offered in the wizard,
 * and only watched, while both are there. Every call is one `fetch`, retried once the way `gh` is.
 */

export const TRELLO_KEY = 'SLOTH_TRELLO_KEY';
export const TRELLO_TOKEN = 'SLOTH_TRELLO_TOKEN';
const API = 'https://api.trello.com/1';

export const trelloReady = (): boolean => !!envValue(TRELLO_KEY)?.trim() && !!envValue(TRELLO_TOKEN)?.trim();

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
  const u = new URL(`${API}${path}`);
  u.searchParams.set('key', envValue(TRELLO_KEY) ?? '');
  u.searchParams.set('token', envValue(TRELLO_TOKEN) ?? '');
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

async function once<T>(method: string, path: string, params: Params): Promise<T> {
  const res = await fetch(url(path, params), { method, headers: { accept: 'application/json' } });
  if (!res.ok) throw new TrelloError(`Trello ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
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
    filter: 'open',
  });
  return all.filter((c) => !c.closed).sort((a, b) => a.pos - b.pos);
}

export const moveCard = (cardId: string, listId: string) => trello<TrelloCard>('PUT', `/cards/${cardId}`, { idList: listId, pos: 'top' });

export const attach = (cardId: string, link: string, name: string) => trello('POST', `/cards/${cardId}/attachments`, { url: link, name });

export const commentCard = (cardId: string, text: string) => trello('POST', `/cards/${cardId}/actions/comments`, { text });

export const labels = (boardId: string) => trello<TrelloLabel[]>('GET', `/boards/${boardId}/labels`, { fields: 'id,name,color' });

export const createLabel = (boardId: string, name: string, color: string) => trello<TrelloLabel>('POST', '/labels', { name, color, idBoard: boardId });
