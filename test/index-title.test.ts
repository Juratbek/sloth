import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewIndex, withTitle } from '../server/preview-index';
import { configure } from './harness';

let server: http.Server;
let base: string;
let dist: string;

beforeAll(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>Sloth · medora</title></head><body></body></html>');
  const serve = previewIndex(dist);
  server = http.createServer((req, res) =>
    serve(req, res, () => {
      res.statusCode = 404;
      res.end('sirv would answer this one');
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('the built page under `pnpm start`', () => {
  it('carries the configured title, whatever `pnpm build` baked in', async () => {
    configure({ repo: 'acme/widgets' });
    for (const p of ['/', '/index.html', '/board', '/sessions/issue-12-1a2b', '/settings/models?x=1']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toContain('<title>Sloth · widgets</title>');
    }
  });
  it('leaves files and the API to the middlewares behind it', async () => {
    for (const p of ['/assets/index-abc123.js', '/favicon.svg', '/api/overview']) expect((await fetch(`${base}${p}`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(404);
  });
  it('escapes the title, which comes from config', () => {
    expect(withTitle('<title>x</title>', 'a<b&"c"')).toBe('<title>a&lt;b&amp;&quot;c&quot;</title>');
  });
});
