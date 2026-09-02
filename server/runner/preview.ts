import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { broadcast } from '../events';
import { which } from '../install';
import { TUNNEL_URL_RE } from '../remote';
import type { PreviewState } from '../types';
import { cleanup, serversUp } from './cleanup';
import { gh } from './gh';
import { isDry, log, nowSec, readFile, remove, write } from './log';
import { body, fileOf, linkOf, post, readPreviewFile, when } from './preview-link';
import { newKey, startProxy, type Proxy } from './preview-proxy';
import { dirAlive, issueDir, runDirs, stateOf } from './session-dirs';

/**
 * Previews. An implement session that hands its PR over leaves the app it tested running and writes
 * `preview.json` — `{url, login}`: the local address the app answers on and how to sign in. Once the
 * session has exited, Sloth puts a keyed guard (`preview-proxy.ts`) and a tunnel in front of that address,
 * posts the public link — key and all — on the PR and keeps the servers, database and worktree alive for
 * `previewHours`. Everything comes down at
 * expiry, when the PR closes, when the servers die, when a new session starts on the issue, or from
 * the monitor. A restart of Sloth re-opens each tunnel and rewrites the comment with the new link.
 */

const PR_CHECK_MS = 10 * 60_000; // how often one preview asks GitHub whether its PR is still open

interface Live {
  child: ChildProcess;
  url?: string;
  proxy?: Proxy;
  /** The comment carrying this address landed on the PR. Until it has, the preview is nobody's to open. */
  announced?: boolean;
}

const live = new Map<number, Live>();
const prChecked = new Map<number, number>();
const warned = new Set<string>();

const stateFile = (issue: number) => path.join(issueDir(issue), 'preview-state.json');
const prOf = (issue: number) => Number(/\/pull\/(\d+)/.exec(stateOf(issueDir(issue)).pr ?? '')?.[1]) || undefined;

/** The preview Sloth keeps for an issue, if any — what the monitor shows. */
export function previewState(issue: number): PreviewState | undefined {
  try {
    return JSON.parse(readFile(stateFile(issue)) ?? '') as PreviewState;
  } catch {
    return undefined;
  }
}

/** The link a person can open the issue's preview at right now, if the tunnel has printed one. */
export function previewLink(issue: number): string | undefined {
  const s = previewState(issue);
  return s?.url ? linkOf(s) : undefined;
}

/**
 * Puts the link on the PR and records the preview as up. A comment GitHub refused leaves both undone —
 * the address is not written to the state file and nothing is logged as up — because the alternative is
 * what used to happen: one transient `gh` failure and the PR carried no link at all for the whole of
 * `previewHours` while the log and the monitor said it was there. `previews` tries again every tick.
 */
