import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, reloadConfig, type ResolvedConfig } from '../server/config';
import type { BoardItem } from '../server/runner/board';
import { writeConfigFile, normalizeConfig } from '../server/config-file';
import type { SlothConfig } from '../server/config-types';

/** The throwaway home `test/setup.ts` made for this process. */
export const root = (): string => process.env.SLOTH_TEST_ROOT!;

export const COLUMNS = {
  pickup: { id: 'opt-todo', name: 'Todo' },
  inProgress: { id: 'opt-wip', name: 'In Progress' },
  needsHelp: { id: 'opt-help', name: 'Sloth needs help' },
  codeReview: { id: 'opt-review', name: 'Code Review' },
  approved: { id: 'opt-approved', name: 'Approved' },
  done: { id: 'opt-done', name: 'Done' },
};

/** One board card; `extra` overrides any field — an assignee, a label, a closed issue. */
export const card = (number: number, status: string, extra: Partial<BoardItem> = {}): BoardItem => ({
  number,
  title: `Issue ${number}`,
  status,
  labels: [],
  assignees: [],
  closed: false,
  ...extra,
});

/** A complete, valid config under the test home; `overrides` is merged on top before normalizing. */
export function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const home = root();
  return {
    repo: 'acme/widgets',
    project: { id: 'PVT_1', number: 7, owner: 'acme', title: 'Widgets' },
    statusField: { id: 'PVTSSF_1', columns: COLUMNS },
    runnerRoot: path.join(home, 'runner'),
    worktreesDir: path.join(home, 'worktrees'),
    sessionsDir: path.join(home, 'sessions'),
    stateDir: path.join(home, 'state'),
    watcherLog: path.join(home, 'watcher.log'),
    roles: { admin: 'alice', developers: ['bob'], testers: ['carol'] },
    boardSeconds: 300,
    commentSeconds: 120,
    ...overrides,
  };
}

/** Writes the config file and reloads it, so every server module sees this configuration. */
export function configure(overrides: Record<string, unknown> = {}): ResolvedConfig {
  const config: SlothConfig = normalizeConfig(baseConfig(overrides));
  writeConfigFile(CONFIG_PATH, config);
  const c = reloadConfig();
  for (const dir of [c.runnerRoot, c.worktreesDir, c.sessionsDir, c.stateDir]) fs.mkdirSync(dir, { recursive: true });
  return c;
}

/** Empties the session, state and worktree directories and the log, keeping the config. */
export function wipe(): void {
  const c = reloadConfig();
  for (const dir of [c.worktreesDir, c.sessionsDir, c.stateDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.rmSync(c.watcherLog, { force: true });
}

export const sessionDir = (kind: 'issue' | 'review' | 'approved', n: number) => path.join(reloadConfig().sessionsDir, `${kind}-${n}`);

/** A session directory with the given files (`state.json` may be given as an object). */
export function makeSession(kind: 'issue' | 'review' | 'approved', n: number, files: Record<string, string | object> = {}): string {
  const dir = sessionDir(kind, n);
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

/** This very process's pid — the one pid a test knows is alive. */
export const alivePid = () => String(process.pid);

export const readLog = (): string[] => {
  try {
    return fs.readFileSync(reloadConfig().watcherLog, 'utf8').trimEnd().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

export const exists = (...parts: string[]) => fs.existsSync(path.join(...parts));
export const read = (file: string) => fs.readFileSync(file, 'utf8');
export const statePath = (...parts: string[]) => path.join(reloadConfig().stateDir, ...parts);
