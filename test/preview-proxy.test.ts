import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newKey, startProxy, type Proxy } from '../server/runner/preview-proxy';
import { configure } from './harness';

/** A stand-in for the session's app: it answers with what it was asked, so the proxy's work is visible. */
function upstream(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-app': 'yes' });
      res.end(JSON.stringify({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString(), forwarded: !!req.headers['x-forwarded-for'] }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }),
    ),
  );
}

const key = newKey();
let app: { url: string; close: () => void };
let proxy: Proxy;
const at = (path: string) => `http://127.0.0.1:${proxy.port}${path}`;

beforeEach(async () => {
  configure();
  app = await upstream();
  proxy = (await startProxy(1, app.url, key))!;
});
afterEach(() => {
  proxy.close();
  app.close();
});

describe('the preview guard', () => {
  it('turns a request with no key away', async () => {
    const res = await fetch(at('/dashboard'));
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/link from the pull request/);
    expect((await fetch(at(`/?sloth_key=${newKey()}`))).status).toBe(401);
  });

  it('trades the key in the link for a cookie and redirects to the clean URL', async () => {
    const res = await fetch(at(`/app?sloth_key=${key}&tab=2`), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app?tab=2');
    expect(res.headers.get('set-cookie')).toBe(`sloth_preview=${key}; Path=/; HttpOnly; SameSite=Lax; Secure`);
  });

  it('leaves Secure off when the tunnel says the hop is plain http', async () => {
    const res = await fetch(at(`/?sloth_key=${key}`), { redirect: 'manual', headers: { 'x-forwarded-proto': 'http' } });
    expect(res.headers.get('set-cookie')).toBe(`sloth_preview=${key}; Path=/; HttpOnly; SameSite=Lax`);
  });

  it('proxies a request that carries the cookie, body, headers and all', async () => {
    const res = await fetch(at('/api/items?page=2'), {
      method: 'POST',
      body: 'hello',
      headers: { cookie: `other=1; sloth_preview=${key}`, 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-app')).toBe('yes');
    expect(await res.json()).toEqual({ url: '/api/items?page=2', method: 'POST', body: 'hello', forwarded: true });
  });

  it('answers 502 rather than hanging when the app is gone', async () => {
    app.close();
    const res = await fetch(at('/'), { headers: { cookie: `sloth_preview=${key}` } });
    expect(res.status).toBe(502);
  });
});
