import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { cfg } from './config';
import { broadcast, sse, watchAll } from './events';
import { startLoop, stopLoop, tick } from './runner/loop';
import { isPaused, setPaused } from './runner/pause';
import { closeTunnels, stopPreview } from './runner/preview';
import { unblock } from './runner/blocked';
import { openSweep } from './runner/qa';
import { stop as stopRun } from './runner/triggers';
import { handleSettings, isSettings } from './api-settings';
import { guard, isLocal, sameOrigin, startTunnel, stopTunnel } from './remote';
import { agentDetail, overview, sessionDetail, watcherOf } from './sessions';
import { ensureSkipLabel } from './runner/markers';
import { ensureStack } from './stack';
import { usageSeries } from './usage';

/**
 * Answers a handler that threw. Nothing can be said once the response has begun — an SSE stream, a body
 * half written — so the socket is dropped instead. Either way the process survives: an unhandled rejection
 * out of the middleware ends Node, and with it the watcher, the tunnels and the board loop.
 */
function fail(res: ServerResponse, e: unknown): boolean {
  if (res.writableEnded) return true;
  if (res.headersSent) {
    res.destroy();
    return true;
  }
  res.statusCode = 500;
  res.end(String(e));
  return true;
}

/** Escapes text bound for HTML — the page title comes from config and must not be able to inject markup. */
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  if (!p.startsWith('/api/')) return false;
  if (p === '/api/events') {
    sse(req, res);
    return true;
  }
  let body: unknown;
  const mutating = (req.method ?? 'GET') !== 'GET';
  // The settings endpoints (`api-settings.ts`) are exactly the sensitive ones.
  const sensitive = isSettings(p);
  // CSRF guard: a cross-site page (even one open on the machine itself) must not be able to drive a
  // POST or reach the sensitive endpoints. `sameOrigin` fails closed on a cross-site fetch.
  if ((mutating || sensitive) && !sameOrigin(req)) {
    res.statusCode = 403;
    res.end('cross-site request blocked');
    return true;
  }
  // Reconfiguring (the wizard) and the QR's link stay on the machine Sloth runs on: a phone that holds
  // the cookie may read and tick, never rewrite the config — that would be code execution here.
  if (sensitive && !isLocal(req)) {
    res.statusCode = 403;
    res.end('only from the machine Sloth runs on');
    return true;
  }
  // Awaited inside the `try`, not returned from outside it: `readBody` rejects on an oversized body and
  // on a client that hangs up mid-POST, and a rejection nothing catches would take the whole process with it.
  try {
    if (sensitive) return await handleSettings(p, url, req, res);
    const session = /^\/api\/sessions\/([\w-]+)$/.exec(p);
    const agent = /^\/api\/sessions\/([\w-]+)\/agents\/(\w+)$/.exec(p);
    const preview = /^\/api\/previews\/(\d+)\/stop$/.exec(p);
    const stopSession = /^\/api\/sessions\/([\w-]+)\/stop$/.exec(p);
    const unblockIssue = /^\/api\/issues\/(\d+)\/unblock$/.exec(p);
    if (p === '/api/tick' && req.method === 'POST') {
      const dryRun = url.searchParams.get('dry') === '1';
      await tick({ board: true, comments: true, dryRun });
      body = { ok: true, dryRun };
    } else if (p === '/api/qa/run' && req.method === 'POST') {
      // The QA sweep now, whatever the clock says; the board tick that follows starts its sessions.
      const sweep = await openSweep(true);
      if (sweep) await tick({ board: true });
      body = { ok: !!sweep, sweep };
    } else if (unblockIssue && req.method === 'POST') {
      // Lifts a give-up. The card is only handed back to the sweep — the next one tests it, and "sweep
      // now" beside it makes that next one immediate.
      const issue = Number(unblockIssue[1]);
      const unblocked = unblock(issue, 'from the monitor');
      broadcast();
      body = { ok: unblocked, issue };
    } else if ((p === '/api/pause' || p === '/api/resume') && req.method === 'POST') {
      // Pause / resume the launching triggers; running sessions and replies are untouched.
      setPaused(p === '/api/pause');
      broadcast();
      body = { ok: true, paused: isPaused() };
    } else if (preview && req.method === 'POST') {
      await stopPreview(Number(preview[1]), 'stopped from the monitor');
      body = { ok: true };
    } else if (stopSession && req.method === 'POST') {
      // Ends the run behind a transcript; an issue's card is parked so it is not relaunched.
      const w = watcherOf(stopSession[1]);
      if (w) {
        const stopped = await stopRun(w.kind, w.target, 'stopped from the monitor', 'the run for this issue was stopped from the monitor.');
        broadcast();
        body = { ok: true, stopped };
      }
    } else if (p === '/api/overview') body = await overview();
    // Clamped at both ends: an unclamped minimum let `?days=-5` ask for a window whose start is after
    // its end, and a large negative one threw `RangeError` out of `new Date(...).toISOString()` as a 500.
    else if (p === '/api/usage') body = usageSeries(Math.min(31, Math.max(1, Math.floor(Number(url.searchParams.get('days'))) || 7)));
    else if (session) body = sessionDetail(session[1]);
    else if (agent) body = agentDetail(agent[1], agent[2]);
    if (body === undefined) {
      res.statusCode = 404;
      res.end('not found');
      return true;
    }
  } catch (e) {
    return fail(res, e);
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
  return true;
}

/**
 * The monitor API as one connect middleware. A request the API does not own falls through to `next`;
 * one whose handler throws or rejects answers 500 here rather than going unhandled, which would end
 * the process and take the watcher, the tunnels and the board loop with it.
 */
export function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  void handle(req, res)
    .then((handled) => handled || next())
    .catch((e) => fail(res, e));
}

/** Vite plugin: serves the read-only monitor API from the same process as the UI (dev and preview). */
export function monitorApi(): Plugin {
  const mount = (server: ViteDevServer | PreviewServer) => {
    watchAll();
    // The watcher is this process: it starts with the server and stops when the server stops.
    startLoop();
    // Whatever the project's stack still lacks on this machine gets installed, so sessions can boot the app.
    void ensureStack();
    // The skip label people hold cards back with has to exist in the repo before anyone can apply it.
    void ensureSkipLabel();
    const http = server.httpServer;
    // The tunnel needs the port actually bound — Vite moves to the next one when the configured port is taken.
    const tunnel = () => {
      const address = http?.address();
      startTunnel(typeof address === 'object' && address ? address.port : cfg().port);
    };
    if (http?.listening) tunnel();
    else http?.once('listening', tunnel);
    const stop = () => {
      stopLoop();
      stopTunnel();
      closeTunnels();
    };
    http?.on('close', stop);
    process.once('exit', stop);
    server.middlewares.use(guard);
    server.middlewares.use(apiMiddleware);
  };
  return {
    name: 'sloth-api',
    transformIndexHtml: (html) => html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(cfg().title)}</title>`),
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
