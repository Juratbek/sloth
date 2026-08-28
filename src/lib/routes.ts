/** The pages the UI has — one at a time, the whole window. */
export type Page = 'monitor' | 'board' | 'settings' | 'wizard';

export interface Route {
  page: Page;
  /** Only ever set on the monitor: the session the sidebar highlights and the main pane shows. */
  sessionId?: string;
}

/** Session ids are folder names Sloth makes itself (`issue-12-1a2b`); anything with a dot or a slash in it is not one. */
const SESSION_ID = /^[\w-]+$/;

const PATHS: Record<Exclude<Page, 'monitor'>, string> = { board: '/board', settings: '/settings', wizard: '/setup' };

/**
 * The path decides which page shows, so a refresh lands where the user was and a page can be linked to.
 * Anything unrecognised — a typo, an old link, a session id that could not be one — is the monitor.
 */
export function parseRoute(path: string): Route {
  // `location.pathname` carries neither a query nor a hash, but a hand-written path might.
  const clean = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  for (const [page, at] of Object.entries(PATHS)) if (clean === at) return { page: page as Page };
  const id = /^\/sessions\/([^/]+)$/.exec(clean)?.[1];
  if (id && SESSION_ID.test(id)) return { page: 'monitor', sessionId: id };
  return { page: 'monitor' };
}

/** The path a page lives at — the other half of `parseRoute`, and the only place a URL is written. */
export function pathFor(page: Page, sessionId?: string): string {
  if (page !== 'monitor') return PATHS[page];
  return sessionId && SESSION_ID.test(sessionId) ? `/sessions/${sessionId}` : '/';
}
