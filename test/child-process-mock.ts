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

/** One recorded `execFile` call — `stdin` is whatever the caller wrote to the child (`sudo -S` and its password). */
export interface Executed {
  cmd: string;
  args: string[];
  line: string;
  stdin: string;
}
export const executed: Executed[] = [];

/** How the next matching `execFile` ends; anything not matched succeeds silently, as it always has. */
const replies: { match: RegExp; code: number; stderr: string }[] = [];
export const onExecFile = (match: RegExp, { code = 0, stderr = '' }: { code?: number; stderr?: string }) => replies.unshift({ match, code, stderr });

export const execFile = vi.fn((cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
  const call: Executed = { cmd, args, line: [cmd, ...args].join(' '), stdin: '' };
  executed.push(call);
  const reply = replies.find((r) => r.match.test(call.line));
  cb(reply?.code ? Object.assign(new Error(`exited with ${reply.code}`), { code: reply.code }) : null, '', reply?.stderr ?? '');
  return {
    stdin: {
      end(text?: string) {
        call.stdin += text ?? '';
      },
    },
    on() {},
    kill() {},
  };
});
export const resetSpawn = () => {
  spawned.length = 0;
  executed.length = 0;
  replies.length = 0;
};
