import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { cfg } from './config';
import { broadcast } from './events';
import { installStatus, installable, which } from './install';
import { log } from './runner/log';
import type { RemoteLink, RemoteStatus } from './types';

/**
 * Remote access. Sloth runs a tunnel itself (or trusts `publicUrl`) and guards everything it serves
 * with one secret, carried by the QR code's link: requests from this machine pass, everything else
 * needs the cookie that `?token=` sets. Only this machine can read the link or mint a new one.
 */

const COOKIE = 'sloth_remote';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOOPBACK = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/;
const TOKEN = /^[a-f0-9]{48}$/;
/** A tunnel's address is the first bare `https://host` it prints — doc links carry a path and are skipped. */
const URL_RE = /https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?(?![\w./-])/i;
const FIRST_RETRY_MS = 5_000;

const tokenFile = () => path.join(cfg().stateDir, 'remote-token');

export function token(): string {
  try {
    const t = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (TOKEN.test(t)) return t;
  } catch {
    /* first use */
  }
  return rotateToken();
}

/** A fresh secret — every phone that scanned the old code is signed out. */
export function rotateToken(): string {
  const t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), `${t}\n`, { mode: 0o600 });
  return t;
}

const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** From this machine: loopback socket, a localhost Host header and none of the headers a tunnel adds. */
export function isLocal(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return LOCAL_HOSTS.has(host) && LOOPBACK.test(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for'];
}

function deny(res: ServerResponse) {
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;background:#09090b;color:#e4e4e7;padding:2rem">' +
      '<h1 style="font-size:1.2rem">Sloth</h1><p>This link is not valid. Open Sloth on the computer it runs on and scan the QR code in the header.</p>',
  );
}

/** Middleware in front of everything the server serves, API and UI alike. */
export function guard(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (isLocal(req)) {
    next();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://sloth');
  const secret = token();
  const offered = url.searchParams.get('token');
  if (offered !== null) {
    if (!same(offered, secret)) {
      deny(res);
      return;
    }
    // The link signs the browser in and drops the secret from the address bar.
    url.searchParams.delete('token');
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.writeHead(302, {
      'set-cookie': `${COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
      location: url.pathname + url.search,
    });
    res.end();
    return;
  }
  const cookie = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`).exec(req.headers.cookie ?? '')?.[1];
  if (cookie && same(cookie, secret)) next();
  else deny(res);
}

/* ---- the tunnel: one child process, restarted with backoff while the server is up ---- */

let child: ChildProcess | undefined;
let retry: NodeJS.Timeout | undefined;
let wanted = false;
let delay = FIRST_RETRY_MS;
let port = 0;
let status: RemoteStatus = {};

function fail(argv: string[], error: string) {
  if (status.error !== error) log(`remote: ${error}`);
  status = { error };
  broadcast();
  if (!wanted) return;
  clearTimeout(retry);
  retry = setTimeout(() => launch(argv), delay);
  delay = Math.min(delay * 2, 60_000);
}

function launch(argv: string[]) {
  const [cmd, ...args] = argv;
  const bin = which(cmd);
  if (!bin) {
    fail(argv, `${cmd} is not installed`);
    return;
  }
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  const seen = (chunk: Buffer) => {
    const m = URL_RE.exec(chunk.toString());
    if (!m || status.url) return;
    status = { url: m[0] };
    delay = FIRST_RETRY_MS;
    log(`remote: reachable at ${m[0]}`);
    broadcast();
  };
  proc.stdout?.on('data', seen);
  proc.stderr?.on('data', seen);
  proc.on('error', (e) => fail(argv, e.message));
  proc.on('exit', (code) => {
    if (child === proc) child = undefined;
    if (wanted && !status.error) fail(argv, `${cmd} exited with ${code}, retrying`);
  });
}

/** (Re)starts the tunnel for the port the UI listens on; the last port is reused when none is given. */
export function startTunnel(listening = port): void {
  stopTunnel();
  port = listening;
  const c = cfg();
  if (!c.configured || !port) return;
  wanted = true;
  if (c.publicUrl) {
    status = { url: c.publicUrl };
    return;
  }
  launch(c.tunnel.map((a) => a.replace('{port}', String(port))));
}

export function stopTunnel(): void {
  wanted = false;
  clearTimeout(retry);
  child?.kill();
  child = undefined;
  status = {};
  delay = FIRST_RETRY_MS;
}

export const remoteStatus = (): RemoteStatus => ({ ...status });

/** The QR's payload: the address with the secret, plus the tool's state. The API answers this to local callers only. */
export function remoteLink(): RemoteLink {
  const { publicUrl, tunnel } = cfg();
  const cmd = tunnel[0];
  return {
    ...status,
    link: status.url ? `${status.url}/?token=${token()}` : undefined,
    tool: publicUrl ? undefined : { command: cmd, installed: !!which(cmd), installable: installable(cmd) },
    install: installStatus(),
  };
}
