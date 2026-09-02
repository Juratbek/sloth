import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../atomic';
import { cfg } from '../config';

/** One line per event, appended to ~/.sloth/watcher.log — the monitor tails this file. */
export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(`sloth ${line}`);
  try {
    fs.mkdirSync(path.dirname(cfg().watcherLog), { recursive: true });
    fs.appendFileSync(cfg().watcherLog, line);
  } catch {
    /* the log is best effort */
  }
}

// A dry run logs "would …" instead of launching, moving cards or writing dedupe markers.
let dry = process.env.SLOTH_DRY_RUN === '1';
export const isDry = () => dry;
export const setDry = (value: boolean) => {
  dry = value;
};

export const nowSec = () => Math.floor(Date.now() / 1000);

export const readFile = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

export const readNumber = (file: string): number => Number(readFile(file)?.trim() ?? 0) || 0;

/**
 * Every state file the runner keeps — `state.json`, `pid`, `sha`, `retries`, the dedupe markers,
 * `preview-state.json`, the slot book. Atomic (`../atomic.ts`): Sloth reads all of these back, and a
 * half-written one is worse than none at all, because it is believed.
 */
export const write = (file: string, body: string): void => writeAtomic(file, body);

export const remove = (file: string) => fs.rmSync(file, { force: true, recursive: true });
