import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSetup } from '../server/setup';
import { credentialsFile, forgetTrelloCredentials, trelloCredentials, trelloInfo, trelloReady } from '../server/trello-credentials';
import { resetGh } from './gh-mock';
import { configure } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

let me: unknown = { id: 'm1', username: 'friend' };

beforeEach(() => {
  configure();
  resetGh();
  forgetTrelloCredentials();
  for (const k of ['SLOTH_TRELLO_KEY', 'SLOTH_TRELLO_TOKEN', 'SLOTH_TRELLO_SECRET']) delete process.env[k];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (me instanceof Error ? { ok: false, status: 401, text: async () => me!.toString() } : { ok: true, status: 200, json: async () => me })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Trello credentials', () => {
  it('start absent, are saved owner-readable by the setup endpoint once Trello accepts them, and are never echoed back', async () => {
    expect(trelloReady()).toBe(false);
    expect(await handleSetup('/api/setup/trello', 'GET', undefined)).toEqual({ configured: false, secret: false, source: 'none' });
    const saved = await handleSetup('/api/setup/trello', 'POST', { key: 'k1', token: 't1', secret: '' });
    expect(saved).toEqual({ configured: true, secret: false, source: 'file', username: 'friend' });
    expect(trelloCredentials()).toEqual({ key: 'k1', token: 't1', secret: '' });
    expect(fs.statSync(credentialsFile()).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await handleSetup('/api/setup/trello', 'GET', undefined))).not.toMatch(/k1|t1/);
  });
  it('keeps what was saved when new values are refused, and forgets on a blank key and token', async () => {
    await handleSetup('/api/setup/trello', 'POST', { key: 'k1', token: 't1', secret: 's1' });
    me = new Error('invalid token');
    const refused = (await handleSetup('/api/setup/trello', 'POST', { key: 'bad', token: 'bad', secret: '' })) as { error?: string };
    expect(refused.error).toMatch(/Trello did not accept them/);
    expect(trelloCredentials()).toEqual({ key: 'k1', token: 't1', secret: 's1' });
    me = { id: 'm1', username: 'friend' };
    expect((await handleSetup('/api/setup/trello', 'POST', { key: 'k1', token: '', secret: '' })) as { error?: string }).toMatchObject({ error: /both the API key and the token/ });
    expect(await handleSetup('/api/setup/trello', 'POST', { key: '', token: '', secret: '' })).toEqual({ configured: false, secret: false, source: 'none' });
    expect(fs.existsSync(credentialsFile())).toBe(false);
  });
  it('lets the environment win field by field', async () => {
    await handleSetup('/api/setup/trello', 'POST', { key: 'k1', token: 't1', secret: 's1' });
    process.env.SLOTH_TRELLO_SECRET = 'env-secret';
    expect(trelloCredentials()).toEqual({ key: 'k1', token: 't1', secret: 'env-secret' });
    expect(trelloInfo().source).toBe('file');
    process.env.SLOTH_TRELLO_KEY = 'env-key';
    process.env.SLOTH_TRELLO_TOKEN = 'env-token';
    expect(trelloCredentials().key).toBe('env-key');
    expect(trelloInfo()).toEqual({ configured: true, secret: true, source: 'env' });
  });
});
