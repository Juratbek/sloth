import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMiddleware } from '../server/api';
import { stopLoop } from '../server/runner/loop';
import { baseConfig, configure, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/** The API on a real loopback server, mounted exactly as the Vite plugin mounts it. */
let server: http.Server;
let base: string;

const rejections: unknown[] = [];
const onRejection = (e: unknown) => rejections.push(e);

beforeAll(async () => {
  server = http.createServer((req, res) =>
    apiMiddleware(req, res, () => {
      res.statusCode = 404;
      res.end('not the api');
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.on('unhandledRejection', onRejection);
});
afterAll(async () => {
  process.off('unhandledRejection', onRejection);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  configure();
  wipe();
  rejections.length = 0;
});

/** Waits a macrotask past the response, so a rejection nobody caught has been reported by then. */
const settle = () => new Promise((r) => setImmediate(r));

/** One POST whose body is written in two pieces, so the server sees two chunks and not one. */
function postInTwoWrites(target: string, first: Buffer, second: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: target, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve(JSON.parse(out)));
      },
    );
    req.on('error', reject);
    req.write(first);
    setTimeout(() => req.end(second), 10);
  });
}

describe('the API middleware', () => {
  it('answers 500 for a body over the 1 MiB cap instead of letting the rejection end the process', async () => {
    const res = await fetch(`${base}/api/stack/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['x'.repeat(2 * 1024 * 1024)] }),
    }).catch(() => undefined);
    await settle();
    // The server may drop the socket as it rejects the oversized body; what matters is that it survived.
    if (res) expect(res.status).toBe(500);
    expect(rejections).toEqual([]);
  });

  it('survives a client that hangs up in the middle of a POST', async () => {
    const controller = new AbortController();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"ids":['));
        setTimeout(() => controller.abort(), 10);
      },
    });
    await fetch(`${base}/api/stack/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit).catch(() => undefined);
    await settle();
    expect(rejections).toEqual([]);
    // Still serving: the next request is answered as usual.
    expect((await fetch(`${base}/api/service`)).status).toBe(200);
  });

  it('reads a body whose characters are split across chunks without mangling them', async () => {
    // The two halves of an `é` arrive in separate chunks. Each chunk used to be decoded on its own, so
    // whichever character straddled the boundary came out as U+FFFD — an accented project title, say.
    const seed = baseConfig();
    const title = 'Cœur & Café';
    const body = Buffer.from(JSON.stringify({ ...seed, project: { ...(seed.project as Record<string, unknown>), title } }));
    const at = body.indexOf(Buffer.from('é')) + 1;
    try {
      const saved = (await postInTwoWrites('/api/setup/config', body.subarray(0, at), body.subarray(at))) as {
        config?: { project?: { title?: string } };
      };
      expect(saved.config?.project?.title).toBe(title);
    } finally {
      // Saving the wizard arms the watcher's timers; this test wanted the parsing, not the watching.
      stopLoop();
    }
  });

  it('clamps the usage window at both ends, so a negative one is a window and not a 500, and defaults to a week', async () => {
    // Hours in the window: a day is 24 buckets. Absent, empty, unreadable or zero → the week the UI
    // opens on; below one day → one; above the month → the month.
    const hours = async (query: string) => {
      const res = await fetch(`${base}/api/usage${query}`);
      expect(res.status).toBe(200);
      const series = (await res.json()) as { from: string; to: string };
      return (Date.parse(series.to) - Date.parse(series.from)) / 3_600_000;
    };
    for (const query of ['', '?days=', '?days=nonsense', '?days=0', '?days=0.5']) expect(await hours(query)).toBe(7 * 24);
    for (const query of ['?days=-5', '?days=-999999999999']) expect(await hours(query)).toBe(24);
    expect(await hours('?days=99')).toBe(31 * 24);
    expect(await hours('?days=3')).toBe(3 * 24);
  });

  it('serves the webhook status, and configures the hook again when asked to', async () => {
    // Read by any signed-in page (the phone included) and retried from the settings page; neither is a
    // wizard endpoint, so neither is held back to the machine Sloth runs on.
    const status = (await (await fetch(`${base}/api/webhook`)).json()) as { state: string; live: boolean; effectiveCommentSeconds: number };
    expect(status).toMatchObject({ state: 'off', live: false, effectiveCommentSeconds: 30 });
    const retried = (await (await fetch(`${base}/api/webhook/retry`, { method: 'POST' })).json()) as { state: string; reason?: string };
    // Nothing is reachable from outside in a test, so the retry can only answer what stands in the way.
    expect(retried).toMatchObject({ state: 'off', reason: expect.stringMatching(/no public URL/) });
  });

  it('passes a request the API does not own to the next middleware', async () => {
    const res = await fetch(`${base}/index.html`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not the api');
  });
});
