import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { cfg } from './config';

/** Escapes text bound for HTML — the page title comes from config and must not be able to inject markup. */
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** The built page with the title the config gives it now — not the one `pnpm build` baked in. */
export const withTitle = (html: string, title: string) => html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);

/** A navigation: the page itself or one of the UI's paths (`/board`, `/sessions/<id>`), never a file. */
const isPage = (req: IncomingMessage): boolean => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = (req.url ?? '/').replace(/[?#].*$/, '');
  if (p.startsWith('/api/')) return false;
  return p === '/' || p === '/index.html' || !path.posix.basename(p).includes('.');
};

/**
 * Vite's preview server (`pnpm start`) applies no `transformIndexHtml`: the tab title was whatever the
 * config said at build time, and a wizard re-pointed at another repo kept the old repo's name until a
 * rebuild. This serves the built page itself, title rewritten, for every navigation — the same
 * answer `sirv` would give behind it, read from disk each time (the file is small and rarely asked for).
 */
export function previewIndex(outDir: string) {
  const file = path.join(outDir, 'index.html');
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!isPage(req)) return next();
    let html: string;
    try {
      html = fs.readFileSync(file, 'utf8');
    } catch {
      return next();
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.end(req.method === 'HEAD' ? undefined : withTitle(html, cfg().title));
  };
}