async function announce(issue: number, url: string): Promise<void> {
  const s = previewState(issue);
  const p = readPreviewFile(issue);
  if (!s || !p) return;
  s.url = url;
  if (!(await post(issue, s, body(s, p)))) return;
  const entry = live.get(issue);
  if (entry?.url !== url) return; // stopped while the comment was on its way
  entry.announced = true;
  write(stateFile(issue), JSON.stringify(s));
  log(`preview #${issue} up at ${url} until ${when(s.expiresAt)}${s.pr ? ` (PR #${s.pr})` : ''}`);
  broadcast();
}

/**
 * The guard on a loopback port of its own, then one tunnel child pointed at *that* port — never at the
 * app itself, so nothing reaches the run without the key.
 */
async function openTunnel(issue: number, upstream: string, key: string): Promise<void> {
  const proxy = await startProxy(issue, upstream, key);
  if (!proxy) return;
  const [cmd, ...args] = cfg().tunnel.map((a) => a.replace('{port}', String(proxy.port)));
  const bin = which(cmd);
  if (!bin) {
    if (!warned.has(cmd)) log(`preview: ${cmd} is not installed — no links until it is`);
    warned.add(cmd);
    proxy.close();
    return;
  }
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const entry: Live = { child, proxy };
  live.set(issue, entry);
  const seen = (chunk: Buffer) => {
    const m = TUNNEL_URL_RE.exec(chunk.toString());
    if (!m || entry.url) return;
    entry.url = m[0];
    void announce(issue, m[0]);
  };
  child.stdout?.on('data', seen);
  child.stderr?.on('data', seen);
  child.on('error', (e) => log(`preview #${issue}: ${cmd} failed: ${e.message}`));
  child.on('exit', (code) => {
    if (live.get(issue) !== entry) return;
    live.delete(issue);
    proxy.close();
    log(`preview #${issue}: ${cmd} exited with ${code} — a new link comes with the next tick`);
  });
}

async function begin(issue: number): Promise<void> {
  const p = readPreviewFile(issue);
  if (!p) {
    remove(fileOf(issue));
    log(`preview #${issue}: preview.json needs {"url": "http://localhost:<port>"} — ignored`);
    return;
  }
  if (!cfg().previewHours) {
    log(`preview #${issue} skipped: previewHours is 0 — cleaning the run up`);
    await cleanup(issue);
    return;
  }
  if (isDry()) {
    log(`dry-run: would put a tunnel in front of ${p.url} for #${issue}`);
    return;
  }
  const now = nowSec();
  const s: PreviewState = { issue, pr: prOf(issue), key: newKey(), startedAt: now, expiresAt: now + cfg().previewHours * 3600 };
  write(stateFile(issue), JSON.stringify(s));
  await openTunnel(issue, p.url, s.key);
}

async function prClosed(issue: number, s: PreviewState): Promise<boolean> {
  if (!s.pr || Date.now() - (prChecked.get(issue) ?? 0) < PR_CHECK_MS) return false;
  prChecked.set(issue, Date.now());
  const r = await gh(['pr', 'view', String(s.pr), '--repo', cfg().repo, '--json', 'state', '--jq', '.state']);
  return r.ok && r.out !== 'OPEN';
}

/** Every tick: starts previews for runs that left one, re-opens tunnels after a restart, retires the stale ones. */
export async function previews(): Promise<void> {
  for (const { kind, target: issue, dir } of runDirs()) {
    if (kind !== 'issue') continue;
    const s = previewState(issue);
    if (!s && !fs.existsSync(fileOf(issue))) continue;
    if (dirAlive(dir)) continue; // the session is still writing its report
    if (!s) await begin(issue);
    else if (nowSec() >= s.expiresAt) await stopPreview(issue, 'expired');
    else if (!serversUp(issue)) await stopPreview(issue, 'its servers are gone');
    else if (await prClosed(issue, s)) await stopPreview(issue, `PR #${s.pr} is closed`);
    else if (!live.has(issue)) {
      const upstream = readPreviewFile(issue)?.url;
      if (!upstream) await stopPreview(issue, 'its preview.json is gone');
      else {
        // The key outlives the tunnel, so the link a restart re-announces is the one already posted.
        if (!s.key) write(stateFile(issue), JSON.stringify({ ...s, key: (s.key = newKey()) }));
        await openTunnel(issue, upstream, s.key);
      }
    } else {
      // The tunnel has an address but the comment carrying it did not land: tried again here, every
      // tick, until it does. A preview nobody was told about is a preview nobody has.
      const entry = live.get(issue)!;
      if (entry.url && !entry.announced) await announce(issue, entry.url);
    }
  }
}

/** Takes one preview down: tunnel, comment, then the run's processes, database and worktree. */
export async function stopPreview(issue: number, reason: string): Promise<void> {
  const entry = live.get(issue);
  live.delete(issue);
  prChecked.delete(issue);
  entry?.child.kill();
  entry?.proxy?.close();
  const s = previewState(issue);
  if (!s && !fs.existsSync(fileOf(issue))) return;
  if (s?.commentId) await post(issue, s, `${cfg().botPrefix} The preview of this PR is gone (${reason}).`);
  remove(stateFile(issue));
  await cleanup(issue);
  log(`preview #${issue} stopped: ${reason}`);
  broadcast();
}

/** Server shutdown: the tunnels die with the process; the state files stay, so the next start re-opens them. */
export function closeTunnels(): void {
  for (const { child, proxy } of live.values()) {
    child.kill();
    proxy?.close();
  }
  live.clear();
}
