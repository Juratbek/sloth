import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg } from './config';

// One SSE stream: "change" whenever any watched file changes (debounced).
const clients = new Set<ServerResponse>();
let timer: NodeJS.Timeout | undefined;
let watchers: fs.FSWatcher[] = [];

export function broadcast() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const c of clients) c.write('data: change\n\n');
  }, 800);
}

/** (Re)attaches the file watchers — called at startup and again whenever the config changes. */
export function watchAll() {
  for (const w of watchers) w.close();
  watchers = [];
  const { transcriptsDir, sessionsDir, stateDir, watcherLog } = cfg();
  const targets: [string, fs.WatchOptions][] = [
    [transcriptsDir, { recursive: true }],
    [sessionsDir, { recursive: true }],
    [stateDir, { recursive: true }],
    [watcherLog, {}],
  ];
  for (const [target, opts] of targets) {
    try {
      watchers.push(fs.watch(target, opts, broadcast).on('error', () => undefined));
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
