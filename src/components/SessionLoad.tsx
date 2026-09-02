import type { SessionLoad } from '../../server/types';
import { bytes } from '../lib/format';

/**
 * What a live run is taking of the machine: its `claude` process and everything under it — the app it
 * booted, its database, its browser. Subagents have no line of their own anywhere in the UI; they run
 * inside the session's own process, so this figure already contains them.
 *
 * Nothing renders until the server has read the process table twice (CPU and disk are rates), and the
 * disk pair is absent on a macOS host, which has no per-process counter without root.
 */
const cpuTitle = (load: SessionLoad) =>
  `${load.processes} process${load.processes === 1 ? '' : 'es'} — the session and everything it started; 100% is one core busy`;

/** The session header's line: CPU, memory and, where the OS says, the disk read and written. */
export function LoadChips({ load }: { load?: SessionLoad }) {
  if (!load) return null;
  return (
    <>
      <span title={cpuTitle(load)}>
        cpu <span className="text-zinc-200">{load.cpu}%</span>
      </span>
      <span>
        mem <span className="text-zinc-200">{bytes(load.memory)}</span>
      </span>
      {load.readBytes !== undefined && load.writeBytes !== undefined && (
        <span title="Read and written to the disk, per second">
          disk <span className="text-zinc-200">↓{bytes(load.readBytes)}/s ↑{bytes(load.writeBytes)}/s</span>
        </span>
      )}
    </>
  );
}

/** The sidebar row's version — CPU and memory only, so the line still fits beside the token counts. */
export function LoadBrief({ load }: { load?: SessionLoad }) {
  if (!load) return null;
  return (
    <span className="text-zinc-300" title={cpuTitle(load)}>
      cpu {load.cpu}% · {bytes(load.memory)}
    </span>
  );
}
