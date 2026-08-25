import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PLUGIN_DIR, cfg } from '../config';
import { moveCard } from './board';
import { run } from './gh';
import { isDry, log, nowSec, remove, write } from './log';
import { issueDir, reviewDir, slotsFull } from './session-dirs';

const APPEND_PROMPT =
  'You run as a Sloth session; the SLOTH_* environment variables describe the board, the session directory and the time budget.';

/** cron / launchd-style bare PATHs miss homebrew; a Sloth started from a shell keeps its own. */
const PATH_EXTRA = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];

interface Target {
  issue?: number;
  pr?: number;
}

function sessionEnv(dir: string, target: Target): NodeJS.ProcessEnv {
  const c = cfg();
  const col = c.statusField.columns;
  const start = nowSec();
  return {
    ...process.env,
    PATH: [...new Set([...(process.env.PATH ?? '').split(':'), ...PATH_EXTRA])].filter(Boolean).join(':'),
    SLOTH_SESSION_DIR: dir,
    ...(target.issue ? { SLOTH_ISSUE: String(target.issue) } : {}),
    ...(target.pr ? { SLOTH_PR: String(target.pr) } : {}),
    SLOTH_REPO: c.repo,
    SLOTH_PROJECT_ID: c.project.id,
    SLOTH_PROJECT_NUMBER: String(c.project.number),
    SLOTH_PROJECT_OWNER: c.project.owner,
    SLOTH_STATUS_FIELD_ID: c.statusField.id,
    SLOTH_COL_PICKUP_ID: col.pickup.id,
    SLOTH_COL_PICKUP_NAME: col.pickup.name,
    SLOTH_COL_IN_PROGRESS_ID: col.inProgress.id,
    SLOTH_COL_IN_PROGRESS_NAME: col.inProgress.name,
    SLOTH_COL_NEEDS_HELP_ID: col.needsHelp.id,
    SLOTH_COL_NEEDS_HELP_NAME: col.needsHelp.name,
    SLOTH_COL_CODE_REVIEW_ID: col.codeReview.id,
    SLOTH_COL_CODE_REVIEW_NAME: col.codeReview.name,
    SLOTH_RUNNER_ROOT: c.runnerRoot,
    SLOTH_WORKTREES_DIR: c.worktreesDir,
    SLOTH_ORDER_LOGIN: c.orderLogin,
    SLOTH_MODEL: c.model,
    SLOTH_START: String(start),
    SLOTH_DEADLINE: String(start + c.budgetMinutes * 60),
    SLOTH_BUDGET_MIN: String(c.budgetMinutes),
    SLOTH_WAIT_HOURS: String(c.waitHours),
    SLOTH_REVIEW_ROUNDS: String(c.reviewRounds),
    SLOTH_BOT_PREFIX: c.botPrefix,
    SLOTH_MENTION: c.mention,
  };
}

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
 * reply, which reads the issue's previous run directory but must not overwrite its pid).
 */
function start(bookDir: string, sessionDir: string, prompt: string, target: Target, logFile: string): void {
  const c = cfg();
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
    ['-p', prompt, '--plugin-dir', PLUGIN_DIR, '--session-id', sessionId, '--model', c.model,
      '--dangerously-skip-permissions', '--append-system-prompt', APPEND_PROMPT],
    { cwd: c.runnerRoot, detached: true, stdio: ['ignore', fd, fd], env: sessionEnv(sessionDir, target) },
  );
  fs.closeSync(fd);
  if (child.pid) write(path.join(bookDir, 'pid'), String(child.pid));
  child.unref();
}

/** Trigger 1 / 2 / 3: implement an issue. A fresh run clears the previous run's state and inbox. */
export async function launch(issue: number, order?: string): Promise<boolean> {
  const dir = issueDir(issue);
  if (slotsFull()) {
    log(`#${issue} queued (slots full)`);
    return false;
  }
  if (isDry()) {
    log(`dry-run: would launch #${issue}${order ? ` (${order.slice(0, 120)})` : ''}`);
    return true;
  }
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  remove(path.join(dir, 'state.json'));
  remove(path.join(dir, 'blocked'));
  for (const f of fs.readdirSync(path.join(dir, 'inbox'))) remove(path.join(dir, 'inbox', f));
  await moveCard(issue, cfg().statusField.columns.inProgress.id);
  await run('git', ['-C', cfg().runnerRoot, 'fetch', '-q', 'origin'], 120_000);
  log(`launch #${issue}${order ? ` (${order.slice(0, 120)})` : ''}`);
  start(dir, dir, `/sloth:implement ${issue}${order ? ` ${order}` : ''}`, { issue }, path.join(dir, 'run.log'));
  return true;
}

/** Trigger 4: review one PR version. */
export function launchReview(pr: number, issue: number): boolean {
  const dir = reviewDir(pr);
  if (slotsFull()) {
    log(`review PR #${pr} queued (slots full)`);
    return false;
  }
  if (isDry()) {
    log(`dry-run: would review PR #${pr} (issue #${issue})`);
    return true;
  }
  log(`review PR #${pr} (issue #${issue})`);
  start(dir, dir, `/sloth:review ${pr}`, { pr, issue }, path.join(dir, 'run.log'));
  return true;
}

/**
 * Trigger 3, no session running and no order: answer the question on the issue. The reply reads the
 * issue's own session directory, so it can say what the last run did.
 */
export function statusReply(issue: number, commentId: string): boolean {
  if (isDry()) {
    log(`dry-run: would answer status comment ${commentId} on #${issue}`);
    return true;
  }
  const bookDir = path.join(cfg().stateDir, 'status', `${issue}-${commentId}`);
  log(`#${issue} status reply for comment ${commentId}`);
  start(bookDir, issueDir(issue), `/sloth:status ${issue} ${commentId}`, { issue }, path.join(cfg().stateDir, 'status.log'));
  return true;
}
