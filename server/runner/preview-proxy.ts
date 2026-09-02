import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { log } from './log';

/**
 * The guard in front of a preview. The tunnel gives the app a public address, and an address is all a
 * link is: anyone who sees the PR comment — or guesses — reaches the run's database. So the tunnel now
 * points here instead of at the app, and this only forwards a request that carries the preview's key.
 * The link in the comment carries it once as `?sloth_key=…`; that visit trades it for a cookie and
 * redirects to the clean URL, so the key stays out of the address bar, out of `Referer` headers and out
 * of the app's own logs. Everything else — including the websockets a dev server needs — is proxied
 * unchanged: the app must not be able to tell it is behind anything.
 */

const COOKIE = 'sloth_preview';
const PARAM = 'sloth_key';

/** 24 random bytes: the whole security of a preview link, so nothing shorter. */
export const newKey = () => randomBytes(24).toString('hex');

export interface Proxy {
  port: number;
  close: () => void;
}

const DENIED = `<!doctype html><meta charset="utf-8"><title>Preview</title>
<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;color:#27272a">
<h1 style="font-size:1.25rem">This preview needs its link</h1>
<p>Open the preview link from the pull request comment — it carries the key that unlocks this environment.</p>
</body>`;

const hasKey = (req: IncomingMessage, key: string): boolean =>
  new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1] === key;

/** The request's own URL with the key taken out — where a visit with `?sloth_key=` is sent next. */
function withoutKey(url: string): string {
  const u = new URL(url, 'http://preview.invalid');
  u.searchParams.delete(PARAM);
  return `${u.pathname}${u.search}`;
}

function admit(req: IncomingMessage, res: ServerResponse, key: string): boolean {
  if (hasKey(req, key)) return true;
  const url = new URL(req.url ?? '/', 'http://preview.invalid');
  if (url.searchParams.get(PARAM) === key) {
    // Secure would make the cookie unusable over a plain-http tunnel; a proxy that says so is believed.
    const secure = req.headers['x-forwarded-proto'] === 'http' ? '' : '; Secure';
    res.writeHead(302, {
      'set-cookie': `${COOKIE}=${key}; Path=/; HttpOnly; SameSite=Lax${secure}`,
      location: withoutKey(req.url ?? '/'),
    });
    res.end();
    return false;
  }
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(DENIED);
  return false;
}

/**
 * The headers to send upstream. `Host` becomes the app's own address, not the tunnel's: a Vite dev server
 * (5.4.12 and up, and every Vite 6) refuses any Host outside `allowedHosts` with "Blocked request. This
 * host is not allowed." — which is why Sloth's own `vite.config.ts` sets `allowedHosts: true`, and a
 * session's project app gets no such treatment. The public name is passed on as `X-Forwarded-Host`, which
 * that check does not read, so an app that builds absolute links still knows where it is being seen from.
 */
const forwardHeaders = (req: IncomingMessage, upstream: URL) => ({
  ...req.headers,
  host: upstream.host,
  'x-forwarded-host': req.headers.host ?? '',
  'x-forwarded-for': req.socket.remoteAddress ?? '',
});

function forward(req: IncomingMessage, res: ServerResponse, upstream: URL): void {
  const proxied = http.request(
    {
      host: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers: forwardHeaders(req, upstream),
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  proxied.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('the preview app is not answering');
  });
  req.pipe(proxied);
}

/**
 * A websocket (Vite's HMR, a live reload) is the same handshake on a raw socket — replayed upstream with
 * only its `Host` rewritten, for the reason `forwardHeaders` gives: the dev server checks the handshake's
 * Host too, and an HMR socket it refuses leaves the page loaded but never updating.
 */
function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, upstream: URL, key: string): void {
  if (!hasKey(req, key)) {
    socket.destroy();
    return;
  }
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const [name, value] = [req.rawHeaders[i], req.rawHeaders[i + 1]];
    lines.push(name.toLowerCase() === 'host' ? `${name}: ${upstream.host}` : `${name}: ${value}`);
  }
  lines.push(`X-Forwarded-Host: ${req.headers.host ?? ''}`);
  const up = net.connect(Number(upstream.port), upstream.hostname, () => {
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

/**
 * Starts the guard on a loopback port of its own and resolves with it. The tunnel is pointed at this
 * port; `upstream` is the address the session's app answers on. Undefined when the port cannot be had.
 */
export function startProxy(issue: number, upstream: string, key: string): Promise<Proxy | undefined> {
  const target = new URL(upstream);
  const server = http.createServer((req, res) => {
    if (admit(req, res, key)) forward(req, res, target);
  });
  server.on('upgrade', (req, socket, head) => upgrade(req, socket, head, target, key));
  return new Promise((resolve) => {
    server.on('error', (e) => {
      log(`preview #${issue}: guard failed: ${e.message}`);
      resolve(undefined);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || !address) return resolve(undefined);
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}
