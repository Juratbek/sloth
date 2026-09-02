import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg } from './config';

// One SSE stream: "change" whenever any watched file changes (debounced).
const clients = new Set<ServerResponse>();
let timer: NodeJS.Timeout | undefined;
let watchers: fs.FSWatcher[] = [];

/**
 * One line to one listener. Writing to a socket the browser has already dropped throws — and this is
 * reached from a timer and from the debounce below, where nobody is holding a `try`: the throw would
 * escape as an uncaught exception and take the process, the watcher and every tunnel with it. A client
 * that will not take a write is simply not a client any more.
 */
function push(client: ServerResponse, chunk: string): boolean {
  if (!clients.has(client)) return false;
  try {
    if (client.writableEnded || client.destroyed) throw new Error('closed');
    client.write(chunk);
    return true;
  } catch {
    clients.delete(client);
    return false;
  }
}

export function broadcast() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    // A copy: `push` drops the dead ones as it goes.
    for (const c of [...clients]) push(c, 'data: change\n\n');
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
  clients.add(res);
  function drop(): void {
    clearInterval(beat);
    clients.delete(res);
  }
  // The heartbeat is what usually *finds* a gone client — a phone that went to sleep, a laptop lid. It
  // drops it here rather than leaving a timer writing to a dead socket every 25 seconds for ever.
  const beat = setInterval(() => push(res, ': ping\n\n') || drop(), 25_000);
  // `close` on either half: a response destroyed by the server itself (an update restart, a failed
  // handler) never reaches the request's.
  req.on('close', drop);
  res.on('close', drop);
  res.on('error', drop);
  push(res, 'data: hello\n\n');
}
