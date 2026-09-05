import { execFile } from 'node:child_process';

/**
 * The one place Sloth starts a child process and waits for it. Every shell-out — `gh`, `git`, `sudo`,
 * `launchctl`, `dropdb`, a version probe — goes through here, always as `execFile` with an argv array
 * and never a shell string, so nothing a comment or an issue title carries can become a command.
 *
 * It resolves rather than rejects: a failed command is a fact the caller decides about, not an exception
 * to unwind a tick with. `err` is the child's stderr, or the error itself when the child never spoke —
 * `ENOENT` for a tool that is not installed, a timeout kill.
 *
 * Everything that starts a *long-lived* child (the tunnels, the sessions, the update's build) uses
 * `spawn` directly instead: those stream their output and are not waited for.
 */

export interface Ran {
  ok: boolean;
  out: string;
  err: string;
}

export interface RunOptions {
  /** Milliseconds before the child is killed; a minute unless the caller knows better. */
  timeout?: number;
  cwd?: string;
  /** Output cap. Generous by default: a `gh` board page or a `git` log dwarfs Node's own 1 MB. */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Written to the child's stdin, which is then closed. The one channel a secret may travel down
   * (`sudo -S` and the user's password, `sudo.ts`): an argument would show up in `ps`, an environment
   * variable in `/proc`.
   */
  stdin?: string;
  /**
   * On timeout, end the child *and everything it started*, not the child alone: `execFile`'s own
   * timeout signals one process, and a `gh repo clone` killed that way leaves its `git` writing on. The
   * child is started as the leader of its own group so the group can be signalled (`runner/kill.ts`).
   */
  killTree?: boolean;
}

const TIMEOUT = 60_000;
const MAX_BUFFER = 32 << 20;

export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<Ran> {
  const { timeout = TIMEOUT, cwd, maxBuffer = MAX_BUFFER, env, stdin, killTree } = options;
  return new Promise((resolve) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const child = execFile(
      cmd,
      args,
      { ...(killTree ? { detached: process.platform !== 'win32' } : { timeout }), cwd, maxBuffer, ...(env ? { env } : {}) },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        resolve({
          ok: !error && !timedOut,
          out: String(stdout ?? '').trim(),
          err: timedOut ? `timed out after ${Math.round(timeout / 1000)}s` : (String(stderr ?? '').trim() || String(error ?? '')).trim(),
        });
      },
    );
    if (killTree && child?.pid) {
      const pid = child.pid;
      timer = setTimeout(async () => {
        timedOut = true;
        // Lazily: `kill.ts` shells out through this very seam for `taskkill`, so a plain import would be a cycle.
        const { killTree: kill } = await import('./runner/kill');
        await kill(pid, 'SIGKILL');
      }, timeout);
    }
    if (stdin !== undefined) child?.stdin?.end(stdin);
  });
}
