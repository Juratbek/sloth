import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardInfo, moveFromSession } from '../server/board-api';
import { normalizeConfig } from '../server/config-file';
import { fetchBoard, moveCard, pickupOrder } from '../server/runner/board';
import { ensureTrelloLists, issueOf } from '../server/runner/board-trello';
import { setSnapshot } from '../server/runner/board-snapshot';
import { knownColumns, refreshColumns } from '../server/runner/columns';
import { setDry } from '../server/runner/log';
import { ensureSkipLabel } from '../server/runner/markers';
import { sessionEnv } from '../server/runner/session-env';
import type { TrelloCard } from '../server/trello';
import { called, fail, onGh, resetGh } from './gh-mock';
import { COLUMNS, baseConfig, card, configure, readLog, sessionDir } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

const BOARD = '0123456789abcdef01234567';
const LISTS = {
  pickup: { id: 'l-todo', name: 'Todo' },
  inProgress: { id: 'l-wip', name: 'In Progress' },
  needsHelp: { id: 'l-help', name: 'Sloth needs help' },
  codeReview: { id: 'l-review', name: 'Code Review' },
  approved: { id: 'l-approved', name: 'Approved' },
  qa: { id: '', name: '' },
  done: { id: 'l-done', name: 'Done' },
};
const trelloConfig = (over: Record<string, unknown> = {}) => ({
  project: { provider: 'trello', id: BOARD, number: 0, owner: 'friend', title: 'Widgets' },
  statusField: { id: BOARD, columns: LISTS },
  ...over,
});

/** The Trello API as the tests want it: every call recorded, answered by path. */
interface Hit {
  method: string;
  path: string;
  params: URLSearchParams;
}
const hits: Hit[] = [];
let answers: Record<string, unknown> = {};
const lists = () => [
  { id: 'l-backlog', name: 'Backlog', pos: 1000, closed: false },
  { id: 'l-todo', name: 'Todo', pos: 2000, closed: false },
  { id: 'l-wip', name: 'In Progress', pos: 3000, closed: false },
  { id: 'l-help', name: 'Sloth needs help', pos: 4000, closed: false },
  { id: 'l-review', name: 'Code Review', pos: 5000, closed: false },
  { id: 'l-approved', name: 'Approved', pos: 6000, closed: false },
  { id: 'l-done', name: 'Done', pos: 7000, closed: false },
];
const trelloCard = (id: string, list: string, over: Partial<TrelloCard> = {}): TrelloCard => ({
  id,
  name: `Card ${id}`,
  desc: '',
  idList: list,
  pos: Number(id.replace(/\D/g, '')) || 1,
  closed: false,
  shortUrl: `https://trello.com/c/${id}`,
  labels: [],
  attachments: [],
  ...over,
});
const linked = (id: string, list: string, issue: number, over: Partial<TrelloCard> = {}) =>
  trelloCard(id, list, { attachments: [{ url: `https://github.com/acme/widgets/issues/${issue}`, name: 'issue' }], ...over });

