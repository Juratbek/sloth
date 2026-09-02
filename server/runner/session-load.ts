import { table, setReaders, type Process, type Readers } from './process-table';
import type { SessionLoad } from '../types';

/**
 * What each live session is taking of the machine. A session is one detached `claude` process
 * (`spawn.ts` writes its pid) with everything it started under it — the app it boots, its database,
 * a headless browser, `git`, `pnpm` — so the figure worth showing is the whole process tree's, not
 * the one process's. Subagents get no line of their own: they run inside the same OS process as the
 * session that started them, so there is nothing to read them apart by.
 *
 * `machine.ts` reads the same three resources for the machine as a whole, to decide whether a new
 * session may start; this reads them per session, to show where the load is coming from.
 */
export type { Process, Readers } from './process-table';

/** Tests stand in their own readers; `undefined` puts the real ones back. Clears the last reading too,
 *  so a test never diffs its own table against the one before it. */
export function setProcessReaders(r?: Readers): void {
  setReaders(r);
  previous = undefined;
  loads = new Map();
}

/** Two readings less than this apart are not worth taking: the previous answer is served again. */
const MIN_WINDOW_MS = 1000;

let previous: { at: number; byPid: Map<number, Process> } | undefined;
let loads = new Map<number, SessionLoad>();

/** Every pid under `root`, the root itself included — a session owns everything its run started. */
function tree(root: number, children: Map<number, number[]>): number[] {
  const out: number[] = [];
  const queue = [root];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue; // A pid reused as its own ancestor would loop forever.
    seen.add(pid);
    out.push(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return out;
}

/**
 * One reading for all the live sessions at once — the process table is read once however many there are.
 *
 * CPU and disk are rates, so they need two readings: the first call after a start measures nothing and
 * the sessions come back without a load. A process that appeared during the window counts in full — it
 * did spend that time inside the window — and one that ended during it is lost with its counters, so a
 * run of short-lived `git` and `pnpm` processes reads a little low.
 */
export function sampleSessions(pids: number[]): Map<number, SessionLoad> {
  const at = table().now?.() ?? Date.now();
  if (!pids.length) {
    loads = new Map();
    return loads;
  }
  if (previous && at - previous.at < MIN_WINDOW_MS) return loads;
  const procs = table().processes();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, number[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  // The byte counters cost a read each, so only the session trees are asked for them — and they are
  // asked on the first reading too, or the second would diff against nothing and report a process's
  // whole lifetime as one window's worth of disk.
  const trees = new Map(pids.filter((pid) => byPid.has(pid)).map((pid) => [pid, tree(pid, children)]));
  const io = table().io;
  if (io)
    for (const branch of trees.values())
      for (const pid of branch) {
        const p = byPid.get(pid);
        if (p && p.readBytes === undefined) Object.assign(p, io(pid));
      }
  const before = previous;
  previous = { at, byPid };
  if (!before) {
    loads = new Map();
    return loads;
  }
  const seconds = (at - before.at) / 1000;
  const next = new Map<number, SessionLoad>();
  for (const [root, branch] of trees) {
    let memory = 0;
    let cpu = 0;
    let read: number | undefined;
    let written: number | undefined;
    let counted = 0;
    for (const pid of branch) {
      const now = byPid.get(pid);
      if (!now) continue;
      counted++;
      memory += now.rss;
      // A pid absent from the previous reading was born inside the window: all of its usage falls in it.
      const was = before.byPid.get(pid);
      cpu += Math.max(0, now.cpuSeconds - (was?.cpuSeconds ?? 0));
      if (now.readBytes !== undefined) read = (read ?? 0) + Math.max(0, now.readBytes - (was?.readBytes ?? 0));
      if (now.writeBytes !== undefined) written = (written ?? 0) + Math.max(0, now.writeBytes - (was?.writeBytes ?? 0));
    }
    const perSecond = (n?: number) => (n === undefined || seconds <= 0 ? undefined : Math.round(n / seconds));
    next.set(root, {
      cpu: seconds > 0 ? Math.round((cpu / seconds) * 100) : 0,
      memory,
      readBytes: perSecond(read),
      writeBytes: perSecond(written),
      processes: counted,
      at,
    });
  }
  loads = next;
  return loads;
}

/** The last reading for one session's pid; nothing before the second reading, or once its process is gone. */
export const sessionLoad = (pid?: number): SessionLoad | undefined => (pid ? loads.get(pid) : undefined);
