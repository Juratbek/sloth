import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../server/types';
import { matches } from '../src/components/Sidebar';

const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({
    id: 'abc',
    prompt: '',
    kind: 'issue',
    status: 'done',
    live: false,
    agents: [],
    usage: {},
    ...over,
  }) as SessionSummary;

describe('sidebar search', () => {
  const s = session({
    target: 42,
    title: 'Add a search input to the sessions list',
  });

  it('shows everything for an empty or blank query', () => {
    expect(matches(s, '')).toBe(true);
    expect(matches(s, '   ')).toBe(true);
  });

  it('matches the title, case-insensitively', () => {
    expect(matches(s, 'SEARCH input')).toBe(true);
    expect(matches(s, 'board')).toBe(false);
  });

  it('matches the issue number with or without the hash', () => {
    expect(matches(s, '#42')).toBe(true);
    expect(matches(s, '42')).toBe(true);
    expect(matches(s, '#4')).toBe(true);
    expect(matches(s, '#43')).toBe(false);
  });

  it('matches the row label, e.g. the kind', () => {
    expect(matches(s, 'issue')).toBe(true);
    expect(
      matches(
        session({
          kind: 'sloth:review',
          watcher: { kind: 'approved' } as SessionSummary['watcher'],
        }),
        'review',
      ),
    ).toBe(true);
  });

  it('copes with a session that has no title or target', () => {
    expect(matches(session({}), 'anything')).toBe(false);
    expect(matches(session({}), '')).toBe(true);
  });
});
