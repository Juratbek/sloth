import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { log, remove, write } from './log';

const pausedFile = () => path.join(cfg().stateDir, 'paused');

/**
 * The user's own pause, kept as a file so a Sloth restart stays paused. While it exists Sloth starts
 * no new work — no pickups, no relaunches, no reviews, no sessions from orders. Running sessions,
 * reaping, inbox delivery and status replies are untouched.
 */
export const isPaused = (): boolean => fs.existsSync(pausedFile());

/** Sets the pause and logs the change; a no-op when it is already in that state. */
export function setPaused(paused: boolean): boolean {
  if (paused === isPaused()) return paused;
  if (paused) write(pausedFile(), `${new Date().toISOString()}\n`);
  else remove(pausedFile());
  log(paused ? 'paused by user' : 'resumed by user');
  return paused;
}
