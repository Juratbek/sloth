import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import type { StackId } from './config-types';
import { isDry, log, readFile, remove, write } from './runner/log';
import { pidAlive, pidOf } from './runner/session-dirs';
import { start } from './runner/spawn';
import { TOOLS } from './stack-detect';
import type { InstallStatus } from './types';

/**
 * The AI session that installs the stack — `/sloth:stack redis postgresql` on the machine Sloth runs
 * on. `runJob` (a fixed list of apt commands) is enough at boot, where nobody is watching; from the
 * Stack page a session does it instead, because that is where the install goes wrong in ways a fixed
 * list cannot answer for — a held-back package, a service that will not start, a database role that is
 * already there — and the page shows its transcript while it works.
 *
 * It lives in one directory, `<sessionsDir>/stack`, overwritten on every run. The name is deliberate:
 * `runDirs` / `listSessionDirs` only take `issue-<n>`, `review-<n>` and `approved-<n>`, so this run
 * takes no session slot, is not held back by `machineHold` and never shows up as a board run.
 */

const dir = () => path.join(cfg().sessionsDir, 'stack');

/** What the last stack session was for and whether it is still going. */
function session(): { sessionId?: string; what?: string; running: boolean } {
  const d = dir();
  return {
    sessionId: readFile(path.join(d, 'session_id'))?.trim() || undefined,
    what: readFile(path.join(d, 'what'))?.trim() || undefined,
    running: pidAlive(pidOf(d)),
  };
}

/** The install the Stack page shows: the boot-time job and, once there has been one, the AI session. */
export function withStackSession(status: InstallStatus): InstallStatus {
  const s = session();
  if (!s.sessionId) return status;
  return {
    ...status,
    sessionId: s.sessionId,
    running: status.running || s.running,
    ...(status.running ? {} : { what: s.what }),
  };
}

/** Starts the session that installs `ids` here. Returns the reason it did not start, or nothing. */
export function startStackSession(ids: StackId[]): { started: StackId[]; error?: string } {
  if (!ids.length) return { started: [] };
  const d = dir();
  if (pidAlive(pidOf(d))) return { started: [], error: 'an install session is already running' };
  const labels = ids.map((id) => TOOLS[id].label).join(', ');
  if (isDry()) {
    log(`dry-run: would start an install session for ${labels}`);
    return { started: ids };
  }
  const model = cfg().models.implement;
  // A previous run's marks would be read as this one's until claude has written its own.
  for (const f of ['pid', 'session_id']) remove(path.join(d, f));
  fs.mkdirSync(d, { recursive: true });
  write(path.join(d, 'what'), labels);
  log(`stack: install session for ${labels} on ${model}`);
  start(d, d, `/sloth:stack ${ids.join(' ')}`, {}, path.join(d, 'run.log'), { model, env: { SLOTH_STACK_INSTALL: ids.join(' ') } });
  return { started: ids };
}
