import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { cfg } from './config';
import { broadcast, sse, watchAll } from './events';
import { startLoop, stopLoop, tick } from './runner/loop';
import { isPaused, setPaused } from './runner/pause';
import { closeTunnels, stopPreview } from './runner/preview';
import { stop as stopRun } from './runner/triggers';
import { install } from './install';
import { guard, isLocal, remoteLink, rotateToken, sameOrigin, startTunnel, stopTunnel } from './remote';
import { agentDetail, overview, sessionDetail, watcherOf } from './sessions';
import { handleSetup } from './setup';
import { usageSeries } from './usage';

const MAX_BODY = 1 << 20; // 1 MiB — a config payload is a few KB; anything larger is rejected

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => reject(new Error('request body error')));
  });
}

/** Escapes text bound for HTML — the page title comes from config and must not be able to inject markup. */
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const json = (res: ServerResponse, body: unknown) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
  return true;
};

/** /api/setup/* — the get-started wizard. A rejected payload answers 400, a missing config 404. */
async function setup(p: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? 'GET';
  try {
    const body = await handleSetup(p, method, method === 'POST' ? await readBody(req) : undefined);
    if (body === undefined) {
      res.statusCode = 404;
      res.end('not found');
      return true;
    }
    return json(res, body);
  } catch (e) {
    res.statusCode = 400;
    return json(res, { error: e instanceof Error ? e.message : String(e) });
  }
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
  const sensitive = p.startsWith('/api/setup/') || p.startsWith('/api/remote');
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
  if (p.startsWith('/api/setup/')) return setup(p, req, res);
  if (p.startsWith('/api/remote')) {
    if (p === '/api/remote/rotate' && req.method === 'POST') rotateToken();
    // Once the tool is there the tunnel starts on its own and the QR follows.
    else if (p === '/api/remote/install' && req.method === 'POST') install(cfg().tunnel[0], () => startTunnel());
    return json(res, remoteLink());
  }
  try {
    const session = /^\/api\/sessions\/([\w-]+)$/.exec(p);
    const agent = /^\/api\/sessions\/([\w-]+)\/agents\/(\w+)$/.exec(p);
    const preview = /^\/api\/previews\/(\d+)\/stop$/.exec(p);
    const stopSession = /^\/api\/sessions\/([\w-]+)\/stop$/.exec(p);
    if (p === '/api/tick' && req.method === 'POST') {
      const dryRun = url.searchParams.get('dry') === '1';
      await tick({ board: true, comments: true, dryRun });
      body = { ok: true, dryRun };
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
    else if (p === '/api/usage') body = usageSeries(Math.min(31, Number(url.searchParams.get('days')) || 7));
    else if (session) body = sessionDetail(session[1]);
    else if (agent) body = agentDetail(agent[1], agent[2]);
    if (body === undefined) {
      res.statusCode = 404;
      res.end('not found');
      return true;
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
    return true;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
  return true;
}

/** Vite plugin: serves the read-only monitor API from the same process as the UI (dev and preview). */
export function monitorApi(): Plugin {
  const mount = (server: ViteDevServer | PreviewServer) => {
    watchAll();
    // The watcher is this process: it starts with the server and stops when the server stops.
    startLoop();
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
    server.middlewares.use((req, res, next) => {
      void handle(req, res).then((handled) => handled || next());
    });
  };
  return {
    name: 'sloth-api',
    transformIndexHtml: (html) => html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(cfg().title)}</title>`),
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
