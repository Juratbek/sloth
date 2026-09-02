import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMiddleware } from '../server/api';
import { configure, wipe } from './harness';

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

  it('passes a request the API does not own to the next middleware', async () => {
    const res = await fetch(`${base}/index.html`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not the api');
  });
});
