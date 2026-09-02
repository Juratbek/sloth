import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlockStack } from '../src/hooks/use-stack';

/**
 * The sudo password is the one secret that passes through the UI. It must reach the server and stop
 * there: a react-query mutation would keep it in `state.variables` in the `MutationCache` until it is
 * garbage-collected — five minutes on the defaults — where anything running on the page can read it
 * back, and `reset()` only detaches the observer. `unlockStack` is a plain POST for that reason.
 */
const PASSWORD = 'correct-horse-battery-staple';
const STATUS = { tools: [], install: { running: false } };

describe('unlockStack', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the password to the server and leaves it nowhere in the query client', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify(STATUS), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const client = new QueryClient();
    const status = await unlockStack(client, undefined, { password: PASSWORD, ids: ['postgresql'] });

    expect(status).toEqual(STATUS);
    expect(bodies[0]).toContain(PASSWORD);
    // The answer is cached under the stack's key, so the panel redraws without a fetch of its own.
    expect(client.getQueryData(['stack', ''])).toEqual(STATUS);
    const cached = JSON.stringify([
      client.getQueryCache().getAll().map((q) => q.state),
      client.getMutationCache().getAll().map((m) => m.state),
    ]);
    expect(cached).not.toContain(PASSWORD);
  });
});
