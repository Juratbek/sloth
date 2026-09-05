import { describe, expect, it } from 'vitest';
import { logins, normalizeConfig } from '../server/config-file';
import { CONFIG_DEFAULTS, DEFAULT_MODELS } from '../server/config-types';
import { COLUMNS, baseConfig } from './harness';

describe('normalizeConfig', () => {
  it('fills every default a saved config leaves out', () => {
    const c = normalizeConfig(baseConfig());
    expect(c.maxActive).toBe(CONFIG_DEFAULTS.maxActive);
    expect(c.previewHours).toBe(24);
    expect(c.models).toEqual(DEFAULT_MODELS);
    expect(c.orchestrator).toBe(true);
    expect(c.chrome).toBe(true);
    // The e2e writer is an extra agent per card and needs a Playwright setup in the project: on only when asked.
    expect(c.e2e).toBe(false);
    expect(c.models.e2e).toBe('opus');
    expect(normalizeConfig(baseConfig({ e2e: true, models: { e2e: 'sonnet' } })).e2e).toBe(true);
    expect(normalizeConfig(baseConfig({ e2e: true, models: { e2e: 'sonnet' } })).models.e2e).toBe('sonnet');
    expect(normalizeConfig(baseConfig({ e2e: 'yes' })).e2e).toBe(false);
    // Auto-update is on unless the file says no: a Sloth left running must not fall behind its repository.
    expect(c.autoUpdate).toBe(true);
    expect(normalizeConfig(baseConfig({ autoUpdate: false })).autoUpdate).toBe(false);
    expect(c.tunnel).toEqual(CONFIG_DEFAULTS.tunnel);
    expect(c.helpLogins).toEqual([]);
  });
  it('keeps the stack to what Sloth can install, once each, and defaults to auto', () => {
    expect(normalizeConfig(baseConfig()).stack).toBe('auto');
    expect(normalizeConfig(baseConfig({ stack: ['Redis', 'postgresql', 'docker', 'redis'] })).stack).toEqual(['redis', 'postgresql']);
    expect(normalizeConfig(baseConfig({ stack: [] })).stack).toEqual([]);
    expect(normalizeConfig(baseConfig({ stack: 'everything' })).stack).toBe('auto');
  });
  it('rejects a repo that is not owner/repo and a missing project', () => {
    expect(() => normalizeConfig(baseConfig({ repo: 'not a repo' }))).toThrow(/owner\/repo/);
    expect(() => normalizeConfig(baseConfig({ project: undefined }))).toThrow(/project\.id/);
  });
  it('loads the legacy model / approvedModel / orderLogin keys', () => {
    const c = normalizeConfig(baseConfig({ roles: undefined, orderLogin: '@jurat', model: 'sonnet', approvedModel: 'fable' }));
    expect(c.roles).toEqual({ admin: 'jurat', developers: [], testers: [] });
    expect(c.models.implement).toBe('sonnet');
    expect(c.models.status).toBe('sonnet');
    expect(c.models.final).toBe('fable');
    expect(c.models.orchestrator).toBe('fable');
  });
  it('keeps the orchestrator toggle and its model', () => {
    const c = normalizeConfig(baseConfig({ orchestrator: true, models: { orchestrator: 'opus', implement: 'sonnet' } }));
    expect(c.orchestrator).toBe(true);
    expect(c.models.orchestrator).toBe('opus');
    expect(c.models.implement).toBe('sonnet');
    expect(normalizeConfig(baseConfig({ orchestrator: false })).orchestrator).toBe(false);
    expect(normalizeConfig(baseConfig({ orchestrator: 'yes' })).orchestrator).toBe(true);
  });
  it('gives every login one role: admin first, then developer', () => {
    const c = normalizeConfig(baseConfig({ roles: { admin: 'Alice', developers: 'alice, bob, Bob', testers: ['bob', 'carol'] } }));
    expect(c.roles).toEqual({ admin: 'Alice', developers: ['bob'], testers: ['carol'] });
  });
  it('treats an optional column saved blank as absent', () => {
    const c = normalizeConfig(baseConfig({ statusField: { id: 'f', columns: { ...COLUMNS, approved: { id: '', name: '' } } } }));
    expect(c.statusField.columns.approved).toEqual({ id: '', name: '' });
    expect(() => normalizeConfig(baseConfig({ statusField: { id: 'f', columns: { pickup: { id: 'a', name: 'A' } } } }))).toThrow(/inProgress/);
  });
  it('rejects a model with spaces and a webhook that is not a URL', () => {
    expect(() => normalizeConfig(baseConfig({ models: { final: 'opus 4' } }))).toThrow(/models\.final/);
    expect(() => normalizeConfig(baseConfig({ helpWebhook: 'hooks.slack.com/x' }))).toThrow(/helpWebhook/);
    expect(normalizeConfig(baseConfig({ publicUrl: 'https://sloth.example.com/' })).publicUrl).toBe('https://sloth.example.com');
  });
  it('falls back to the default tunnel when the configured one is nothing but blanks', () => {
    // The blanks are dropped, and a list with nothing left in it is no command line: every consumer
    // reads `[cmd, ...args]`, and `which(undefined)` threw out of the server's `listening` handler.
    expect(normalizeConfig(baseConfig({ tunnel: ['  ', ''] })).tunnel[0]).toBe('cloudflared');
    expect(normalizeConfig(baseConfig({ tunnel: [] })).tunnel[0]).toBe('cloudflared');
    expect(normalizeConfig(baseConfig({ tunnel: ['ngrok', ' ', 'http'] })).tunnel).toEqual(['ngrok', 'http']);
  });
  it('clamps numbers to their minimums', () => {
    const c = normalizeConfig(baseConfig({ boardSeconds: 5, maxRetries: 0, previewHours: -1 }));
    expect(c.boardSeconds).toBe(300);
    expect(c.maxRetries).toBe(0);
    expect(c.previewHours).toBe(24);
  });
});

describe('logins', () => {
  it('accepts lists and comma / space separated strings, dropping @ and duplicates', () => {
    expect(logins('@alice, bob  carol,alice')).toEqual(['alice', 'bob', 'carol']);
    expect(logins(['@x', '', 'y'])).toEqual(['x', 'y']);
    expect(logins(undefined)).toEqual([]);
  });
});
