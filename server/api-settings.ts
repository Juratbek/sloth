import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg } from './config';
import { install } from './install';
import { modelChoices } from './models';
import { remoteLink, rotateToken, startTunnel } from './remote';
import { serviceStatus } from './service';
import { handleSetup } from './setup';
import { handleStack } from './stack';
import { check, update, versionInfo } from './update';

/**
 * The settings endpoints: the wizard, login-item service, remote access, the stack, Sloth's own update
 * and the model picker. Every one of them is sensitive — `api.ts` only dispatches here after its
 * same-origin and local-machine guards — so nothing below checks who is asking.
 */

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

const json = (res: ServerResponse, body: unknown) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
  return true;
};

/** Whether `p` is one of the settings endpoints — the paths `api.ts` holds behind its guards. */
export const isSettings = (p: string): boolean =>
  p.startsWith('/api/setup/') || p.startsWith('/api/remote') || p.startsWith('/api/update') || p.startsWith('/api/stack') || p === '/api/service' || p === '/api/models';

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

/** Answers a path `isSettings` claimed; `api.ts` has already established the request is local and same-origin. */
export async function handleSettings(p: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (p.startsWith('/api/setup/')) return setup(p, req, res);
  // Whether this machine starts Sloth at login; the toggle itself is a config key, saved with the rest.
  if (p === '/api/service') return json(res, serviceStatus());
  if (p.startsWith('/api/remote')) {
    if (p === '/api/remote/rotate' && req.method === 'POST') rotateToken();
    // Once the tool is there the tunnel starts on its own and the QR follows.
    else if (p === '/api/remote/install' && req.method === 'POST') install(cfg().tunnel[0], () => startTunnel());
    return json(res, remoteLink());
  }
  if (p.startsWith('/api/stack')) {
    // The project's stack on this machine; `?root=` asks about a checkout other than the configured one (the wizard, before saving).
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    return json(res, await handleStack(p, req.method ?? 'GET', url.searchParams.get('root') || undefined, body));
  }
  if (p.startsWith('/api/update')) {
    // Sloth's own version and update: fetch to see what is new, pull-install-build-restart to get it.
    if (p === '/api/update/check' && req.method === 'POST') await check();
    else if (p === '/api/update/run' && req.method === 'POST') update();
    return json(res, await versionInfo());
  }
  // /api/models — which models the settings picker may offer: a provider is only on if its key is in
  // the environment this Sloth runs in, which only the machine itself can be asked about.
  return json(res, modelChoices(process.env));
}
