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
import { dirAlive, issueDir, runDirs, stateOf } from './session-dirs';

/**
 * Previews. An implement session that hands its PR over leaves the app it tested running and writes
 * `preview.json` — `{url, login}`: the local address the app answers on and how to sign in. Once the
 * session has exited, Sloth puts a tunnel in front of that address, posts the public link on the PR
 * and keeps the servers, database and worktree alive for `previewHours`. Everything comes down at
 * expiry, when the PR closes, when the servers die, when a new session starts on the issue, or from
 * the monitor. A restart of Sloth re-opens each tunnel and rewrites the comment with the new link.
 */

const UPSTREAM = /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/?$/;
const PR_CHECK_MS = 10 * 60_000; // how often one preview asks GitHub whether its PR is still open
const MAX_LOGIN = 3000; // characters of the session's sign-in notes that make it into the comment

interface PreviewFile {
  url: string;
  login?: string;
}
interface Live {
  child: ChildProcess;
  url?: string;
}

const live = new Map<number, Live>();
const prChecked = new Map<number, number>();
const warned = new Set<string>();

const fileOf = (issue: number) => path.join(issueDir(issue), 'preview.json');
const stateFile = (issue: number) => path.join(issueDir(issue), 'preview-state.json');
const when = (sec: number) => `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
const prOf = (issue: number) => Number(/\/pull\/(\d+)/.exec(stateOf(issueDir(issue)).pr ?? '')?.[1]) || undefined;

function readPreviewFile(issue: number): PreviewFile | undefined {
  try {
    const p = JSON.parse(readFile(fileOf(issue)) ?? '') as Partial<PreviewFile>;
    if (typeof p.url !== 'string' || !UPSTREAM.test(p.url)) return undefined;
    return { url: p.url.replace(/\/$/, ''), login: typeof p.login === 'string' ? p.login.trim().slice(0, MAX_LOGIN) : undefined };
  } catch {
    return undefined;
  }
}

/** The preview Sloth keeps for an issue, if any — what the monitor shows. */
export function previewState(issue: number): PreviewState | undefined {
  try {
    return JSON.parse(readFile(stateFile(issue)) ?? '') as PreviewState;
  } catch {
    return undefined;
  }
}

function body(s: PreviewState, p: PreviewFile): string {
  const c = cfg();
  const lines = [
    `${c.botPrefix} Preview of this PR: ${s.url}`,
    '',
    `It is the app as the session left it — its own database, seeded, nothing shared — and stays up until ` +
      `**${when(s.expiresAt)}** (${c.previewHours} h). Later pushes to the branch are not picked up.`,
  ];
  if (p.login) lines.push('', p.login);
  return lines.join('\n');
}

/** Writes the preview comment on the PR (the issue when the run opened none), or edits the one already there. */
async function post(issue: number, s: PreviewState, text: string): Promise<void> {
  const repo = cfg().repo;
  const r = s.commentId
    ? await gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${s.commentId}`, '-f', `body=${text}`, '--jq', '.id'])
    : await gh(['api', `repos/${repo}/issues/${s.pr ?? issue}/comments`, '-f', `body=${text}`, '--jq', '.id']);
  if (!r.ok) {
    log(`preview #${issue}: comment failed: ${r.err.split('\n')[0]}`);
    return;
  }
  s.commentId = Number(r.out) || s.commentId;
}

async function announce(issue: number, url: string): Promise<void> {
  const s = previewState(issue);
  const p = readPreviewFile(issue);
  if (!s || !p) return;
  s.url = url;
  await post(issue, s, body(s, p));
  if (live.get(issue)?.url !== url) return; // stopped while the comment was on its way
  write(stateFile(issue), JSON.stringify(s));
  log(`preview #${issue} up at ${url} until ${when(s.expiresAt)}${s.pr ? ` (PR #${s.pr})` : ''}`);
  broadcast();
}

/** One tunnel child per preview, with the configured `tunnel` argv pointed at the session's port. */
function openTunnel(issue: number, upstream: string): void {
  const [cmd, ...args] = cfg().tunnel.map((a) => a.replace('{port}', new URL(upstream).port));
  const bin = which(cmd);
  if (!bin) {
    if (!warned.has(cmd)) log(`preview: ${cmd} is not installed — no links until it is`);
    warned.add(cmd);
    return;
  }
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const entry: Live = { child };
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
  const s: PreviewState = { issue, pr: prOf(issue), startedAt: now, expiresAt: now + cfg().previewHours * 3600 };
  write(stateFile(issue), JSON.stringify(s));
  openTunnel(issue, p.url);
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
      if (upstream) openTunnel(issue, upstream);
      else await stopPreview(issue, 'its preview.json is gone');
    }
  }
}

/** Takes one preview down: tunnel, comment, then the run's processes, database and worktree. */
export async function stopPreview(issue: number, reason: string): Promise<void> {
  const entry = live.get(issue);
  live.delete(issue);
  prChecked.delete(issue);
  entry?.child.kill();
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
  for (const { child } of live.values()) child.kill();
  live.clear();
}
