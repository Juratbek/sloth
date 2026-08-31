import { beforeEach, describe, expect, it } from 'vitest';
import { buildBoardView } from '../server/board-view';
import { clearSnapshot, setSnapshot, snapshot } from '../server/runner/board-snapshot';
import { reloadConfig } from '../server/config';
import type { ConfigColumns } from '../server/config-types';
import type { BlockedCard, IssueCost, SessionSummary, WatcherSession, WatcherState } from '../server/types';
import { COLUMNS, card, configure } from './harness';

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 });

const dir = (kind: WatcherSession['kind'], target: number, over: Partial<WatcherSession> = {}): WatcherSession =>
  ({ name: `${kind}-${target}`, kind, target, alive: false, retries: 0, blocked: false, runLogTail: '', inbox: [], ...over }) as WatcherSession;

/** A run as `listSessions` hands it over — only what the join reads is filled in. */
const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({
    id: 'sess',
    prompt: '',
    kind: 'sloth:implement',
    status: 'done',
    live: false,
    agents: [],
    agentsUsage: usage(),
    usage: usage(),
    byModel: [],
    toolCounts: {},
    turns: 0,
    contextTokens: 0,
    lastText: '',
    cost: 0,
    ...over,
  }) as SessionSummary;

const state = (s: WatcherState): { state: WatcherState } => ({ state: s });

const cost = (issue: number, over: Partial<IssueCost> = {}): IssueCost =>
  ({ issue, sessions: 1, cost: 1, tokens: { input: 0, output: 0, cacheRead: 0 }, ...over }) as IssueCost;

const NOW = Date.parse('2026-08-28T12:00:00Z');
const view = (
  items: Parameters<typeof buildBoardView>[0]['items'],
  sessions: SessionSummary[] = [],
  issues: IssueCost[] = [],
  columns: ConfigColumns = COLUMNS,
  blocked: BlockedCard[] = [],
) => buildBoardView({ at: NOW, items }, columns, sessions, issues, blocked, NOW);

const names = (v: ReturnType<typeof buildBoardView>) => v.columns.map((c) => c.role);
const issuesIn = (v: ReturnType<typeof buildBoardView>, role: string) => v.columns.find((c) => c.role === role)?.cards.map((c) => c.issue);

