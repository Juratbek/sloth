import { AsyncLocalStorage } from 'node:async_hooks';
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

/**
 * A dry run logs "would …" instead of launching, moving cards or writing dedupe markers.
 *
 * Dryness belongs to the call, not to the process. `POST /api/tick?dry=1` used to flip a module-global
 * flag for the length of the whole tick — and a *real* stop-session or stop-preview request that arrived
 * in that window read the flag as its own and quietly did nothing, telling the human it had. The flag now
 * travels with the async context of the call that asked for it (`withDry`), so a concurrent request keeps
 * its own answer. `SLOTH_DRY_RUN=1` in the environment is still the whole process's, which is what the
 * `pnpm dry` entry point and `test/setup.ts` want.
 */
const store = new AsyncLocalStorage<{ dry: boolean }>();
export const isDry = () => process.env.SLOTH_DRY_RUN === '1' || store.getStore()?.dry === true;
/** Runs `fn` — and everything it awaits — as a dry run. The value it returns is passed straight back. */
export const withDry = <T>(fn: () => T): T => store.run({ dry: true }, fn);
/** The process-wide switch, which tests flip around one case; `withDry` is what the server itself uses. */
export const setDry = (value: boolean) => {
  process.env.SLOTH_DRY_RUN = value ? '1' : '';
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
