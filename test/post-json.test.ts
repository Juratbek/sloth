import { afterEach, describe, expect, it, vi } from 'vitest';
import { postJson } from '../src/lib/api';

/**
 * The monitor API does not always answer JSON: `not found`, `cross-site request blocked` and a handler's
 * `String(e)` are all plain text. Parsing those threw `SyntaxError: Unexpected token 'o'`, and that is
 * what the user was shown instead of the server saying what was wrong.
 */
const answers = (status: number, body: string, type = 'text/plain') =>
  vi.stubGlobal('fetch', async () => new Response(body, { status, headers: { 'content-type': type } }));

describe('postJson', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws a plain-text 404 as the server wrote it', async () => {
    answers(404, 'not found');
    await expect(postJson('/api/sessions/gone/stop', {})).rejects.toThrow('404 not found');
  });

  it('throws a plain-text 403 and a 500 the same way', async () => {
    answers(403, 'only from the machine Sloth runs on');
    await expect(postJson('/api/update/run', {})).rejects.toThrow('403 only from the machine Sloth runs on');
    answers(500, 'Error: ENOENT: no such file or directory');
    await expect(postJson('/api/tick', {})).rejects.toThrow('500 Error: ENOENT: no such file or directory');
  });

  it('still prefers a JSON { error } body over the status line', async () => {
    answers(400, JSON.stringify({ error: 'pick a status field' }), 'application/json');
    await expect(postJson('/api/setup/config', {})).rejects.toThrow('pick a status field');
  });

  it('returns the parsed body of a JSON success, and an empty one for no body at all', async () => {
    answers(200, JSON.stringify({ ok: true, paused: false }), 'application/json');
    await expect(postJson('/api/pause', {})).resolves.toEqual({ ok: true, paused: false });
    answers(200, '');
    await expect(postJson('/api/pause', {})).resolves.toEqual({});
  });

  it('says so rather than throwing a parse error when a success is not JSON', async () => {
    answers(200, '<!doctype html>');
    await expect(postJson('/api/pause', {})).rejects.toThrow(/answered 200 with something that is not JSON/);
  });
});
