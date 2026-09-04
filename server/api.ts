import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { cfg } from './config';
import { broadcast, sse, watchAll } from './events';
import { serial, startLoop, stopLoop, tick } from './runner/loop';
import { isPaused, setPaused } from './runner/pause';
import { closeTunnels, stopPreview } from './runner/preview';
import { unblock } from './runner/blocked';
import { log } from './runner/log';
import { openSweep } from './runner/qa';
import { requestSmoke, smokeAlive } from './runner/smoke';
import { stop as stopRun } from './runner/run-control';
import { handleSettings, isSettings } from './api-settings';
import { previewIndex, withTitle } from './preview-index';
import { healthStatus, refreshHealth, startHealth } from './health';
import { guard, isLocal, sameOrigin, startTunnel, stopTunnel } from './remote';
import { agentDetail, overview, sessionDetail, watcherOf } from './sessions';
import { ensureSkipLabel } from './runner/markers';
import { ensureStack } from './stack';
import { usageSeries } from './usage';
import { hoursReport } from './hours';
import { ensureWebhook, startWebhook, webhookInfo } from './webhook';
import { webhookMiddleware } from './webhook-route';

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
      // The QA sweep now, whatever the clock says; the board tick that follows starts its sessions. The
      // opening goes on the tick chain (it writes the sweep's state, which a tick's `qaSweep` reads), the
      // tick after it — `serial` may not contain a `tick`, which would wait for the mutation to end.
      const sweep = await serial('sweep now', () => openSweep(true));
      if (sweep) await tick({ board: true });
      body = { ok: !!sweep, sweep };
    } else if (p === '/api/smoke/run' && req.method === 'POST') {
      // A smoke test now, whatever the schedule says. The request is written for the tick, and the board
      // tick that follows starts the run — or leaves the request standing when the slots or the machine are
      // full, for the tick that can. One at a time: with a run going, the request is dropped, not queued.
      const running = smokeAlive();
      if (!running) await serial('smoke now', () => requestSmoke());
      if (!running) await tick({ board: true });
      body = { ok: !running, running };
    } else if (unblockIssue && req.method === 'POST') {
      // Lifts a give-up. The card is only handed back to the sweep — the next one tests it, and "sweep
      // now" beside it makes that next one immediate.
      const issue = Number(unblockIssue[1]);
      const unblocked = await serial('unblock', () => unblock(issue, 'from the monitor'));
      broadcast();
      body = { ok: unblocked, issue };
    } else if ((p === '/api/pause' || p === '/api/resume') && req.method === 'POST') {
      // Pause / resume the launching triggers; running sessions and replies are untouched.
      setPaused(p === '/api/pause');
      broadcast();
      body = { ok: true, paused: isPaused() };
    } else if (preview && req.method === 'POST') {
      await serial('stop preview', () => stopPreview(Number(preview[1]), 'stopped from the monitor'));
      body = { ok: true };
    } else if (stopSession && req.method === 'POST') {
      // Ends the run behind a transcript; an issue's card is parked so it is not relaunched. Behind the
      // tick chain: a stop that lands mid-tick used to race that tick's `reap` over the same pid file —
      // both killing, both cleaning up, and the parking comment written twice.
      const w = watcherOf(stopSession[1]);
      if (w) {
        const stopped = await serial('stop session', () =>
          stopRun(w.kind, w.target, 'stopped from the monitor', 'the run for this issue was stopped from the monitor.'),
        );
        broadcast();
        body = { ok: true, stopped };
      }
    } else if (p === '/api/webhook/retry' && req.method === 'POST') {
      // Configures the repository's hook again, now: the address has changed, the token was fixed, the
      // hook was deleted by hand. Not on the tick chain — it touches no session state, and a button that
      // waits out a five-minute tick reads as a broken one.
      await ensureWebhook();
      body = webhookInfo();
    } else if (p === '/api/webhook') {
      // What the settings page shows: the hook's state, why it is not delivering, and which of the two
      // comment polls that puts in force.
      body = webhookInfo();
    } else if (p === '/api/health/check' && req.method === 'POST') {
      // Whatever the ten-minute interval says: someone has just fixed something and wants to see it.
      body = await refreshHealth();
    } else if (p === '/api/health') {
      // The cache alone — asking is the POST's job. Nothing checked yet reads as an empty list, which is
      // what the header shows nothing for; a `undefined` here would be a 404 on every fresh start.
      body = healthStatus() ?? { at: 0, checks: [] };
    } else if (p === '/api/overview') body = await overview();
    // Clamped at both ends: an unclamped minimum let `?days=-5` ask for a window whose start is after
    // its end, and a large negative one threw `RangeError` out of `new Date(...).toISOString()` as a 500.
    // The fallback sits inside the clamp: outside it, an absent `days` read as 0, was clamped to 1 and
    // never reached the 7.
    else if (p === '/api/usage') body = usageSeries(Math.min(31, Math.max(1, Math.floor(Number(url.searchParams.get('days'))) || 7)));
    // One month of the hours ledger — `?month=YYYY-MM`, this month when absent or malformed.
    else if (p === '/api/hours') body = await hoursReport(url.searchParams.get('month'));
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

let guarded = false;
/**
 * The last net under everything. Sloth is one long-lived process: the watcher, the timers, the tunnels
 * and the preview guards all live in it, and Node's default answer to a promise nobody caught is to end
 * that process — so a stray rejection in a corner nothing depends on used to stop the board being watched
 * at all, silently, with the reason on a stdout nobody was reading. Every path that can be caught is
 * caught where it happens; this only makes sure the ones that were missed cost a line in `watcher.log`
 * instead of the night's work. Installed once, when the API mounts (the preview server mounts it again).
 */
function guardProcess(): void {
  if (guarded) return;
  guarded = true;
  process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${(reason instanceof Error ? reason.stack || reason.message : String(reason)).split('\n')[0]}`));
}

/** Vite plugin: serves the read-only monitor API from the same process as the UI (dev and preview). */
export function monitorApi(): Plugin {
  const mount = (server: ViteDevServer | PreviewServer) => {
    guardProcess();
    watchAll();
    // The watcher is this process: it starts with the server and stops when the server stops.
    startLoop();
    // Whatever the project's stack still lacks on this machine gets installed, so sessions can boot the app.
    void ensureStack();
    // The skip label people hold cards back with has to exist in the repo before anyone can apply it.
    void ensureSkipLabel();
    // Can this machine do the work at all? Asked once here and every ten minutes from the board tick.
    startHealth();
    // The repository's webhook, pointed at this Sloth as soon as it has an address to be pointed at.
    startWebhook();
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
    // Ahead of the guard, and only this one route: GitHub's deliveries carry no cookie and no sign-in
    // code, and are authenticated by the signature over their body instead (`webhook-route.ts`).
    server.middlewares.use(webhookMiddleware);
    server.middlewares.use(guard);
    server.middlewares.use(apiMiddleware);
  };
  return {
    name: 'sloth-api',
    transformIndexHtml: (html) => withTitle(html, cfg().title),
    configureServer: mount,
    // The preview server transforms no HTML: the built page is served here with today's title instead.
    configurePreviewServer: (server) => {
      server.middlewares.use(previewIndex(path.resolve(server.config.root, server.config.build.outDir)));
      mount(server);
    },
  };
}
