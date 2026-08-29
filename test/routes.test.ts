import { describe, expect, it } from 'vitest';
import type { Page } from '../src/lib/routes';
import { parseRoute, pathFor } from '../src/lib/routes';

const PAGES: Page[] = ['monitor', 'board', 'settings', 'wizard'];

describe('parseRoute', () => {
  it('reads every page back out of the path it is written to', () => {
    for (const page of PAGES) expect(parseRoute(pathFor(page))).toEqual({ page });
  });
  it('reads a session out of /sessions/:id', () => {
    expect(parseRoute('/sessions/issue-12-1a2b')).toEqual({ page: 'monitor', sessionId: 'issue-12-1a2b' });
    expect(parseRoute(pathFor('monitor', 'review-7_x'))).toEqual({ page: 'monitor', sessionId: 'review-7_x' });
  });
  it('reads a settings section out of /settings/:section', () => {
    expect(parseRoute('/settings/about')).toEqual({ page: 'settings', section: 'about' });
    expect(parseRoute(pathFor('settings', 'models'))).toEqual({ page: 'settings', section: 'models' });
    expect(parseRoute('/settings')).toEqual({ page: 'settings' });
  });
  it('ignores a trailing slash, a query and a hash', () => {
    expect(parseRoute('/board/')).toEqual({ page: 'board' });
    expect(parseRoute('/board?code=abc')).toEqual({ page: 'board' });
    expect(parseRoute('/sessions/issue-1/#top')).toEqual({ page: 'monitor', sessionId: 'issue-1' });
  });
  it('falls back to the monitor on anything it does not know', () => {
    expect(parseRoute('/')).toEqual({ page: 'monitor' });
    expect(parseRoute('')).toEqual({ page: 'monitor' });
    expect(parseRoute('/nope')).toEqual({ page: 'monitor' });
    expect(parseRoute('/board/extra')).toEqual({ page: 'monitor' });
  });
  it('takes only a session id that could be one', () => {
    expect(parseRoute('/sessions/')).toEqual({ page: 'monitor' });
    expect(parseRoute('/sessions/..')).toEqual({ page: 'monitor' });
    expect(parseRoute('/sessions/a%20b')).toEqual({ page: 'monitor' });
    expect(parseRoute('/sessions/one/two')).toEqual({ page: 'monitor' });
  });
  it('takes only a section name that could be one', () => {
    expect(parseRoute('/settings/')).toEqual({ page: 'settings' });
    expect(parseRoute('/settings/..')).toEqual({ page: 'monitor' });
    expect(parseRoute('/settings/a%20b')).toEqual({ page: 'monitor' });
    expect(parseRoute('/settings/about/extra')).toEqual({ page: 'monitor' });
  });
});

describe('pathFor', () => {
  it('puts each page at its own path', () => {
    expect(pathFor('monitor')).toBe('/');
    expect(pathFor('board')).toBe('/board');
    expect(pathFor('settings')).toBe('/settings');
    expect(pathFor('wizard')).toBe('/setup');
  });
  it('puts a settings section under /settings', () => {
    expect(pathFor('settings', 'about')).toBe('/settings/about');
    expect(pathFor('settings', '../etc')).toBe('/settings');
  });
  it('ignores a session id on a page that has no sessions, and one that is not an id', () => {
    expect(pathFor('board', 'issue-1')).toBe('/board');
    expect(pathFor('wizard', 'about')).toBe('/setup');
    expect(pathFor('monitor', '../etc')).toBe('/');
    expect(pathFor('monitor', '')).toBe('/');
  });
});
