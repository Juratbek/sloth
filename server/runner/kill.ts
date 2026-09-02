import { run } from '../exec';

/**
 * Ending a process and everything it started, on both the machines Sloth runs on.
 *
 * A session is a detached `claude` that leads its own process group, and the app, database and browser it
 * boots are its children — so on macOS and Linux the group is signalled first (`-pid`) and the process
 * itself after, in case it was never made a leader. Windows has no process groups and `process.kill(-pid)`
 * is an error there, so a killed session used to lose only its `claude`: the dev servers and the browser it
 * started stayed up, holding the machine's memory and its ports until someone noticed. `taskkill /T` walks
 * the child tree the same way, and `/F` is the only way it ends them — Windows has no polite SIGTERM.
 *
 * A stopped process (`pressure.ts` pauses one with SIGSTOP) cannot act on a SIGTERM, so it is woken first;
 * one that is already gone raises ESRCH, which is the answer this wanted anyway.
 */
export async function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (!pid || pid < 0) return;
  if (process.platform === 'win32') {
    // Async and through the one exec seam, like every other shell-out; a failure means it was already gone.
    await run('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: 30_000 });
    return;
  }
  for (const target of [-pid, pid]) {
    for (const sig of ['SIGCONT', signal] as const) {
      try {
        process.kill(target, sig);
      } catch {
        /* no such group, or already gone */
      }
    }
  }
}
