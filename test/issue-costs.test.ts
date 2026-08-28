import { describe, expect, it } from 'vitest';
import { rollup } from '../server/issue-costs';
import type { SessionSummary, WatcherSession } from '../server/types';

const usage = (input: number, output = 0, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, thinking: 0 });

const dir = (kind: WatcherSession['kind'], target: number, issue?: number) =>
  ({ name: `${kind}-${target}`, kind, target, issue, alive: false, retries: 0, blocked: false, runLogTail: '', inbox: [] }) as WatcherSession;

/** A finished run as `listSessions` hands it over — only what the rollup reads is filled in. */
const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({
    id: 'x',
    prompt: '',
    kind: 'other',
    status: 'done',
    live: false,
    agents: [],
    agentsUsage: usage(0),
    usage: usage(0),
    byModel: [],
    toolCounts: {},
    turns: 0,
    contextTokens: 0,
    lastText: '',
    cost: 0,
    ...over,
  }) as SessionSummary;

const titleOf = (n: number) => `Issue ${n}`;

describe('rollup', () => {
  it('groups implement runs by their issue and reviews by the issue in their directory', () => {
    const issues = rollup(
      [
        session({ kind: 'sloth:implement', target: 42, watcher: dir('issue', 42), cost: 1.5, usage: usage(10, 2, 100), status: 'running', lastAt: '2026-08-28T10:00:00Z' }),
        session({ kind: 'sloth:review', target: 91, watcher: dir('review', 91, 42), cost: 0.25, usage: usage(5), lastAt: '2026-08-28T09:00:00Z' }),
        session({ kind: 'sloth:review', target: 91, watcher: dir('approved', 91, 42), cost: 0.25, usage: usage(5) }),
        session({ kind: 'sloth:implement', target: 7, watcher: dir('issue', 7), cost: 3, usage: usage(1), lastAt: '2026-08-27T10:00:00Z' }),
      ],
      titleOf,
    );
    expect(issues.map((i) => [i.issue, i.sessions, i.cost])).toEqual([
      [7, 1, 3],
      [42, 3, 2],
    ]);
    const first = issues.find((i) => i.issue === 42)!;
    expect(first).toMatchObject({ title: 'Issue 42', status: 'running', lastAt: '2026-08-28T10:00:00Z' });
    expect(first.tokens).toEqual({ input: 20, output: 2, cacheRead: 100 });
  });

  it("counts a subagent's tokens and takes the newest run's status", () => {
    const [row] = rollup(
      [
        session({ kind: 'sloth:implement', target: 1, watcher: dir('issue', 1), status: 'parked', usage: usage(3), agentsUsage: usage(4, 5, 6), lastAt: '2026-08-28T12:00:00Z' }),
        session({ kind: 'sloth:implement', target: 1, watcher: dir('issue', 1), status: 'done', usage: usage(1), lastAt: '2026-08-20T12:00:00Z' }),
      ],
      titleOf,
    );
    expect(row.status).toBe('parked');
    expect(row.tokens).toEqual({ input: 8, output: 5, cacheRead: 6 });
    expect(row.lastAt).toBe('2026-08-28T12:00:00Z');
  });

  it('leaves an issue unpriced when one of its runs is, and skips runs it cannot place', () => {
    const issues = rollup(
      [
        session({ kind: 'sloth:implement', target: 1, watcher: dir('issue', 1), cost: 2 }),
        session({ kind: 'sloth:implement', target: 1, watcher: dir('issue', 1), cost: null }),
        session({ kind: 'other', target: 99 }),
        session({ kind: 'sloth:review', target: 5 }),
      ],
      titleOf,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ issue: 1, sessions: 2, cost: null });
  });
});
