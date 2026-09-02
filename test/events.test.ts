import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { broadcast, sse } from '../server/events';
import { configure } from './harness';

/**
 * The SSE stream. Writing to a socket the browser already dropped throws, and `broadcast` is reached
 * from a timer where nobody holds a `try`: the throw would escape as an uncaught exception and take the
 * process, the watcher and every tunnel with it. So the interesting behaviour is all about *not*
 * throwing — a client that will not take a write stops being a client.
 */

/** A request/response pair as `sse` uses them: two emitters and a `write` a test can make throw. */
function client() {
  const req = new EventEmitter();
  let broken = false;
  const write = vi.fn((_chunk: string) => {
    if (broken) throw new Error('EPIPE');
    return true;
  });
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, writeHead: vi.fn(), write });
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    raw: res,
    /** Every chunk `sse` and `broadcast` handed this client, including the one that threw. */
    chunks: () => write.mock.calls.map(([chunk]) => chunk),
    break: () => (broken = true),
  };
}

/** A `broadcast` and the 800 ms of debounce it waits out. */
const flush = () => vi.advanceTimersByTime(800);

const open = () => {
  const c = client();
  sse(c.req, c.res);
  return c;
};

beforeEach(() => {
  configure();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('sse', () => {
  it('opens the stream with the event-stream headers and a first line', () => {
    const c = open();
    expect(c.raw.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'text/event-stream' }));
    expect(c.chunks()).toEqual(['data: hello\n\n']);
  });

  it('unsubscribes on the request closing, so a later broadcast never reaches it', () => {
    const gone = open();
    const kept = open();
    gone.req.emit('close');
    broadcast();
    flush();
    expect(gone.chunks()).toEqual(['data: hello\n\n']);
    expect(kept.chunks()).toEqual(['data: hello\n\n', 'data: change\n\n']);
  });

  it('unsubscribes on the response closing too — one the server itself destroyed never reaches the request’s', () => {
    const gone = open();
    gone.raw.emit('close');
    broadcast();
    flush();
    expect(gone.chunks()).toEqual(['data: hello\n\n']);
  });

  it('drops a client whose socket is already finished rather than writing to it', () => {
    const c = client();
    c.raw.writableEnded = true;
    expect(() => sse(c.req, c.res)).not.toThrow();
    expect(c.chunks()).toEqual([]);
    broadcast();
    flush();
    expect(c.chunks()).toEqual([]);
  });

  it('drops a client the heartbeat cannot reach', () => {
    const c = open();
    c.break();
    expect(() => vi.advanceTimersByTime(25_000)).not.toThrow();
    expect(c.chunks()).toHaveLength(2); // hello, then the ping that threw
    vi.advanceTimersByTime(60_000);
    expect(c.chunks()).toHaveLength(2); // no client, no more pings
  });
});

describe('broadcast', () => {
  it('sends one change to every live client, debounced', () => {
    const a = open();
    const b = open();
    broadcast();
    broadcast();
    broadcast();
    flush();
    for (const c of [a, b]) expect(c.chunks()).toEqual(['data: hello\n\n', 'data: change\n\n']);
  });

  it('does not throw when a write throws, and drops that client for good', () => {
    const bad = open();
    const good = open();
    bad.break();
    broadcast();
    expect(() => flush()).not.toThrow();
    expect(bad.chunks()).toEqual(['data: hello\n\n', 'data: change\n\n']); // the second one threw
    expect(good.chunks()).toHaveLength(2);

    // Even a socket that would take a write again is gone: it stopped being a client when it threw.
    broadcast();
    flush();
    expect(bad.chunks()).toHaveLength(2);
    expect(good.chunks()).toHaveLength(3);
  });

  it('is a no-op with nobody listening', () => {
    broadcast();
    expect(() => flush()).not.toThrow();
  });
});
