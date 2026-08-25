import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SESSIONS_DIR, STATE_DIR, TRANSCRIPTS_DIR, WATCHER_LOG } from './config';

// One SSE stream: "change" whenever any watched file changes (debounced).
const clients = new Set<ServerResponse>();
let timer: NodeJS.Timeout | undefined;

export function broadcast() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const c of clients) c.write('data: change\n\n');
  }, 800);
}

export function watchAll() {
  const targets: [string, fs.WatchOptions][] = [
    [TRANSCRIPTS_DIR, { recursive: true }],
    [SESSIONS_DIR, { recursive: true }],
    [STATE_DIR, { recursive: true }],
    [WATCHER_LOG, {}],
  ];
  for (const [target, opts] of targets) {
    try {
      fs.watch(target, opts, broadcast).on('error', () => undefined);
    } catch {
      /* not there yet — the client also polls */
    }
  }
}

export function sse(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write('data: hello\n\n');
  clients.add(res);
  const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(beat);
    clients.delete(res);
  });
}
