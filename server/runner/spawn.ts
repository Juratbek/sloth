import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PLUGIN_DIR, cfg } from '../config';
import { moveCard } from './board';
import { run } from './gh';
import { isDry, log, remove, write } from './log';
import { stopPreview } from './preview';
import { APPEND_PROMPT, sessionEnv, type Target } from './session-env';
import { approvedDir, issueDir, reviewDir, slotsFull } from './session-dirs';
import { machineHold } from './machine';

/** Why nothing may start right now: every slot taken, or the machine too loaded to take one more run. */
const held = (): string | undefined => (slotsFull() ? 'slots full' : machineHold());

const trusted = new Set<string>();
/** Claude Code exits silently in an untrusted directory, so headless runs need the flag pre-set. */
export function ensureTrust(root: string): void {
  if (trusted.has(root)) return;
  trusted.add(root);
  const file = path.join(os.homedir(), '.claude.json');
  let data: { projects?: Record<string, Record<string, unknown>> } = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first run — start from an empty object */
  }
  const projects = (data.projects ??= {});
  if (projects[root]?.hasTrustDialogAccepted === true) return;
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.sloth-backup`);
  projects[root] = { ...(projects[root] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  log(`trusted ${root} for Claude Code`);
}

/**
 * Starts a detached `claude -p` run that survives a Sloth restart. `bookDir` holds Sloth's own pid /
 * session_id files; `sessionDir` is what the session itself works in (they differ only for a status
 * reply, which reads the issue's previous run directory but must not overwrite its pid). `model` is
 * the one configured for the agent (`models` in the config). `chrome` attaches the Claude in Chrome
 * extension — only implement sessions need a browser, and its tools cost context.
 */
interface StartOptions {
  model: string;
  chrome?: boolean;
}
function start(bookDir: string, sessionDir: string, prompt: string, target: Target, logFile: string, options: StartOptions): void {
  const c = cfg();
  const { model, chrome = false } = options;
  // A status reply borrows the issue's directory read-only — it must not conjure one that never ran.
  if (bookDir === sessionDir) fs.mkdirSync(path.join(sessionDir, 'inbox'), { recursive: true });
  fs.mkdirSync(bookDir, { recursive: true });
  fs.mkdirSync(c.worktreesDir, { recursive: true });
  ensureTrust(c.runnerRoot);
  const sessionId = randomUUID();
  write(path.join(bookDir, 'session_id'), sessionId);
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(
    'claude',
    ['-p', prompt, '--plugin-dir', PLUGIN_DIR, '--session-id', sessionId, '--model', model,
      chrome ? '--chrome' : '--no-chrome', '--dangerously-skip-permissions', '--append-system-prompt', APPEND_PROMPT],
    { cwd: c.runnerRoot, detached: true, stdio: ['ignore', fd, fd], env: sessionEnv(sessionDir, target, model, chrome) },
  );
  fs.closeSync(fd);
  if (child.pid) write(path.join(bookDir, 'pid'), String(child.pid));
  child.unref();
}

/** Trigger 1 / 2 / 3: implement an issue. A fresh run clears the previous run's state and inbox. */
export async function launch(issue: number, order?: string): Promise<boolean> {
  const dir = issueDir(issue);
  const why = held();
  if (why) {
    log(`#${issue} queued (${why})`);
    return false;
  }
  if (isDry()) {
    log(`dry-run: would launch #${issue}${order ? ` (${order.slice(0, 120)})` : ''}`);
    return true;
  }
  // One environment per issue: a preview of the previous run makes way for the new one.
  await stopPreview(issue, 'a new session starts on the issue');
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  remove(path.join(dir, 'state.json'));
  remove(path.join(dir, 'blocked'));
  for (const f of fs.readdirSync(path.join(dir, 'inbox'))) remove(path.join(dir, 'inbox', f));
  await moveCard(issue, cfg().statusField.columns.inProgress.id);
  await run('git', ['-C', cfg().runnerRoot, 'fetch', '-q', 'origin'], 120_000);
  const { models, orchestrator, chrome } = cfg();
  // An orchestrator session runs on its own model and hands the coding to an implementor subagent on `models.implement`.
  const model = orchestrator ? models.orchestrator : models.implement;
  log(`launch #${issue} on ${model}${orchestrator ? ` (orchestrator, implementor on ${models.implement})` : ''}${order ? ` (${order.slice(0, 120)})` : ''}`);
  start(dir, dir, `/sloth:implement ${issue}${order ? ` ${order}` : ''}`, { issue }, path.join(dir, 'run.log'), { model, chrome });
  return true;
}

/** Trigger 4: review one PR version. */
export function launchReview(pr: number, issue: number): boolean {
  const dir = reviewDir(pr);
  const why = held();
  if (why) {
    log(`review PR #${pr} queued (${why})`);
    return false;
  }
  if (isDry()) {
    log(`dry-run: would review PR #${pr} (issue #${issue})`);
    return true;
  }
  const model = cfg().models.review;
  log(`review PR #${pr} (issue #${issue}) on ${model}`);
  // The directory is named after the PR; the issue it belongs to is only known here, and the monitor
  // needs it to roll this run's cost up under the issue.
  write(path.join(dir, 'issue'), String(issue));
  start(dir, dir, `/sloth:review ${pr}`, { pr, issue }, path.join(dir, 'run.log'), { model });
  return true;
}

/**
 * Trigger 5: the final review of one PR version — the same `/sloth:review`, on `models.final`, in
 * `final` mode: the verdict is always posted on the PR; a pass labels the wired issue `Fable: approved`,
 * a fail removes that label.
 */
export function launchApproved(pr: number, issue: number): boolean {
  const c = cfg();
  const why = held();
  if (why) {
    log(`final review PR #${pr} queued (${why})`);
    return false;
  }
  if (isDry()) {
    log(`dry-run: would run final review PR #${pr} (issue #${issue}) on ${c.models.final}`);
    return true;
  }
  log(`final review PR #${pr} (issue #${issue}) on ${c.models.final}`);
  write(path.join(approvedDir(pr), 'issue'), String(issue));
  start(approvedDir(pr), approvedDir(pr), `/sloth:review ${pr} final`, { pr, issue }, path.join(approvedDir(pr), 'run.log'), { model: c.models.final });
  return true;
}

/**
 * Trigger 3, no session running and no order: answer the question where it was asked — the issue, or
 * the PR wired to it (`pr`). The reply reads the issue's own session directory, so it can say what the
 * last run did.
 */
export function statusReply(issue: number, commentId: string, pr?: number): boolean {
  const on = pr ? `PR #${pr}` : `#${issue}`;
  if (isDry()) {
    log(`dry-run: would answer status comment ${commentId} on ${on}`);
    return true;
  }
  const bookDir = path.join(cfg().stateDir, 'status', `${issue}-${commentId}`);
  log(`#${issue} status reply for comment ${commentId} on ${on}`);
  start(bookDir, issueDir(issue), `/sloth:status ${issue} ${commentId}`, { issue, pr }, path.join(cfg().stateDir, 'status.log'), { model: cfg().models.status });
  return true;
}
