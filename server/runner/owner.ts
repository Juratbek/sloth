import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../atomic';
import { CONFIG_PATH, cfg } from '../config';
import { log } from './log';
import { pidAlive } from './session-dirs';

/**
 * One state directory, one Sloth. Every instance writes `state/owner.json` — its pid, its port and the
 * config file it runs from — before its watcher starts, and refuses to start on a directory another
 * live instance holds under a different config. Two instances on one machine would otherwise read each
 * other's sessions, answer on each other's cards and show one client's work to the other; the defaults
 * keep their homes apart (`env.ts`), and this is the check that they stayed apart.
 */

export interface Owner {
  pid: number;
  port: number;
  config: string;
  at: number;
}

const ownerFile = () => path.join(cfg().stateDir, 'owner.json');

function readOwner(): Owner | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(ownerFile(), 'utf8')) as Owner;
    return o && typeof o.pid === 'number' && typeof o.config === 'string' ? o : undefined;
  } catch {
    return undefined;
  }
}

let conflict: string | undefined;

/** Why this instance is not running, when another one holds its state directory; undefined while it is free to run. */
export const ownerConflict = (): string | undefined => conflict;

/**
 * Claims the state directory for this process. Another instance's claim counts only while its process
 * is alive: a Sloth that crashed leaves a file, not a claim.
 */
export function claimState(): boolean {
  const other = readOwner();
  if (other && other.config !== CONFIG_PATH && other.pid !== process.pid && pidAlive(other.pid)) {
    conflict = `the state directory ${cfg().stateDir} belongs to the Sloth running from ${other.config} (pid ${other.pid}, port ${other.port}) — this instance will not run on it; give it its own directories in Settings → Repository`;
    log(`not watching: ${conflict}`);
    return false;
  }
  conflict = undefined;
  fs.mkdirSync(cfg().stateDir, { recursive: true });
  const owner: Owner = { pid: process.pid, port: cfg().port, config: CONFIG_PATH, at: Date.now() };
  writeAtomic(ownerFile(), `${JSON.stringify(owner, null, 2)}\n`);
  return true;
}

/** Lets the directory go on the way out, so the next instance is not held up by a dead claim. */
export function releaseState(): void {
  const mine = readOwner();
  if (mine?.pid === process.pid) fs.rmSync(ownerFile(), { force: true });
}
