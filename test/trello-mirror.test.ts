import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { answered } from '../server/runner/answers';
import { fetchBoard, moveCard } from '../server/runner/board';
import { comments } from '../server/runner/comments';
import { setDry } from '../server/runner/log';
import { mirrorAuthor, mirrorComments } from '../server/runner/trello-mirror';
import { ensureWebhook, forgetWebhook, isWebhookLive, webhookStatus } from '../server/webhook';
import { webhookMiddleware } from '../server/webhook-route';
import { verifyTrelloSignature } from '../server/webhook-trello';
import { resetSpawn, spawned } from './child-process-mock';
import { called, onGh, resetGh } from './gh-mock';
import { alivePid, configure, exists, makeSession, read, readLog, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

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
const ME = { id: 'm-sloth', username: 'slothbot' };
const linkedCard = (id: string, list: string, issue: number) => ({
  id,
  name: `Card ${id}`,
  desc: '',
  idList: list,
  pos: 1,
  closed: false,
  shortUrl: `https://trello.com/c/${id}`,
  labels: [],
  attachments: [{ url: `https://github.com/acme/widgets/issues/${issue}`, name: 'issue' }],
  members: [{ id: 'm-f', username: 'friend' }],
});
const cardComment = (id: string, cardId: string, username: string, text: string, memberId = `m-${username}`) => ({
  id,
  date: new Date().toISOString(),
  data: { card: { id: cardId }, text },
  memberCreator: { id: memberId, username },
});
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');

interface Hit {
  method: string;
  path: string;
  params: URLSearchParams;
}
const hits: Hit[] = [];
let answers: Record<string, unknown> = {};
const trelloCalls = (pattern: RegExp) => hits.filter((h) => pattern.test(`${h.method} ${h.path}`));

beforeEach(() => {
  process.env.SLOTH_TRELLO_KEY = 'k';
  process.env.SLOTH_TRELLO_TOKEN = 't';
  delete process.env.SLOTH_TRELLO_SECRET;
  configure({
    project: { provider: 'trello', id: BOARD, number: 0, owner: 'friend', title: 'Widgets' },
    statusField: { id: BOARD, columns: LISTS },
    roles: { admin: 'friend', developers: ['dev'], testers: ['tess'] },
  });
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
  forgetWebhook();
  hits.length = 0;
  answers = {
    [`GET /boards/${BOARD}/lists`]: Object.values(LISTS).filter((l) => l.id).map((l, i) => ({ ...l, pos: i, closed: false })),
    [`GET /boards/${BOARD}/cards`]: [linkedCard('c4', 'l-help', 4)],
    [`GET /boards/${BOARD}/actions`]: [],
    'GET /members/me': ME,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/1/, '');
      const method = String(init?.method ?? 'GET');
      hits.push({ method, path, params: u.searchParams });
      const body = answers[`${method} ${path}`] ?? (method === 'GET' ? [] : { id: 'new' });
      if (body instanceof Error) return { ok: false, status: 500, text: async () => body.message };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }),
  );
  onGh(/api graphql/, { data: { repository: { i4: { state: 'OPEN', labels: { nodes: [] } } } } });
  onGh(/api repos\/acme\/widgets\/issues\/4\/comments -f/, '900');
});
afterEach(() => vi.unstubAllGlobals());

describe('mirrorAuthor', () => {
  it('gives a copied comment back its Trello author and their words, and leaves any other comment alone', () => {
    expect(mirrorAuthor({ login: 'gh-login', body: '**@friend on Trello:**\n\n@sloth start over' })).toEqual({ login: 'friend', body: '@sloth start over' });
    expect(mirrorAuthor({ login: 'gh-login', body: 'plain' })).toEqual({ login: 'gh-login', body: 'plain' });
  });
});

