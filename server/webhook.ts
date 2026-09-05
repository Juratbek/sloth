import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomic';
import { cfg } from './config';
import { onRemoteChange, remoteStatus } from './remote';
import { repoSlugs } from './repos';
import { isDry, log } from './runner/log';
import { HOOK_PATH, createHook, firstLine, listHooks, updateHook } from './webhook-gh';
import { TRELLO_HOOK_PATH, ensureTrelloHook } from './webhook-trello';
import type { WebhookInfo, WebhookStatus } from './machine-types';

/**
 * The repository webhook — trigger 3 heard the moment it happens rather than at the next poll. One hook
 * per repository Sloth works in, all pointed at the same address and signed with the same secret.
 *
 * Nobody is asked to set this up. Sloth already runs a tunnel so a phone can reach it, and the `gh`
 * token it works the board with may write the repository's hooks, so it points the hook at its own
 * address itself and repoints it whenever that address changes — a quick tunnel gets a new host on
 * every start, which is exactly the case a hand-configured webhook would silently stop delivering on.
 *
 * The polling never stops. A webhook is a promise from somebody else's machine: a delivery can be
 * dropped, the tunnel can be down while a comment is written, the hook can be deleted by a human. So
 * the comments tick stays on `commentSeconds` as the safety net while the hook is live, and drops to
 * the shorter `fallbackCommentSeconds` while it is not — the only thing the webhook buys is how long a
 * mention waits, and the fallback is what pays when it is not there.
 *
 * `isWebhookLive` is deliberately stricter than "we configured one once": the status is only live while
 * the address GitHub was given is still the address Sloth is reachable at. A tunnel that came back on a
 * new host leaves a hook that delivers into nowhere, and reading that as live would put the comments
 * poll on the slow interval precisely when nothing is arriving.
 */

/** 32 bytes, as hex — what GitHub signs every delivery with. */
const SECRET_RE = /^[a-f0-9]{64}$/;

const secretFile = () => path.join(cfg().stateDir, 'webhook-secret');
const statusFile = () => path.join(cfg().stateDir, 'webhook.json');

let status: WebhookStatus | undefined;
let wired = false;
const listeners = new Set<() => void>();

/** The last status, read back from disk once per process so a restart does not show "never configured". */
function load(): WebhookStatus {
  if (status) return status;
  try {
    const saved = JSON.parse(fs.readFileSync(statusFile(), 'utf8')) as WebhookStatus;
    if (saved && typeof saved.state === 'string') status = saved;
  } catch {
    /* nothing has been configured on this machine yet */
  }
  return (status ??= { state: 'off', reason: 'not configured yet' });
}

function persist(): void {
  try {
    writeAtomic(statusFile(), `${JSON.stringify(status, null, 2)}\n`);
  } catch {
    /* the status is a convenience for the page; losing it costs a retry, not a delivery */
  }
}

/** Where the outside world reaches this Sloth: the tunnel's address, or the one the config names. */
const publicBase = (): string => remoteStatus().url || cfg().publicUrl || '';
const onTrello = () => cfg().project.provider === 'trello';
/** The path the board's provider delivers to — GitHub's hook and Trello's are told apart by it. */
const hookPath = (): string => (onTrello() ? TRELLO_HOOK_PATH : HOOK_PATH);
/** The address the provider should be delivering to right now; empty when Sloth is not reachable at all. */
export const deliveryUrl = (): string => {
  const base = publicBase();
  return base ? `${base.replace(/\/+$/, '')}${hookPath()}` : '';
};

/**
 * Replaces what is known about the hook, keeping what the deliveries have recorded, and tells the
 * comments timer when the answer to "is it live" changed — the new interval applies at once, rather
 * than at the end of an interval that was chosen under the old answer.
 */
function settle(next: Pick<WebhookStatus, 'state'> & Partial<WebhookStatus>): WebhookStatus {
  const was = isWebhookLive();
  status = { ...load(), url: undefined, hookId: undefined, hookIds: undefined, reason: undefined, ...next, at: Date.now() };
  persist();
  if (isWebhookLive() !== was) for (const fn of listeners) fn();
  return status;
}

export const webhookStatus = (): WebhookStatus => ({ ...load() });

/** Configured, and pointing at the address Sloth is reachable at right now. */
export function isWebhookLive(): boolean {
  const s = load();
  return s.state === 'active' && !!s.url && s.url === deliveryUrl();
}

/** Told whenever that answer changes; `runner/loop.ts` re-arms the comments timer on it. */
export const onWebhookChange = (fn: () => void): void => {
  listeners.add(fn);
};

/** The secret as it stands, without minting one: a delivery signed against a secret we never had is nobody's. */
export function readSecret(): string | undefined {
  try {
    const s = fs.readFileSync(secretFile(), 'utf8').trim();
    if (SECRET_RE.test(s)) return s;
  } catch {
    /* not configured yet */
  }
  return undefined;
}

/** The shared secret, minted on first use. Owner-readable only — it is the one thing that authenticates a delivery. */
export function webhookSecret(): string {
  const saved = readSecret();
  if (saved) return saved;
  const fresh = crypto.randomBytes(32).toString('hex');
  writeAtomic(secretFile(), `${fresh}\n`, { mode: 0o600 });
  return fresh;
}