describe('buildBoardView', () => {
  it('puts Sloth\'s columns in pipeline order whatever order the board is in', () => {
    const ran = (n: number) => session({ id: `s${n}`, target: n, watcher: dir('issue', n) });
    const v = view([card(1, 'Done', { closed: true }), card(2, 'Approved'), card(3, 'Todo'), card(4, 'In Progress')], [ran(1), ran(2), ran(4)]);
    expect(names(v)).toEqual(['pickup', 'inProgress', 'needsHelp', 'codeReview', 'approved', 'done']);
    expect(issuesIn(v, 'pickup')).toEqual([3]);
    expect(issuesIn(v, 'inProgress')).toEqual([4]);
    expect(issuesIn(v, 'approved')).toEqual([2]);
    expect(issuesIn(v, 'done')).toEqual([1]);
    expect(v.asOf).toBe(new Date(NOW).toISOString());
  });

  it('leaves out a column the config does not have and counts every other status as elsewhere', () => {
    const columns: ConfigColumns = { ...COLUMNS, needsHelp: { id: '', name: '' }, approved: { id: '', name: '' }, done: { id: '', name: '' } };
    const v = view([card(1, 'Todo'), card(2, 'Backlog'), card(3, 'Done'), card(4, 'Planning'), card(5, '')], [], [], columns);
    expect(names(v)).toEqual(['pickup', 'inProgress', 'codeReview']);
    // Done is no longer Sloth's, so its card is elsewhere along with Backlog, Planning and the card with no status.
    expect(v.elsewhere).toBe(4);
  });

  it('shows only the last 7 days in Done', () => {
    const old = session({ id: 'old', target: 1, watcher: dir('issue', 1), lastAt: '2026-08-01T12:00:00Z' });
    const fresh = session({ id: 'fresh', target: 2, watcher: dir('issue', 2), lastAt: '2026-08-27T12:00:00Z' });
    const undated = session({ id: 'undated', target: 3, watcher: dir('issue', 3) });
    const v = view([card(1, 'Done'), card(2, 'Done'), card(3, 'Done')], [old, fresh, undated]);
    expect(issuesIn(v, 'done')).toEqual([2, 3]);
    // Dropped from Done, not counted as being somewhere else or as someone else's.
    expect(v.elsewhere).toBe(0);
    expect(v.others).toBe(0);
  });

  it('shows only Sloth\'s cards: the ones it ran on and the unclaimed ones waiting in pickup; the rest are counted', () => {
    const ran = session({ id: 'ran', target: 2, watcher: dir('issue', 2) });
    // A human's final review still shows: Sloth reviewed it.
    const final = session({ id: 'final', kind: 'sloth:review', target: 90, watcher: dir('approved', 90, { issue: 5 }) });
    const v = view(
      [card(1, 'Todo'), card(2, 'In Progress'), card(3, 'In Progress'), card(4, 'Code Review'), card(5, 'Approved', { assignees: ['bob'] }), card(6, 'Todo', { labels: ['Sloth: skip'] }), card(7, 'Done')],
      [ran, final],
    );
    expect(issuesIn(v, 'pickup')).toEqual([1]);
    expect(issuesIn(v, 'inProgress')).toEqual([2]);
    expect(issuesIn(v, 'codeReview')).toEqual([]);
    expect(issuesIn(v, 'approved')).toEqual([5]);
    expect(issuesIn(v, 'done')).toEqual([]);
    // #3, #4, #7 moved by hand with no run; #6 labelled Sloth: skip in pickup, so not Sloth's to take.
    expect(v.others).toBe(4);
    expect(v.elsewhere).toBe(0);
  });

  it('takes the newest run on the issue — an implement run over an older review, a review over an older implement', () => {
    const sessions = [
      session({ id: 'impl-old', target: 7, watcher: dir('issue', 7), startedAt: '2026-08-20T09:00:00Z', status: 'done' }),
      session({ id: 'review', kind: 'sloth:review', target: 91, watcher: dir('review', 91, { issue: 7 }), startedAt: '2026-08-21T09:00:00Z', status: 'running' }),
      session({ id: 'impl-new', target: 8, watcher: dir('issue', 8), startedAt: '2026-08-21T09:00:00Z', status: 'running' }),
      session({ id: 'final', kind: 'sloth:review', target: 92, watcher: dir('approved', 92, { issue: 8 }), startedAt: '2026-08-20T09:00:00Z', status: 'done' }),
    ];
    const v = view([card(7, 'Code Review'), card(8, 'Code Review')], sessions);
    expect(v.columns.find((c) => c.role === 'codeReview')?.cards.map((c) => [c.issue, c.sessionId, c.status, c.kind])).toEqual([
      [7, 'review', 'running', 'review'],
      [8, 'impl-new', 'running', 'issue'],
    ]);
  });

  it('carries the assignee, labels, retries, step, PR, preview and waiting time through', () => {
    const parked = session({
      id: 'parked',
      target: 42,
      status: 'parked',
      watcher: dir('issue', 42, {
        retries: 2,
        preview: { issue: 42, key: 'k3y', startedAt: 0, expiresAt: 0, url: 'https://p.example' },
        ...state({ step: '3', pr: 'https://github.com/acme/widgets/pull/91', since: NOW / 1000 - 600 }),
      }),
    });
    const v = view([card(42, 'Sloth needs help', { assignees: ['bob'], labels: ['Fable: approved'] })], [parked], [cost(42, { cost: 4.5 })]);
    expect(v.columns.find((c) => c.role === 'needsHelp')?.cards[0]).toEqual({
      issue: 42,
      title: 'Issue 42',
      assignees: ['bob'],
      labels: ['Fable: approved'],
      closed: false,
      sessionId: 'parked',
      status: 'parked',
      step: '3',
      kind: 'issue',
      since: NOW / 1000 - 600,
      retries: 2,
      pr: 'https://github.com/acme/widgets/pull/91',
      preview: { url: 'https://p.example', key: 'k3y' },
      cost: 4.5,
    });
  });

  it('leaves a running card without a waiting time, an unpriced issue without a cost, and a queued card bare', () => {
    const running = session({ id: 'run', target: 1, status: 'running', watcher: dir('issue', 1, state({ since: 100 })) });
    const unpriced = session({ id: 'un', target: 2, status: 'done', watcher: dir('issue', 2) });
    const v = view([card(1, 'In Progress'), card(2, 'In Progress'), card(3, 'Todo')], [running, unpriced], [cost(2, { cost: null })]);
    const [a, b] = v.columns.find((x) => x.role === 'inProgress')!.cards;
    expect(a.since).toBeUndefined();
    expect(b.cost).toBeNull();
    expect(v.columns[0].cards[0]).toMatchObject({ sessionId: undefined, status: undefined, retries: 0, cost: null });
  });

  it('offers no preview link before the tunnel has an address', () => {
    const s = session({ id: 'x', target: 1, watcher: dir('issue', 1, { preview: { issue: 1, key: 'k', startedAt: 0, expiresAt: 0 } }) });
    expect(view([card(1, 'In Progress')], [s]).columns[1].cards[0].preview).toBeUndefined();
  });
});

describe('board snapshot', () => {
  beforeEach(() => configure());

  it('hands back the last board that was set, and forgets it when the config is reloaded', () => {
    expect(snapshot()).toBeUndefined();
    setSnapshot([card(1, 'Todo')]);
    expect(snapshot()?.items.map((i) => i.number)).toEqual([1]);
    expect(snapshot()?.at).toBeGreaterThan(0);
    setSnapshot([card(2, 'Todo')]);
    expect(snapshot()?.items.map((i) => i.number)).toEqual([2]);
    // The wizard may have pointed Sloth at another board.
    reloadConfig();
    expect(snapshot()).toBeUndefined();
  });

  it('clears on demand', () => {
    setSnapshot([card(1, 'Todo')]);
    clearSnapshot();
    expect(snapshot()).toBeUndefined();
  });
});
