import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { monitorApi } from '../server/api';
import { stopLoop } from '../server/runner/loop';
import { configure, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * The preview server (`pnpm start`) as the plugin wires it: its middlewares, in the order the plugin
 * registers them, on a real loopback server. The built page has to sit behind the guard like every
 * other page — registered in front of it, it answered `/` to anyone holding the tunnel address and
 * swallowed the QR link's `?code=` before the guard could turn it into a cookie.
 */
let server: http.Server;
let port: number;
let dist: string;

/** One request with the Host header of a phone on the tunnel, or of the machine itself. */
function get(p: string, host: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  configure({ repo: 'acme/widgets' });
  wipe();
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>Sloth</title></head><body></body></html>');
  const chain: ((req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void)[] = [];
  const preview = { middlewares: { use: (fn: (typeof chain)[number]) => chain.push(fn) }, httpServer: undefined, config: { root: dist, build: { outDir: '.' } } };
  (monitorApi().configurePreviewServer as (s: unknown) => void)(preview);
  server = http.createServer((req, res) => {
    let i = 0;
    const next = () => {
      const fn = chain[i++];
      if (fn) fn(req, res, next);
      else {
        res.statusCode = 404;
        res.end('sirv would answer this one');
      }
    };
    next();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  stopLoop();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('the built page under `pnpm start`', () => {
  it('is served to the machine Sloth runs on, title and all', async () => {
    const res = await get('/board', 'localhost');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<title>Sloth · widgets</title>');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
  it('is refused to a visitor without the cookie — the guard comes first', async () => {
    for (const p of ['/', '/board', '/sessions/issue-12-1a2b', '/api/overview']) {
      const res = await get(p, 'sloth.example.com');
      expect(res.status, p).toBe(401);
      expect(res.body).not.toContain('<title>');
    }
  });
  it('lets the guard see the QR link\'s code instead of serving the page over it', async () => {
    const res = await get('/?code=notacode', 'sloth.example.com');
    expect(res.status).toBe(401);
  });
});
