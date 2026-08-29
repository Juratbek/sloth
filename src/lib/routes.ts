/** The pages the UI has — one at a time, the whole window. */
export type Page = 'monitor' | 'board' | 'settings' | 'wizard';

export interface Route {
  page: Page;
  /** Only ever set on the monitor: the session the sidebar highlights and the main pane shows. */
  sessionId?: string;
  /** Only ever set on settings: the section open in the side nav (`about`, `models`…). Absent means the first one. */
  section?: string;
}

/** Session ids are folder names Sloth makes itself (`issue-12-1a2b`); anything with a dot or a slash in it is not one. */
const SESSION_ID = /^[\w-]+$/;
/** Section keys are plain words Settings picks itself; unknown ones fall back to the first section there. */
const SECTION = /^[a-z]+$/;

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
  const section = /^\/settings\/([^/]+)$/.exec(clean)?.[1];
  if (section && SECTION.test(section)) return { page: 'settings', section };
  return { page: 'monitor' };
}

/**
 * The path a page lives at — the other half of `parseRoute`, and the only place a URL is written.
 * `at` is the session on the monitor and the section in settings; the other pages have no inside.
 */
export function pathFor(page: Page, at?: string): string {
  if (page === 'monitor') return at && SESSION_ID.test(at) ? `/sessions/${at}` : '/';
  if (page === 'settings') return at && SECTION.test(at) ? `/settings/${at}` : PATHS.settings;
  return PATHS[page];
}