describe('card comments onto the issue', () => {
  it('copies a card comment onto its issue under the author’s name, once, never Sloth’s own, and trigger 3 reads it as theirs', async () => {
    await fetchBoard();
    answers[`GET /boards/${BOARD}/actions`] = [cardComment('a1', 'c4', 'friend', '@sloth please add tests too'), cardComment('a2', 'c4', 'slothbot', 'Sloth: hi', ME.id)];
    await mirrorComments();
    const posted = called(/issues\/4\/comments -f/);
    expect(posted).toHaveLength(1);
    expect(posted[0].args.join(' ')).toMatch(/body=\*\*@friend on Trello:\*\*\n\n@sloth please add tests too/);
    expect(exists(statePath('mirrored', 't-a1'))).toBe(true);
    expect(exists(statePath('mirrored', 't-a2'))).toBe(false);
    // Read again: nothing is copied twice.
    resetGh();
    await mirrorComments();
    expect(called(/issues\/4\/comments -f/)).toHaveLength(0);
  });
  it('is read by trigger 3 the same tick, as an order from the Trello author', async () => {
    await fetchBoard();
    answers[`GET /boards/${BOARD}/actions`] = [cardComment('a1', 'c4', 'friend', '@sloth start over')];
    await mirrorComments();
    onGh(/api -X GET search\/issues/, '');
    onGh(/api repos\/acme\/widgets\/issues\/4\/comments\?since/, b64({ id: 900, login: 'gh-login', body: '**@friend on Trello:**\n\n@sloth start over' }));
    await comments();
    expect(spawned).toHaveLength(1);
    expect(readLog().some((l) => /#4 .*Order from friend \(admin/.test(l) || /launch/.test(l))).toBe(true);
    expect(exists(statePath('seen', '900'))).toBe(true);
  });
  it('delivers a plain answer straight to the waiting session’s inbox', async () => {
    await fetchBoard();
    makeSession('issue', 4, { pid: alivePid(), 'state.json': { state: 'waiting' } });
    answers[`GET /boards/${BOARD}/actions`] = [cardComment('a1', 'c4', 'tess', 'Use the blue button, not the red one.')];
    await mirrorComments();
    const inbox = read(`${sessionDir('issue', 4)}/inbox/900.md`);
    expect(inbox).toMatch(/author: tess\nrole: tester\ncomment: 900/);
    expect(inbox).toMatch(/Use the blue button/);
    expect(exists(statePath('seen', '900'))).toBe(true);
  });
  it('is the answer trigger 6 relaunches a parked card on', async () => {
    await fetchBoard();
    onGh(/api repos\/acme\/widgets\/issues\/4\/comments --paginate/, [[800, 'gh-login', Buffer.from('**Sloth:** Which colour?').toString('base64')].join('\t'), [900, 'gh-login', Buffer.from('**@tess on Trello:**\n\nBlue.').toString('base64')].join('\t')].join('\n'));
    await answered([{ number: 4, title: 'Card c4', status: 'Sloth needs help', labels: [], assignees: [], closed: false }]);
    expect(spawned).toHaveLength(1);
    expect(readLog().some((l) => /Answer from tess \(tester\)/.test(l))).toBe(true);
  });
  it('opens an issue for a card that has none when the comment mentions Sloth, and marks any other unlinked comment read', async () => {
    await fetchBoard();
    answers['GET /cards/c9'] = { ...linkedCard('c9', 'l-backlog', 0), attachments: [], name: 'Dark mode' };
    onGh(/issue list/, '');
    onGh(/issue create/, 'https://github.com/acme/widgets/issues/9\n');
    onGh(/api repos\/acme\/widgets\/issues\/9\/comments -f/, '901');
    answers[`GET /boards/${BOARD}/actions`] = [cardComment('a5', 'c9', 'friend', '@sloth do this one'), cardComment('a6', 'c8', 'friend', 'just a note')];
    await mirrorComments();
    expect(called(/issue create/)).toHaveLength(1);
    expect(called(/issues\/9\/comments -f/)).toHaveLength(1);
    expect(exists(statePath('mirrored', 't-a6'))).toBe(true);
    expect(trelloCalls(/GET \/cards\/c8/)).toHaveLength(0);
  });
});

describe('issue comments onto the card', () => {
  it('copies Sloth’s words as they are and a person’s under their login, never a copy of a card comment', async () => {
    await fetchBoard();
    onGh(/api repos\/acme\/widgets\/issues\/comments\?since/, [
      b64({ id: 1, issue: 4, login: 'gh-login', body: '**Sloth:** PR #7 passed the review — ready to test.' }),
      b64({ id: 2, issue: 4, login: 'jurat', body: 'Looks good to me' }),
      b64({ id: 3, issue: 4, login: 'gh-login', body: '**@friend on Trello:**\n\n@sloth go' }),
      b64({ id: 5, issue: 77, login: 'jurat', body: 'no card for this issue' }),
    ].join('\n'));
    await mirrorComments();
    const texts = trelloCalls(/POST \/cards\/c4\/actions\/comments/).map((h) => h.params.get('text'));
    expect(texts).toEqual(['**Sloth:** PR #7 passed the review — ready to test.', '**@jurat on GitHub:**\n\nLooks good to me']);
    expect(exists(statePath('mirrored', 'g-1'))).toBe(true);
    expect(exists(statePath('mirrored', 'g-3'))).toBe(false);
    hits.length = 0;
    await mirrorComments();
    expect(trelloCalls(/POST \/cards\/c4\/actions\/comments/)).toHaveLength(0);
  });
  it('does nothing at all on a GitHub board, and only logs in a dry run', async () => {
    setDry(true);
    await fetchBoard();
    answers[`GET /boards/${BOARD}/actions`] = [cardComment('a1', 'c4', 'friend', '@sloth hello')];
    await mirrorComments();
    expect(called(/issues\/4\/comments -f/)).toHaveLength(0);
    expect(readLog().some((l) => /dry-run: would copy Trello comment by friend onto #4/.test(l))).toBe(true);
    setDry(false);
    configure();
    hits.length = 0;
    await mirrorComments();
    expect(hits).toHaveLength(0);
  });
});

describe('a card for an issue without one', () => {
  it('creates the card in the list the issue is moved to, with the issue attached', async () => {
    answers[`GET /boards/${BOARD}/cards`] = [];
    answers['POST /cards'] = { id: 'c-new', name: 'Fix the footer' };
    onGh(/issue view 12/, 'Fix the footer\n');
    expect(await moveCard(12, 'l-wip')).toBe(true);
    const create = trelloCalls(/POST \/cards$/)[0];
    expect(create.params.get('idList')).toBe('l-wip');
    expect(create.params.get('name')).toBe('Fix the footer');
    expect(create.params.get('urlSource')).toBe('https://github.com/acme/widgets/issues/12');
    expect(trelloCalls(/PUT \/cards\/c-new/)[0].params.get('idList')).toBe('l-wip');
  });
  it('shows the card’s members as its assignees', async () => {
    expect((await fetchBoard())?.[0].assignees).toEqual(['friend']);
  });
});

describe('the Trello webhook', () => {
  it('is not set up without the secret, and says the board is polled instead', async () => {
    configure({ project: { provider: 'trello', id: BOARD, number: 0, owner: 'friend', title: 'Widgets' }, statusField: { id: BOARD, columns: LISTS }, publicUrl: 'https://sloth.example' });
    const status = await ensureWebhook();
    expect(status.state).toBe('failed');
    expect(status.reason).toMatch(/no Trello secret is set/);
    expect(isWebhookLive()).toBe(false);
  });
  it('creates the board’s webhook at the public address, then repoints it when the address moves', async () => {
    process.env.SLOTH_TRELLO_SECRET = 'shh';
    configure({ project: { provider: 'trello', id: BOARD, number: 0, owner: 'friend', title: 'Widgets' }, statusField: { id: BOARD, columns: LISTS }, publicUrl: 'https://sloth.example' });
    answers['GET /tokens/t/webhooks'] = [];
    answers['POST /webhooks'] = { id: 'w1', callbackURL: 'https://sloth.example/api/hooks/trello', idModel: BOARD, active: true };
    let status = await ensureWebhook();
    expect(status).toMatchObject({ state: 'active', url: 'https://sloth.example/api/hooks/trello', hookId: 'w1' });
    expect(trelloCalls(/POST \/webhooks/)[0].params.get('idModel')).toBe(BOARD);
    expect(isWebhookLive()).toBe(true);

    configure({ project: { provider: 'trello', id: BOARD, number: 0, owner: 'friend', title: 'Widgets' }, statusField: { id: BOARD, columns: LISTS }, publicUrl: 'https://moved.example' });
    answers['GET /tokens/t/webhooks'] = [{ id: 'w1', callbackURL: 'https://sloth.example/api/hooks/trello', idModel: BOARD, active: true }];
    status = await ensureWebhook();
    expect(status).toMatchObject({ state: 'active', url: 'https://moved.example/api/hooks/trello', hookId: 'w1' });
    expect(trelloCalls(/PUT \/webhooks\/w1/)[0].params.get('callbackURL')).toBe('https://moved.example/api/hooks/trello');
  });
  it('verifies a delivery against the secret over the body and the callback URL', () => {
    process.env.SLOTH_TRELLO_SECRET = 'shh';
    const body = Buffer.from('{"action":{}}');
    const url = 'https://sloth.example/api/hooks/trello';
    const sig = crypto.createHmac('sha1', 'shh').update(`{"action":{}}${url}`).digest('base64');
    expect(verifyTrelloSignature(body, sig, url)).toBe(true);
    expect(verifyTrelloSignature(body, sig, 'https://other.example/api/hooks/trello')).toBe(false);
    expect(verifyTrelloSignature(body, 'nope', url)).toBe(false);
    delete process.env.SLOTH_TRELLO_SECRET;
    expect(verifyTrelloSignature(body, sig, url)).toBe(false);
  });
});

describe('the Trello delivery route', () => {
  const h = vi.hoisted(() => ({ ticks: [] as unknown[] }));
  vi.mock('../server/runner/loop', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../server/runner/loop')>()),
    tick: (options: unknown) => {
      h.ticks.push(options);
      return Promise.resolve();
    },
  }));
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) =>
      webhookMiddleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const realFetch = http.request;
  const send = (method: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const req = realFetch(`${base}/api/hooks/trello`, { method, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(body);
    });

  it('answers Trello’s HEAD, rejects an unsigned POST, and starts a comments tick on a signed card comment', async () => {
    process.env.SLOTH_TRELLO_SECRET = 'shh';
    configure({ project: { provider: 'trello', id: BOARD, number: 0, owner: 'friend', title: 'Widgets' }, statusField: { id: BOARD, columns: LISTS }, publicUrl: 'https://sloth.example' });
    h.ticks.length = 0;
    expect(await send('HEAD')).toBe(200);
    const body = JSON.stringify({ action: { type: 'commentCard', data: { text: 'hello', card: { id: 'c4', name: 'Card c4' } } } });
    expect(await send('POST', body)).toBe(401);
    expect(webhookStatus()).toMatchObject({ state: 'failed', reason: expect.stringMatching(/different secret/) });
    expect(isWebhookLive()).toBe(false);
    const sign = (b: string) => crypto.createHmac('sha1', 'shh').update(`${b}https://sloth.example/api/hooks/trello`).digest('base64');
    expect(await send('POST', body, { 'x-trello-webhook': sign(body) })).toBe(200);
    expect(h.ticks).toEqual([{ comments: true }]);
    const other = JSON.stringify({ action: { type: 'updateCard', data: {} } });
    expect(await send('POST', other, { 'x-trello-webhook': sign(other) })).toBe(204);
    expect(h.ticks).toHaveLength(1);
    expect(readLog().some((l) => /a comment on Trello card "Card c4"/.test(l))).toBe(true);
  });
});
