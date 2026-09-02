import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { guard, remoteLink, startTunnel, stopTunnel, token } from '../server/remote';
import { setDry } from '../server/runner/log';
import { configure, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

/**
 * The sign-in redirect. A phone arrives with `?code=…` from the QR, is given the cookie and is sent on
 * to the page it asked for — which has to be a page of Sloth's, whatever the link says.
 */
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) =>
    guard(req, res, () => {
      res.statusCode = 200;
      res.end('signed in');
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  stopTunnel();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  configure({ publicUrl: 'https://sloth.example' });
  wipe();
  setDry(false);
  // The secret is minted before the codes are: `token()` rotating mid-test would invalidate them.
  token();
  // A port makes the tunnel real; `publicUrl` is trusted as its address, so no tool is started.
  startTunnel(port);
});

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
}

/**
 * One request with the path exactly as written and a `Host` of the tunnel, so the guard sees a remote
 * visitor. `fetch` can do neither: it normalises the target and silently drops a caller's `Host`.
 */
function get(target: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, headers: { host: 'sloth.example' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** The code the QR carries, spent by the request it is put on. */
const code = () => remoteLink().link!.split('code=')[1];
const signIn = (target: string) => get(`${target}${target.includes('?') ? '&' : '?'}code=${code()}`);

describe('the sign-in redirect', () => {
  it('keeps a protocol-relative target on Sloth instead of bouncing the visitor off-site', async () => {
    for (const target of ['//evil.example/', '/\\evil.example/', '///evil.example/?x=1']) {
      const res = await signIn(target);
      expect(res.status).toBe(302);
      const location = String(res.headers.location);
      // A `Location` starting with `//` is an absolute URL to a browser, whatever it looks like here.
      expect(location.startsWith('//')).toBe(false);
      expect(location).not.toMatch(/evil\.example/);
    }
  });

  it('keeps the page that was asked for, and drops the code from the address bar', async () => {
    const res = await signIn('/sessions/abc?tab=log');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/sessions/abc?tab=log');
    expect(String(res.headers['set-cookie'])).toMatch(/^sloth_remote=[a-f0-9]{48}; Path=\/; HttpOnly/);
  });

  it('turns away a code that has already been spent', async () => {
    const spent = code();
    await get(`/?code=${spent}`);
    expect((await get(`/?code=${spent}`)).status).toBe(401);
  });
});
