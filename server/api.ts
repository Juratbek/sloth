import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { cfg } from './config';
import { sse, watchAll } from './events';
import { startLoop, stopLoop, tick } from './runner/loop';
import { agentDetail, overview, sessionDetail } from './sessions';
import { handleSetup } from './setup';
import { usageSeries } from './usage';

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

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
  if (p.startsWith('/api/setup/')) return setup(p, req, res);
  try {
    const session = /^\/api\/sessions\/([\w-]+)$/.exec(p);
    const agent = /^\/api\/sessions\/([\w-]+)\/agents\/(\w+)$/.exec(p);
    if (p === '/api/tick' && req.method === 'POST') {
      const dryRun = url.searchParams.get('dry') === '1';
      await tick({ board: true, comments: true, dryRun });
      body = { ok: true, dryRun };
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
  const mount = (server: {
    middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void };
    httpServer?: { on: (event: 'close', fn: () => void) => void } | null;
  }) => {
    watchAll();
    // The watcher is this process: it starts with the server and stops when the server stops.
    startLoop();
    server.httpServer?.on('close', stopLoop);
    process.once('exit', stopLoop);
    server.middlewares.use((req, res, next) => {
      void handle(req, res).then((handled) => handled || next());
    });
  };
  return {
    name: 'sloth-api',
    transformIndexHtml: (html) => html.replace(/<title>[^<]*<\/title>/, `<title>${cfg().title}</title>`),
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
