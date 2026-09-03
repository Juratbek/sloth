import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { guard } from '../server/remote';
import { setDry } from '../server/runner/log';
import { forgetWebhook, webhookSecret, webhookStatus } from '../server/webhook';
import { webhookMiddleware } from '../server/webhook-route';
import { resetGh } from './gh-mock';
import { configure, readLog, wipe } from './harness';

/** The ticks the route asked for. The real one would read the board's comments; here it only counts. */
const h = vi.hoisted(() => ({ ticks: [] as unknown[] }));
vi.mock('../server/runner/loop', () => ({
  tick: (options: unknown) => {
    h.ticks.push(options);
    return Promise.resolve();
  },
}));
vi.mock('../server/runner/gh', () => import('./gh-mock'));

/**
 * The delivery route, mounted exactly as the Vite plugin mounts it: in front of the guard, so a
 * request carrying no cookie — which is every request GitHub makes — still reaches it.
 */
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) =>
    webhookMiddleware(req, res, () =>
      guard(req, res, () => {
        res.statusCode = 200;
        res.end('past the guard');
      }),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  setDry(false);
  forgetWebhook();
  h.ticks.length = 0;
  // The secret is what authenticates a delivery; the tests sign with the one on disk.
  webhookSecret();
});

const comment = (body: string, action = 'created') => JSON.stringify({ action, issue: { number: 4 }, comment: { id: 100, body } });
/** A comment on a line of a PR's diff: GitHub names the thread `pull_request`, not `issue`. */
const reviewComment = (body: string, action = 'created') => JSON.stringify({ action, pull_request: { number: 20 }, comment: { id: 300, body } });
const sign = (body: string) => `sha256=${crypto.createHmac('sha256', webhookSecret()).update(body).digest('hex')}`;

/** One delivery, signed unless `null` says to send it unsigned. `headers` stands in for what a proxy would add. */
function post(body: string, event: string, signature: string | null = sign(body), headers: Record<string, string> = {}) {
  return fetch(`${base}/api/hooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
      ...headers,
    },
    body,
  });
}

/** A macrotask past the answer, by which time a tick the route started has been recorded. */
const settle = () => new Promise((r) => setImmediate(r));

describe('the GitHub delivery route', () => {
  it('reads the comments now when a mention is delivered, without making GitHub wait for the tick', async () => {
    const body = comment('Hey @sloth, please look at this');
    const res = await post(body, 'issue_comment');
    expect(res.status).toBe(202);
    await settle();
    expect(h.ticks).toEqual([{ comments: true }]);
    expect(webhookStatus().lastDelivery).toBeGreaterThan(0);
    expect(readLog().join('\n')).toMatch(/webhook: @sloth on #4 \(comment 100\)/);
  });

  it('reads the comments now when the mention was written on a line of a PR’s diff', async () => {
    const res = await post(reviewComment('@sloth why both fields?'), 'pull_request_review_comment');
    expect(res.status).toBe(202);
    await settle();
    expect(h.ticks).toEqual([{ comments: true }]);
    expect(readLog().join('\n')).toMatch(/webhook: @sloth on #20 \(review comment 300\)/);
  });

  it('answers a delivery even though it carries no cookie — the guard would refuse it', async () => {
    // A forwarding header is what makes a request non-local, and everything non-local needs the cookie.
    const proxied = { 'x-forwarded-for': '203.0.113.7' };
    const body = comment('@sloth status?');
    expect((await post(body, 'issue_comment', sign(body), proxied)).status).toBe(202);
    // The very same request one path over is refused, which is what the exemption is measured against.
    expect((await fetch(`${base}/api/overview`, { headers: proxied })).status).toBe(401);
  });

  it('refuses a delivery signed with the wrong secret, or not signed at all', async () => {
    const body = comment('@sloth do it');
    expect((await post(body, 'issue_comment', `sha256=${'0'.repeat(64)}`)).status).toBe(401);
    expect((await post(body, 'issue_comment', null)).status).toBe(401);
    await settle();
    expect(h.ticks).toEqual([]);
    expect(readLog().join('\n')).toMatch(/unsigned or signed with the wrong secret/);
  });

  it('records a ping and asks for nothing', async () => {
    expect((await post('{"zen":"Keep it logically awesome."}', 'ping')).status).toBe(204);
    await settle();
    expect(h.ticks).toEqual([]);
    expect(webhookStatus().lastPing).toBeGreaterThan(0);
  });

  it('ignores a comment that does not mention Sloth, an edit of one that does, and another event', async () => {
    for (const [body, event] of [
      [comment('looks good to me'), 'issue_comment'],
      [comment('@sloth do it', 'edited'), 'issue_comment'],
      [reviewComment('@sloth do it', 'edited'), 'pull_request_review_comment'],
      [comment('@sloth do it'), 'push'],
      ['not json at all', 'issue_comment'],
    ] as const) {
      expect((await post(body, event)).status).toBe(204);
    }
    await settle();
    expect(h.ticks).toEqual([]);
  });

  it('leaves every other path to the middleware behind it', async () => {
    const res = await fetch(`${base}/api/overview`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('past the guard');
  });

  it('answers a GET on the delivery path rather than treating it as one', async () => {
    expect((await fetch(`${base}/api/hooks/github`)).status).toBe(405);
  });
});