/**
 * Whether a delivery really came from GitHub. The comparison is constant-time and length-checked first:
 * `timingSafeEqual` throws on a length mismatch, and a forged header is a length nobody controls.
 */
export function verifySignature(body: Buffer, header: string | undefined): boolean {
  const key = readSecret();
  if (!key || !header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', key).update(body).digest('hex')}`;
  const given = Buffer.from(header);
  const mine = Buffer.from(expected);
  return given.length === mine.length && crypto.timingSafeEqual(given, mine);
}

export const recordPing = (): void => {
  status = { ...load(), lastPing: Date.now() };
  persist();
};
export const recordDelivery = (): void => {
  status = { ...load(), lastDelivery: Date.now(), rejected: 0 };
  persist();
};
/** A delivery that did not verify. Counted and shown, not acted on: the hook stays as it is, exactly as GitHub's route does. */
export const recordRejection = (): void => {
  const s = load();
  status = { ...s, rejected: (s.rejected ?? 0) + 1, lastRejected: Date.now() };
  persist();
};

/** A 404 on the hooks endpoint is what GitHub answers a token that may not see them — it does not say so. */
const explain = (reason: string): string =>
  /\b404\b/.test(reason) ? `${reason} — the gh token cannot see this repository's webhooks (it needs the repo scope, or fine-grained "Webhooks: write")` : reason;

/**
 * Points the repository's hook at this Sloth: one is created, or the one already delivering to
 * `/api/hooks/github` — whatever host it names — is repointed and given today's secret. Called at
 * boot, whenever the tunnel's address changes, and by the retry button.
 */
export async function ensureWebhook(): Promise<WebhookStatus> {
  if (!cfg().configured) return settle({ state: 'off', reason: 'Sloth is not configured yet' });
  const url = deliveryUrl();
  if (!url) return settle({ state: 'off', reason: 'no public URL (remote access is off or the tunnel is down)' });
  if (isDry()) {
    log(`dry-run: would point the ${onTrello() ? 'Trello board' : repoSlugs().join(', ')} webhook at ${url}`);
    return settle({ state: 'off', reason: 'dry run — the webhook is left alone' });
  }
  if (onTrello()) {
    try {
      const hookId = await ensureTrelloHook(cfg().project.id, url);
      log(`webhook: Trello board ${cfg().project.title} delivers card comments to ${url}`);
      return settle({ state: 'active', url, hookId });
    } catch (e) {
      const reason = firstLine(e instanceof Error ? e.message : String(e));
      log(`webhook: not configured — ${reason}`);
      return settle({ state: 'failed', reason });
    }
  }
  // Every repository gets its hook; the first that refuses is the reason, and the ones already pointed stay pointed.
  const secret = webhookSecret();
  const hookIds: Record<string, number> = {};
  for (const repo of repoSlugs()) {
    try {
      const mine = (await listHooks(repo)).find((h) => (h.config?.url ?? '').endsWith(HOOK_PATH));
      hookIds[repo] = mine ? mine.id : await createHook(repo, url, secret);
      if (mine) await updateHook(repo, mine.id, url, secret);
      log(`webhook: ${repo} ${mine ? 'repointed' : 'created'} — @sloth comments are delivered to ${url}`);
    } catch (e) {
      const reason = explain(firstLine(e instanceof Error ? e.message : String(e)));
      log(`webhook: ${repo} not configured — ${reason}`);
      return settle({ state: 'failed', reason: repoSlugs().length > 1 ? `${repo}: ${reason}` : reason, hookIds });
    }
  }
  const first = Object.values(hookIds)[0];
  return settle({ state: 'active', url, hookId: first, hookIds });
}

/** Marks the hook down without touching GitHub: the hook stays there, it just cannot reach us. */
const markDown = (reason: string): void => {
  if (load().state !== 'off') settle({ state: 'off', reason });
};

const ensure = (): void => {
  void ensureWebhook().catch((e) => log(`webhook: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`));
};

/**
 * Wires the hook to remote access, once per process: an address that appears configures it, an address
 * that goes marks it down — the hook is left on GitHub, inactive on our side, and the next address
 * repoints it. Deleting it instead would cost a token scope on every tunnel restart and lose the
 * settings page's record of what has been delivered.
 *
 * A `publicUrl` outlives the tunnel that stops beside it: it is where Sloth is reachable whether or not
 * a tunnel is running, so a tunnel going down there is not the hook going down.
 */
export function startWebhook(): void {
  if (!wired) {
    wired = true;
    onRemoteChange((remote) => {
      if (remote.url) ensure();
      else if (!cfg().publicUrl) markDown('the tunnel is down — nothing can reach Sloth');
    });
  }
  ensure();
}

/** Everything the settings page shows, including which of the two comment polls is in force. */
export function webhookInfo(): WebhookInfo {
  const s = load();
  const c = cfg();
  const live = isWebhookLive();
  return {
    ...s,
    // Configured, but at an address that has since changed: the page says so rather than showing "active".
    ...(s.state === 'active' && !live ? { reason: 'the public address changed since the webhook was configured — retry the setup' } : {}),
    live,
    commentSeconds: c.commentSeconds,
    fallbackCommentSeconds: c.fallbackCommentSeconds,
    effectiveCommentSeconds: live ? c.commentSeconds : c.fallbackCommentSeconds,
  };
}

/** Tests only: back to "never configured", without touching what is on disk. */
export function forgetWebhook(): void {
  status = undefined;
}
