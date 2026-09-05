import { spawn, type ChildProcess } from 'node:child_process';
import { broadcast } from './events';
import { run } from './exec';
import { refreshHealth } from './health';
import { which } from './install';
import { log } from './runner/log';
import type { GhLogin } from './setup-types';

/**
 * `gh auth login`, pressed in the wizard instead of typed in a terminal. The device flow needs no
 * terminal: run with pipes for its output, `gh` prints the one-time code and the URL to type it at,
 * opens that URL in the machine's browser, and waits for GitHub to say the code was entered. The wizard
 * shows the same code and URL, for a browser the machine could not open, or one on another screen.
 *
 * One login at a time, its state module-level like the install's: the wizard polls for the code while
 * `gh` waits, and for the verdict once it has exited. After a login the git credential helper is set up
 * the way an interactive `gh auth login` offers to — the sessions push over HTTPS with it — and the
 * health reading is retaken, so the header chip stops saying `gh` is logged out.
 *
 * The verdict waits for `close`, not `exit`: the reason `gh` gives up is on stderr, and a pipe may still
 * hold it when the process is reaped. A `gh` that died of a signal — killed from a task manager, the
 * OOM killer — has `code` null, which is not a login.
 */

const DEVICE_URL = 'https://github.com/login/device';
const TAIL = 5;
const ARGS = ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key'];

let status: GhLogin = { running: false };
let child: ChildProcess | undefined;

export const ghLoginStatus = (): GhLogin => status;

/** The code and the URL out of what `gh` has printed so far — `! First copy your one-time code: XXXX-XXXX` and `Open this URL …: https://…`. */
export function parseDeviceFlow(text: string): Pick<GhLogin, 'code' | 'url'> {
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(text)?.[1];
  const url = /Open this URL[^\n]*?(https:\/\/\S+)/i.exec(text)?.[1];
  return { ...(code ? { code, url: url ?? DEVICE_URL } : {}) };
}

/** What `gh` said about why it gave up: its `error:` line, else its last lines, else how it ended. */
function reason(text: string, code: number | null, signal: NodeJS.Signals | null): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/one-time code|Open this URL|Press Enter/i.test(l));
  const error = lines.find((l) => /^error:|failed/i.test(l));
  return error ?? (lines.slice(-TAIL).join(' ') || (signal ? `gh was stopped by ${signal}` : `gh exited with ${code}`));
}

async function afterLogin(bin: string): Promise<void> {
  const helper = await run(bin, ['auth', 'setup-git', '--hostname', 'github.com'], { timeout: 20_000 });
  if (!helper.ok) log(`gh login: credential helper not set up — ${helper.err.split('\n')[0]}`);
  await refreshHealth().catch(() => undefined);
}

/** Starts the login, or returns the one already running. */
export function startGhLogin(): GhLogin {
  if (status.running) return status;
  const bin = which('gh');
  if (!bin) return (status = { running: false, error: '`gh` was not found on PATH' });
  let proc: ChildProcess;
  try {
    proc = spawn(bin, ARGS, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  } catch (e) {
    return (status = { running: false, error: e instanceof Error ? e.message : String(e) });
  }
  child = proc;
  status = { running: true };
  log('gh login: started');
  let text = '';
  const mine = () => child === proc;
  const finish = (error?: string) => {
    if (!mine()) return;
    child = undefined;
    status = error ? { running: false, error } : { running: false, ok: true };
    log(error ? `gh login: failed — ${error}` : 'gh login: done');
    broadcast();
  };
  const read = (chunk: Buffer) => {
    if (!mine()) return;
    text += chunk.toString();
    const found = parseDeviceFlow(text);
    if (found.code && found.code !== status.code) {
      status = { ...status, ...found };
      broadcast();
    }
  };
  proc.stdout?.on('data', read);
  proc.stderr?.on('data', read);
  proc.on('error', (e) => finish(e.message));
  proc.on('close', (code, signal) => {
    if (code !== 0) return finish(reason(text, code, signal));
    void afterLogin(bin).finally(() => finish());
  });
  return status;
}

/** Stops a login still waiting on the code; the status goes back to "nothing running" either way. */
export function cancelGhLogin(): GhLogin {
  const proc = child;
  child = undefined;
  status = { running: false };
  if (proc) {
    proc.kill();
    log('gh login: cancelled');
    broadcast();
  }
  return status;
}

/** The server going down takes a waiting `gh` with it: left alone it would poll GitHub for a code no page shows any more. */
export function stopGhLogin(): void {
  if (child) cancelGhLogin();
}