beforeEach(() => {
  process.env.SLOTH_TRELLO_KEY = 'k';
  process.env.SLOTH_TRELLO_TOKEN = 't';
  configure(trelloConfig());
  resetGh();
  setDry(false);
  hits.length = 0;
  answers = { [`GET /boards/${BOARD}/lists`]: lists(), [`GET /boards/${BOARD}/cards`]: [], [`GET /boards/${BOARD}/labels`]: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/1/, '');
      const method = String(init?.method ?? 'GET');
      hits.push({ method, path, params: u.searchParams });
      const key = `${method} ${path}`;
      const body = answers[key] ?? (method === 'GET' ? [] : { id: 'new' });
      if (body instanceof Error) return { ok: false, status: 500, text: async () => body.message };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const trelloCalls = (pattern: RegExp) => hits.filter((h) => pattern.test(`${h.method} ${h.path}`));

describe('config', () => {
  it('reads a config without a provider as a GitHub board, and a Trello one without an owner', () => {
    expect(normalizeConfig(baseConfig()).project.provider).toBe('github');
    expect(normalizeConfig(baseConfig(trelloConfig({ project: { provider: 'trello', id: BOARD, title: 'W' } }))).project).toMatchObject({ provider: 'trello', owner: '', number: 0 });
    expect(() => normalizeConfig(baseConfig({ project: { provider: 'jira', id: 'x', owner: 'o', title: 't' } }))).toThrow(/provider/);
  });
  it('tells a session which board it is on and where the board API is', () => {
    const env = sessionEnv(sessionDir('issue', 1), { issue: 1 }, 'opus', false);
    expect(env.SLOTH_BOARD).toBe('trello');
    expect(env.SLOTH_BOARD_API).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/board$/);
    expect(env.SLOTH_COL_IN_PROGRESS_ID).toBe('l-wip');
  });
});

describe('issueOf', () => {
  it('reads the watched repository issue off an attachment, then the description, and no other repository', () => {
    expect(issueOf(linked('c1', 'l-todo', 12))).toBe(12);
    expect(issueOf(trelloCard('c2', 'l-todo', { desc: 'see https://github.com/acme/widgets/issues/7 please' }))).toBe(7);
    expect(issueOf(trelloCard('c3', 'l-todo', { attachments: [{ url: 'https://github.com/acme/other/issues/9', name: '' }] }))).toBeUndefined();
    expect(issueOf(trelloCard('c4', 'l-todo', { desc: 'https://github.com/acme/widgets/pull/9' }))).toBeUndefined();
  });
});

describe('fetchBoard on Trello', () => {
  it('lists the linked cards with their list as the column, in list position, with the labels of card and issue', async () => {
    answers[`GET /boards/${BOARD}/cards`] = [
      linked('c2', 'l-todo', 2, { pos: 20 }),
      linked('c1', 'l-todo', 1, { pos: 10, labels: [{ id: 'lb', name: 'Sloth: skip', color: 'red' }] }),
      linked('c3', 'l-review', 3, { pos: 5 }),
      trelloCard('c9', 'l-backlog', { desc: 'a note with no issue' }),
    ];
    onGh(/api graphql/, { data: { repository: { i1: { state: 'OPEN', labels: { nodes: [] } }, i2: { state: 'OPEN', labels: { nodes: [{ name: 'bug' }] } }, i3: { state: 'CLOSED', labels: { nodes: [{ name: 'Fable: approved' }] } } } } });
    const board = await fetchBoard();
    expect(board?.map((i) => [i.number, i.status, i.priority])).toEqual([
      [3, 'Code Review', 0],
      [1, 'Todo', 0],
      [2, 'Todo', 1],
    ]);
    expect(board?.find((i) => i.number === 1)?.labels).toEqual(['Sloth: skip']);
    expect(board?.find((i) => i.number === 2)?.labels).toEqual(['bug']);
    expect(board?.find((i) => i.number === 3)).toMatchObject({ closed: true, labels: ['Fable: approved'], title: 'Card c3' });
    expect(pickupOrder(board!, 'Todo')).toEqual([2]);
    expect(called(/issue create/)).toHaveLength(0);
  });
  it('opens an issue for a pickup card without one and links the two, but not for a skipped card or in a dry run', async () => {
    answers[`GET /boards/${BOARD}/cards`] = [
      trelloCard('c1', 'l-todo', { name: 'Add a login page', desc: 'With email and password.' }),
      trelloCard('c2', 'l-todo', { labels: [{ id: 'lb', name: 'Sloth: skip', color: 'red' }] }),
    ];
    onGh(/issue create/, 'https://github.com/acme/widgets/issues/41\n');
    onGh(/api graphql/, { data: { repository: { i41: { state: 'OPEN', labels: { nodes: [] } } } } });
    const board = await fetchBoard();
    expect(board?.map((i) => i.number)).toEqual([41]);
    const create = called(/issue create/);
    expect(create).toHaveLength(1);
    expect(create[0].args).toContain('Add a login page');
    expect(create[0].args.join(' ')).toMatch(/With email and password\.\n\n---\nTrello card: https:\/\/trello\.com\/c\/c1/);
    const attach = trelloCalls(/POST \/cards\/c1\/attachments/);
    expect(attach).toHaveLength(1);
    expect(attach[0].params.get('url')).toBe('https://github.com/acme/widgets/issues/41');
    expect(trelloCalls(/POST \/cards\/c1\/actions\/comments/)[0].params.get('text')).toMatch(/Sloth is on this card\. Comment here to talk to it — mention @sloth/);
    expect(readLog().at(-1)).toMatch(/Trello card "Add a login page" → issue #41/);

    resetGh();
    hits.length = 0;
    setDry(true);
    answers[`GET /boards/${BOARD}/cards`] = [trelloCard('c1', 'l-todo')];
    expect(await fetchBoard()).toEqual([]);
    expect(called(/issue create/)).toHaveLength(0);
    expect(readLog().at(-1)).toMatch(/dry-run: would open an issue for Trello card "Card c1"/);
  });
  it('reuses the issue it opened before when the card was left unlinked, and falls back to the description when attaching fails', async () => {
    answers[`GET /boards/${BOARD}/cards`] = [trelloCard('c1', 'l-todo')];
    answers['POST /cards/c1/attachments'] = new Error('no attachments for you');
    onGh(/issue list .*in:body/, '41\n');
    onGh(/api graphql/, { data: { repository: { i41: { state: 'OPEN', labels: { nodes: [] } } } } });
    expect((await fetchBoard())?.map((i) => i.number)).toEqual([41]);
    expect(called(/issue create/)).toHaveLength(0);
    expect(called(/issue list/)[0].args.join(' ')).toMatch(/"https:\/\/trello\.com\/c\/c1" in:body/);
    expect(trelloCalls(/PUT \/cards\/c1/)[0].params.get('desc')).toBe('GitHub issue: https://github.com/acme/widgets/issues/41');
    expect(trelloCalls(/POST \/cards\/c1\/actions\/comments/)).toHaveLength(1);
  });
  it('is undefined when Trello or GitHub will not answer', async () => {
    answers[`GET /boards/${BOARD}/cards`] = new Error('down');
    expect(await fetchBoard()).toBeUndefined();
    expect(readLog().at(-1)).toMatch(/board fetch failed: Trello GET/);
  });
});

describe('moveCard on Trello', () => {
  it('moves the issue’s card to the list, finding a card the last read did not know', async () => {
    answers[`GET /boards/${BOARD}/cards`] = [linked('c5', 'l-todo', 5)];
    onGh(/api graphql/, { data: { repository: { i5: { state: 'OPEN', labels: { nodes: [] } } } } });
    await fetchBoard();
    expect(await moveCard(5, 'l-wip')).toBe(true);
    const put = trelloCalls(/PUT \/cards\/c5/);
    expect(put).toHaveLength(1);
    expect(put[0].params.get('idList')).toBe('l-wip');

    answers[`GET /boards/${BOARD}/cards`] = [linked('c6', 'l-todo', 6)];
    expect(await moveCard(6, 'l-wip')).toBe(true);
    expect(trelloCalls(/PUT \/cards\/c6/)).toHaveLength(1);
    answers[`GET /boards/${BOARD}/cards`] = [];
    onGh(/issue view 7/, fail('no such issue'));
    expect(await moveCard(7, 'l-wip')).toBe(false);
    expect(readLog().at(-1)).toMatch(/#7 has no Trello card and its title could not be read: no such issue/);
    setDry(true);
    expect(await moveCard(8, 'l-wip')).toBe(true);
    expect(readLog().at(-1)).toMatch(/dry-run: would move #8 to Trello list l-wip/);
  });
});

describe('columns and labels on Trello', () => {
  it('refreshes the columns from the board’s lists', async () => {
    await refreshColumns();
    expect(knownColumns().map((c) => c.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'Sloth needs help', 'Code Review', 'Approved', 'Done']);
  });
  it('creates the lists a board lacks, after the watched one, and Done at the end', async () => {
    answers[`GET /boards/${BOARD}/lists`] = [
      { id: 'l-todo', name: 'Todo', pos: 2000, closed: false },
      { id: 'l-later', name: 'Later', pos: 4000, closed: false },
    ];
    let created = 0;
    (fetch as any).mockImplementation(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/1/, '');
      const method = String(init?.method ?? 'GET');
      hits.push({ method, path, params: u.searchParams });
      if (method === 'POST' && path === '/lists') {
        created += 1;
        const list = { id: `new-${created}`, name: u.searchParams.get('name'), pos: Number(u.searchParams.get('pos')) || 9000, closed: false };
        (answers[`GET /boards/${BOARD}/lists`] as unknown[]).push(list);
        return { ok: true, status: 200, json: async () => list };
      }
      return { ok: true, status: 200, json: async () => answers[`${method} ${path}`] ?? [] };
    });
    const wanted = { pickup: { id: 'l-todo', name: 'Todo' }, inProgress: { id: '', name: '' }, needsHelp: { id: '', name: 'Stuck' }, codeReview: { id: '', name: '' }, approved: { id: '', name: '' }, qa: { id: '', name: '' }, done: { id: '', name: '' } };
    const columns = await ensureTrelloLists(BOARD, wanted);
    expect(trelloCalls(/POST \/lists/).map((h) => [h.params.get('name'), h.params.get('pos')])).toEqual([
      ['In Progress', '2400'],
      ['Stuck', '2800'],
      ['Code Review', '3200'],
      ['Approved', '3600'],
      ['Done', 'bottom'],
    ]);
    expect(columns.inProgress).toEqual({ id: 'new-1', name: 'In Progress' });
    expect(columns.needsHelp.name).toBe('Stuck');
    expect(columns.qa).toEqual({ id: '', name: '' });
    expect(columns.done).toEqual({ id: 'new-5', name: 'Done' });
  });
  it('creates the skip label on the board once, beside the one in the repository', async () => {
    await ensureSkipLabel();
    expect(trelloCalls(/POST \/labels/)).toHaveLength(1);
    expect(trelloCalls(/POST \/labels/)[0].params.get('name')).toBe('Sloth: skip');
    expect(called(/label create/)).toHaveLength(1);
    answers[`GET /boards/${BOARD}/labels`] = [{ id: 'x', name: 'Sloth: skip', color: 'red' }];
    hits.length = 0;
    await ensureSkipLabel();
    expect(trelloCalls(/POST \/labels/)).toHaveLength(0);
  });
});

describe('the board API for sessions', () => {
  it('answers a card’s column live from Trello, from the last read when the card is unknown, and moves by column name', async () => {
    expect(await cardInfo(4)).toEqual({ issue: 4, column: '', asOf: expect.any(String) });
    setSnapshot([card(4, 'Todo')]);
    expect((await cardInfo(4)).column).toBe('Todo');
    await refreshColumns();
    answers[`GET /boards/${BOARD}/cards`] = [linked('c4', 'l-todo', 4)];
    await fetchBoard();
    answers['GET /cards/c4'] = linked('c4', 'l-review', 4);
    expect((await cardInfo(4)).column).toBe('Code Review');
    answers['GET /cards/c4'] = new Error('Trello is down');
    expect((await cardInfo(4)).column).toBe('Todo');
    expect(await moveFromSession({ issue: 4, column: 'in progress' })).toEqual({ ok: true, issue: 4, column: 'In Progress' });
    expect(trelloCalls(/PUT \/cards\/c4/)[0].params.get('idList')).toBe('l-wip');
    expect(await moveFromSession({ issue: 4, column: 'Planning' })).toMatchObject({ ok: false, error: expect.stringMatching(/no such column: Planning — the board has Backlog, Todo/) });
    expect(await moveFromSession({ issue: 'x', column: 'Todo' })).toMatchObject({ ok: false, error: expect.stringMatching(/issue/) });
  });
});

describe('a GitHub board is untouched', () => {
  it('still reads the Projects board and never calls Trello', async () => {
    configure({ statusField: { id: 'PVTSSF_1', columns: COLUMNS } });
    onGh(/api graphql/, { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [] } } } });
    expect(await fetchBoard()).toEqual([]);
    expect(hits).toHaveLength(0);
    expect(sessionEnv(sessionDir('issue', 1), { issue: 1 }, 'opus', false).SLOTH_BOARD).toBe('github');
  });
});
