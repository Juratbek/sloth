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
}

const TIMEOUT = 60_000;
const MAX_BUFFER = 32 << 20;

export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<Ran> {
  const { timeout = TIMEOUT, cwd, maxBuffer = MAX_BUFFER, env, stdin } = options;
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, cwd, maxBuffer, ...(env ? { env } : {}) }, (error, stdout, stderr) =>
      resolve({
        ok: !error,
        out: String(stdout ?? '').trim(),
        err: (String(stderr ?? '').trim() || String(error ?? '')).trim(),
      }),
    );
    if (stdin !== undefined) child?.stdin?.end(stdin);
  });
}
