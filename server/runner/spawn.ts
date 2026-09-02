import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PLUGIN_DIR, cfg } from '../config';
import { moveCard } from './board';
import { mcpConfig } from './browser';
import { runHeader } from './exits';
import { run } from './gh';
import { isDry, log, readFile, remove, write } from './log';
import { cleanup } from './cleanup';
import { stopPreview } from './preview';
import { APPEND_PROMPT, sessionEnv, type SessionExtras, type Target } from './session-env';
import { approvedDir, issueDir, qaDir, slotsFull, statusDir, triesOn } from './session-dirs';
import { machineHold } from './machine';
import { forgetPause } from './pressure';
import { leaseSlot } from './slots';
import { claimWarm, warmOf } from './warm';

/** Why nothing may start right now: every slot taken, or the machine too loaded to take one more run. */
const held = (): string | undefined => (slotsFull() ? 'slots full' : machineHold());
const noSlot = (what: string): false => (log(`${what} queued (no free worktree slot)`), false);

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
 * extension — only implement sessions need a browser, and its tools cost context. Exported for the
 * stack install session (`stack-session.ts`), which is no board run but starts `claude` the same way.
 */
interface StartOptions {
  model: string;
  chrome?: boolean;
  /** Extra environment on top of `sessionEnv` — the stack install session names what it has to install. */
  env?: NodeJS.ProcessEnv;
  extras?: SessionExtras; // the run's budget and the worktree slot it leased — a review has neither
}
export function start(bookDir: string, sessionDir: string, prompt: string, target: Target, logFile: string, options: StartOptions): void {
  const c = cfg();
  const { model, chrome = false, extras } = options;
  // A status reply borrows the issue's directory read-only — it must not conjure one that never ran.
  if (bookDir === sessionDir) fs.mkdirSync(path.join(sessionDir, 'inbox'), { recursive: true });
  fs.mkdirSync(bookDir, { recursive: true });
  fs.mkdirSync(c.worktreesDir, { recursive: true });
  ensureTrust(c.runnerRoot);
  const sessionId = randomUUID();
  write(path.join(bookDir, 'session_id'), sessionId);
  // No browser at all unless one was asked for and this machine has Chrome: the session then knows it has none.
  const mcp = chrome ? mcpConfig(bookDir, path.join(sessionDir, 'screenshots')) : undefined;
  // One header per run: the log keeps every attempt, and `lastRun` finds where the newest one begins.
  fs.appendFileSync(logFile, runHeader(model));
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(
    'claude',
    ['-p', prompt, '--plugin-dir', PLUGIN_DIR, '--session-id', sessionId, '--model', model,
      '--no-chrome', ...(mcp ? ['--mcp-config', mcp] : []),
      '--dangerously-skip-permissions', '--append-system-prompt', APPEND_PROMPT],
    { cwd: c.runnerRoot, detached: true, stdio: ['ignore', fd, fd], env: { ...sessionEnv(sessionDir, target, model, !!mcp, extras), ...options.env } },
  );
  fs.closeSync(fd);
  if (child.pid) write(path.join(bookDir, 'pid'), String(child.pid));
  // When this run began, in Sloth's hand. The session writes its own `state.json` and rewrites `since`
  // at every step; this it never touches, so the time budget has something it cannot move (`launchedAt`).
  write(path.join(bookDir, 'started'), String(Math.floor(Date.now() / 1000)));
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
  // One environment per issue: a preview of the previous run makes way for the new one, and a crashed
  // run's leftovers go too — stopPreview alone skips a run that never wrote preview.json.
  await stopPreview(issue, 'a new session starts on the issue');
  await cleanup(issue);
  const slot = await leaseSlot('issue', issue);
  if (!slot) return noSlot(`#${issue}`);
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  remove(path.join(dir, 'state.json'));
  remove(path.join(dir, 'blocked'));
  // `handoff.md` stays on purpose: it is the dead run's note to the run launched here, and a retry that
  // reads it continues where the last one stopped instead of re-deriving everything. A fresh start —
  // pickup, a QA fail — removes it before calling launch.
  forgetPause(dir);
  for (const f of fs.readdirSync(path.join(dir, 'inbox'))) remove(path.join(dir, 'inbox', f));
  await moveCard(issue, cfg().statusField.columns.inProgress.id);
  await run('git', ['-C', cfg().runnerRoot, 'fetch', '-q', 'origin'], 120_000);
  // The slot may hold a warm stack (`warm.ts`). "Same head" for an implement run means the branch the
  // stack last served has not moved on the remote — the fetch above just made that answerable; a branch
  // that was never pushed resolves to nothing and counts as new work, which only costs a reseed.
  let head: string | undefined;
  const w = warmOf(slot);
  if (w?.run === `issue-${issue}` && w.branch) {
    const r = await run('git', ['-C', cfg().runnerRoot, 'rev-parse', `origin/${w.branch}`], 30_000);
    if (r.ok) head = r.out.trim();
  }
  const warm = await claimWarm('issue', issue, slot, head);
  const { models, orchestrator, chrome } = cfg();
  // An orchestrator session runs on its own model and hands the coding to an implementor subagent on `models.implement`.
  const model = orchestrator ? models.orchestrator : models.implement;
  log(`launch #${issue} on ${model}${orchestrator ? ` (orchestrator, implementor on ${models.implement})` : ''}${order ? ` (${order.slice(0, 120)})` : ''}`);
  start(dir, dir, `/sloth:implement ${issue}${order ? ` ${order}` : ''}`, { issue }, path.join(dir, 'run.log'), { model, chrome, extras: { worktree: slot, warm: !!warm, warmSame: warm?.same } });
  return true;
}

