import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { readFile, readNumber } from './log';

export type Kind = 'issue' | 'review';

export interface RunDir {
  name: string;
  kind: Kind;
  target: number;
  dir: string;
}

/** `<sessionsDir>/issue-12` for the implement session of issue 12, `review-34` for a PR review. */
export const dirOf = (kind: Kind, target: number) => path.join(cfg().sessionsDir, `${kind}-${target}`);
export const issueDir = (issue: number) => dirOf('issue', issue);
export const reviewDir = (pr: number) => dirOf('review', pr);

export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const pidOf = (dir: string) => readNumber(path.join(dir, 'pid')) || undefined;
export const dirAlive = (dir: string) => pidAlive(pidOf(dir));
export const issueAlive = (issue: number) => dirAlive(issueDir(issue));

/** Every session directory Sloth has ever created, live or not. */
export function runDirs(): RunDir[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(cfg().sessionsDir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const m = /^(issue|review)-(\d+)$/.exec(name);
    return m ? [{ name, kind: m[1] as Kind, target: Number(m[2]), dir: path.join(cfg().sessionsDir, name) }] : [];
  });
}

export interface RunState {
  state?: string;
  since?: number;
  step?: string;
  note?: string;
}

export function stateOf(dir: string): RunState {
  try {
    return JSON.parse(readFile(path.join(dir, 'state.json')) ?? '') as RunState;
  } catch {
    return {};
  }
}

/** When the current phase of the run started — the session's own mark, else the pid file's mtime. */
export function startedAt(dir: string): number {
  const since = stateOf(dir).since;
  if (since) return since;
  try {
    return Math.floor(fs.statSync(path.join(dir, 'pid')).mtimeMs / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

export const counter = (dir: string, name: string) => readNumber(path.join(dir, name));
export const isBlocked = (dir: string) => fs.existsSync(path.join(dir, 'blocked'));

const live = () => runDirs().filter((d) => dirAlive(d.dir));
export const countAlive = () => live().length;
export const countActive = () => live().filter((d) => (stateOf(d.dir).state ?? 'working') === 'working').length;

/** No slot left: either every session, or every working session, is spoken for. */
export const slotsFull = () => countAlive() >= cfg().maxAlive || countActive() >= cfg().maxActive;
