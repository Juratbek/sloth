import crypto from 'node:crypto';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commentInterval } from '../server/runner/loop';
import { setDry } from '../server/runner/log';
import { startTunnel, stopTunnel } from '../server/remote';
import { ensureWebhook, forgetWebhook, isWebhookLive, startWebhook, verifySignature, webhookInfo, webhookSecret, webhookStatus } from '../server/webhook';
import { called, calls, fail, onCommand, resetGh } from './gh-mock';
import { configure, readLog, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/** The address every test below expects the hook to be pointed at. */
const URL_HERE = 'https://sloth.example/api/hooks/github';

const noHooks = () => onCommand(/^gh api repos\/acme\/widgets\/hooks$/, []);
const created = (id: number) => onCommand(/-X POST repos\/acme\/widgets\/hooks/, String(id));
const bodyOf = (pattern: RegExp) => JSON.parse(called(pattern)[0]?.stdin ?? '{}');

beforeEach(() => {
  configure({ publicUrl: 'https://sloth.example' });
  wipe();
  resetGh();
  setDry(false);
  forgetWebhook();
});

describe('ensureWebhook', () => {
  it('does nothing at all without a public address, and says why', async () => {
    configure({ publicUrl: '' });
    const status = await ensureWebhook();
    expect(status.state).toBe('off');
    expect(status.reason).toMatch(/no public URL/);
    // Not one call to GitHub: there is no address to give it.
    expect(calls).toEqual([]);
    expect(isWebhookLive()).toBe(false);
  });

  it('creates the hook when the repository has none of Sloth’s, with the secret off the argv', async () => {
    noHooks();
    created(42);
    const status = await ensureWebhook();
    expect(status).toMatchObject({ state: 'active', url: URL_HERE, hookId: 42 });
    const body = bodyOf(/-X POST/);
    expect(body.events).toEqual(['issue_comment']);
    expect(body.config).toMatchObject({ url: URL_HERE, content_type: 'json', secret: webhookSecret() });
    // The secret travels down stdin; anything in argv is readable in `ps` by everyone on this machine.
    expect(calls.every((c) => !c.line.includes(webhookSecret()))).toBe(true);
    expect(isWebhookLive()).toBe(true);
  });

  it('repoints the hook it already owns instead of adding a second one — the tunnel host changes', async () => {
    onCommand(/^gh api repos\/acme\/widgets\/hooks$/, [
      { id: 3, config: { url: 'https://hooks.example/some-other-service' } },
      { id: 7, config: { url: 'https://yesterdays-tunnel.example/api/hooks/github' } },
    ]);
    const status = await ensureWebhook();
    expect(status).toMatchObject({ state: 'active', url: URL_HERE, hookId: 7 });
    expect(called(/-X POST/)).toHaveLength(0);
    expect(called(/-X PATCH repos\/acme\/widgets\/hooks\/7/)).toHaveLength(1);
    expect(bodyOf(/-X PATCH/).config.url).toBe(URL_HERE);
  });

  it('fails with what gh said, and reads a 404 as the missing scope it is', async () => {
    onCommand(/^gh api repos\/acme\/widgets\/hooks$/, fail('gh: Not Found (HTTP 404)'));
    const status = await ensureWebhook();
    expect(status.state).toBe('failed');
    expect(status.reason).toMatch(/HTTP 404/);
    expect(status.reason).toMatch(/Webhooks: write/);
    expect(readLog().join('\n')).toMatch(/webhook: not configured/);
    expect(isWebhookLive()).toBe(false);
  });

  it('mutates nothing in a dry run', async () => {
    setDry(true);
    noHooks();
    created(42);
    const status = await ensureWebhook();
    expect(calls).toEqual([]);
    expect(status.state).toBe('off');
    expect(readLog().join('\n')).toMatch(/dry-run: would point the acme\/widgets webhook at/);
  });

  it('keeps the secret it minted, so a repoint does not sign out the deliveries in flight', async () => {
    noHooks();
    created(42);
    await ensureWebhook();
    const secret = webhookSecret();
    resetGh();
    onCommand(/^gh api repos\/acme\/widgets\/hooks$/, [{ id: 42, config: { url: URL_HERE } }]);
    await ensureWebhook();
    expect(webhookSecret()).toBe(secret);
    expect(fs.statSync(statePath('webhook-secret')).mode & 0o777).toBe(0o600);
  });
});

describe('the webhook and the tunnel', () => {
  it('configures the hook when an address appears, and marks it down when the last one goes', async () => {
    configure({ publicUrl: '' });
    noHooks();
    created(42);
    startWebhook();
    await vi.waitFor(() => expect(webhookStatus().reason).toMatch(/no public URL/));
    // The tunnel printed an address (here: the configured one, which `startTunnel` trusts as it is).
    configure({ publicUrl: 'https://sloth.example' });
    startTunnel(4400);
    await vi.waitFor(() => expect(isWebhookLive()).toBe(true));
    // A tunnel that drops with no `publicUrl` behind it: GitHub has nowhere to deliver to.
    configure({ publicUrl: '' });
    stopTunnel();
    expect(webhookStatus()).toMatchObject({ state: 'off', reason: expect.stringMatching(/tunnel is down/) });
    expect(isWebhookLive()).toBe(false);
  });
});

describe('a live webhook', () => {
  const sign = (body: string, secret = webhookSecret()) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

  it('takes a delivery signed with the secret, and nothing else', () => {
    const body = '{"action":"created"}';
    expect(verifySignature(Buffer.from(body), sign(body))).toBe(true);
    expect(verifySignature(Buffer.from(body), sign(`${body} `))).toBe(false);
    expect(verifySignature(Buffer.from(body), sign(body, 'f'.repeat(64)))).toBe(false);
    expect(verifySignature(Buffer.from(body), undefined)).toBe(false);
    // A header of another length must be answered, not thrown on: timingSafeEqual throws on a mismatch.
    expect(verifySignature(Buffer.from(body), 'sha256=deadbeef')).toBe(false);
  });

  it('rejects everything while no secret has ever been minted', () => {
    fs.rmSync(statePath('webhook-secret'), { force: true });
    expect(verifySignature(Buffer.from('{}'), 'sha256=00')).toBe(false);
  });

  it('puts the comments poll on commentSeconds, and on the fallback the moment the address moves', async () => {
    noHooks();
    created(42);
    await ensureWebhook();
    expect(commentInterval()).toBe(120);
    expect(webhookInfo()).toMatchObject({ live: true, effectiveCommentSeconds: 120 });
    // The tunnel came back on another host: the hook still exists and delivers into nowhere.
    configure({ publicUrl: 'https://a-new-tunnel.example' });
    expect(isWebhookLive()).toBe(false);
    expect(commentInterval()).toBe(30);
    expect(webhookInfo()).toMatchObject({ live: false, effectiveCommentSeconds: 30, reason: expect.stringMatching(/public address changed/) });
  });

  it('polls at the fallback while nothing is configured', () => {
    expect(commentInterval()).toBe(30);
    expect(webhookInfo().effectiveCommentSeconds).toBe(30);
  });
});