/**
 * Trigger 4: the review of one PR version — `/sloth:review <pr> final` on `models.final`: the verdict is
 * always posted on the PR; a pass labels the wired issue `Fable: approved` and moves its card to Approved,
 * a fail removes that label and sends the card back to In Progress. The review is Sloth's first priority:
 * it is held by the machine alone, never by the session caps — a card in Code Review is work that is done
 * and waiting, and a short read-only look must not queue behind the hour-long sessions that build. It
 * still counts as a session, so those queue behind it instead.
 *
 * The head under review is written beside the run and a run that ended without a verdict counts against
 * `retries` — reset when the PR is pushed to, since a new head is a new review. `reap` clears the head's
 * marker so trigger 4 comes straight back; without a count that pair is a loop, and one PR was reviewed
 * seven times in a day on the same commit.
 */
export function launchApproved(pr: number, issue: number, sha: string): boolean {
  const c = cfg();
  const why = machineHold();
  if (why) {
    log(`review PR #${pr} queued (${why})`);
    return false;
  }
  if (isDry()) {
    log(`dry-run: would review PR #${pr} (issue #${issue}) on ${c.models.final}`);
    return true;
  }
  log(`review PR #${pr} (issue #${issue}) on ${c.models.final}`);
  const dir = approvedDir(pr);
  const retries = triesOn(dir, sha);
  write(path.join(dir, 'sha'), sha);
  write(path.join(dir, 'retries'), String(retries + 1));
  // The previous run's final state must not speak for this one: `reap` reads `working` as "died without
  // a verdict" and clears the head's marker, which a leftover `done` would mask.
  remove(path.join(approvedDir(pr), 'state.json'));
  // The directory is named after the PR; the issue it belongs to is only known here, and the monitor
  // needs it to roll this run's cost up under the issue.
  write(path.join(approvedDir(pr), 'issue'), String(issue));
  start(approvedDir(pr), approvedDir(pr), `/sloth:review ${pr} final`, { pr, issue }, path.join(approvedDir(pr), 'run.log'), { model: c.models.final });
  return true;
}

/**
 * Trigger 9: the QA sweep's test of one card — `/sloth:qa <issue>` on `models.qa`, in a worktree of the QA
 * branch at `sha`, with the sweep's own budget. Held like an implement run, by the slots and the machine.
 * The run's directory is `qa-<issue>`, apart from the issue's implement run: the two may exist at once and
 * neither may touch the other's servers or worktree. The head under test is written beside the run, so the
 * verdict can be tied to it, and a run that ended without a verdict counts against `retries` — reset when
 * the branch moves on, since a new head is a new test.
 */
export async function launchQa(issue: number, sha: string, branch: string): Promise<boolean> {
  const c = cfg();
  const dir = qaDir(issue);
  const why = held();
  if (why) {
    log(`QA #${issue} queued (${why})`);
    return false;
  }
  const where = `${branch} @ ${sha.slice(0, 7)}`;
  if (isDry()) {
    log(`dry-run: would launch QA #${issue} on ${c.models.qa} (${where})`);
    return true;
  }
  const slot = await leaseSlot('qa', issue);
  if (!slot) return noSlot(`QA #${issue}`);
  const retries = triesOn(dir, sha);
  for (const f of ['state.json', 'verdict', 'handled']) remove(path.join(dir, f));
  write(path.join(dir, 'sha'), sha);
  write(path.join(dir, 'retries'), String(retries + 1));
  await run('git', ['-C', c.runnerRoot, 'fetch', '-q', 'origin'], 120_000);
  // The head under test is known here, so a warm stack from an earlier test of this card on the same
  // head is reused untouched; the same stack on a moved branch still saves the boot, minus a reseed.
  const warm = await claimWarm('qa', issue, slot, sha);
  log(`launch QA #${issue} on ${c.models.qa} (${where})`);
  start(dir, dir, `/sloth:qa ${issue}`, { issue }, path.join(dir, 'run.log'), {
    model: c.models.qa,
    chrome: c.chrome,
    extras: { budgetMinutes: c.qa.budgetMinutes, worktree: slot, warm: !!warm, warmSame: warm?.same },
  });
  return true;
}

/**
 * Trigger 3, no session running and no order: answer the question where it was asked — the issue, or
 * the PR wired to it (`pr`). The reply reads the issue's own session directory, so it can say what the
 * last run did, and books its own pid under `state/status/` so it cannot overwrite that run's.
 *
 * Held like every other launch. A reply is short and read-only, but it is a `claude` process all the
 * same: three questions in one tick used to be three more of them however full the slots were and
 * however little memory was left — the one promise the README makes about a loaded machine is that
 * "nothing new starts either". False when it is held, so the comment is left unseen and answered on a
 * later tick instead of dropped.
 */
export function statusReply(issue: number, commentId: string, pr?: number): boolean {
  const on = pr ? `PR #${pr}` : `#${issue}`;
  const why = held();
  if (why) {
    log(`#${issue} status reply for comment ${commentId} queued (${why})`);
    return false;
  }
  if (isDry()) {
    log(`dry-run: would answer status comment ${commentId} on ${on}`);
    return true;
  }
  log(`#${issue} status reply for comment ${commentId} on ${on}`);
  start(statusDir(issue, commentId), issueDir(issue), `/sloth:status ${issue} ${commentId}`, { issue, pr }, path.join(cfg().stateDir, 'status.log'), { model: cfg().models.status });
  return true;
}
