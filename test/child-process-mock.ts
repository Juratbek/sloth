import { vi } from 'vitest';

/** The processes `spawn.ts` would start — recorded, never run. Install with `vi.mock('node:child_process', () => import('./child-process-mock'))`. */
export interface Spawned {
  cmd: string;
  args: string[];
  options: Record<string, any>;
}
export const spawned: Spawned[] = [];
/** A pid nothing on the machine is likely to have: the fake child is "dead" the moment it is asked about. */
export const FAKE_PID = 2_000_000_000;

export const spawn = vi.fn((cmd: string, args: string[], options: Record<string, any>) => {
  spawned.push({ cmd, args, options });
  return { pid: FAKE_PID, unref() {}, on() {}, kill() {}, stdout: null, stderr: null };
});
export const execFile = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
  cb(null, '', '');
});
export const resetSpawn = () => {
  spawned.length = 0;
};
