import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEnv } from '../server/runner/session-env';
import { configure, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

/**
 * `plugin/README.md` is the contract between the server and the commands: the table of `SLOTH_*`
 * variables is what every command reads instead of hard-coding an id. Nothing links the two, so a
 * variable renamed in `session-env.ts` used to leave the table describing a name no session ever gets —
 * and the command reading it got `""` and carried on. The table is parsed here and checked against a
 * real environment, so the drift cannot be silent.
 */

const README = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'README.md');

/**
 * Only a `/sloth:stack` run gets this one, and `stack-session.ts` puts it on that run itself — it is
 * documented in the same table because a command reads it, but no ordinary session has it.
 */
const NOT_ON_EVERY_SESSION = ['SLOTH_STACK_INSTALL', 'SLOTH_REVIEW_COMMENT', 'SLOTH_SMOKE_RUN', 'SLOTH_SMOKE_SHA'];

/**
 * The names in the environment table. A row names a variable in full (`` `SLOTH_REPO` ``), several in
 * full separated by `/` or `,`, or one in full and the rest as the tail that differs
 * (`` `SLOTH_COL_PICKUP_ID` / `_NAME` ``), which is the whole name with its last segment swapped.
 */
function documented(): string[] {
  const md = fs.readFileSync(README, 'utf8');
  const section = md.split('## What the session needs from its environment')[1]?.split('\n## ')[0] ?? '';
  const names: string[] = [];
  for (const row of section.split('\n')) {
    const cell = /^\|\s*([^|]+?)\s*\|/.exec(row)?.[1];
    if (!cell?.includes('SLOTH_')) continue;
    for (const token of cell.split(/[\/,]/).map((t) => t.trim().replace(/`/g, ''))) {
      if (token.startsWith('SLOTH_')) names.push(token);
      else if (token.startsWith('_') && names.length) names.push(names[names.length - 1].replace(/_[^_]+$/, token));
    }
  }
  return [...new Set(names)];
}

/** A session as fully equipped as one gets: an issue and a PR, a leased worktree, a warm stack. */
const fullEnv = () =>
  sessionEnv('/tmp/session', { issue: 42, pr: 100 }, 'opus', true, { worktree: 'slot-1', warm: true, warmSame: true, budgetMinutes: 60 });

beforeEach(() => {
  configure();
  wipe();
});

describe('the environment table in plugin/README.md', () => {
  it('is read at all — an expression that matched nothing would pass every check below', () => {
    expect(documented().length).toBeGreaterThan(30);
    expect(documented()).toContain('SLOTH_SESSION_DIR');
    expect(documented()).toContain('SLOTH_COL_PICKUP_NAME'); // written in the table as `_NAME`
    expect(documented()).toContain('SLOTH_PR');
  });

  it('describes only variables a session is actually given', () => {
    const env = fullEnv();
    const missing = documented().filter((name) => !NOT_ON_EVERY_SESSION.includes(name) && !(name in env));
    expect(missing).toEqual([]);
  });
});

describe('sessionEnv', () => {
  it('tells the session where its board, its columns and its people are', () => {
    const env = fullEnv();
    expect(env.SLOTH_REPO).toBe('acme/widgets');
    expect(env.SLOTH_PROJECT_NUMBER).toBe('7');
    expect(env.SLOTH_COL_IN_PROGRESS_ID).toBe('opt-wip');
    expect(env.SLOTH_COL_IN_PROGRESS_NAME).toBe('In Progress');
    expect(env.SLOTH_ADMIN_LOGIN).toBe('alice');
    expect(env.SLOTH_DEVELOPER_LOGINS).toBe('bob');
    expect(env.SLOTH_TESTER_LOGINS).toBe('carol');
  });

  it('names an opted-out column as empty rather than leaving the variable off', () => {
    // A command that reads an absent variable gets the same `""` either way, but the contract is that
    // every documented name is set: "no QA column" is a value, not a missing key.
    const env = fullEnv();
    expect(env.SLOTH_COL_QA_ID).toBe('');
    expect('SLOTH_COL_QA_NAME' in env).toBe(true);
  });

  it('gives the run a deadline its own budget, not the config’s, decides', () => {
    const env = sessionEnv('/tmp/session', { issue: 42 }, 'opus', false, { budgetMinutes: 20 });
    expect(env.SLOTH_BUDGET_MIN).toBe('20');
    expect(Number(env.SLOTH_DEADLINE) - Number(env.SLOTH_START)).toBe(20 * 60);
    expect(env.SLOTH_CHROME).toBe('0');
  });

  it('leaves out the target and the worktree a run has not got', () => {
    const env = sessionEnv('/tmp/session', { pr: 100 }, 'opus', false, {});
    expect('SLOTH_ISSUE' in env).toBe(false);
    expect(env.SLOTH_PR).toBe('100');
    expect('SLOTH_WORKTREE' in env).toBe(false);
    expect('SLOTH_WARM' in env).toBe(false);
  });

  it('puts the leased slot under the worktrees directory, and says the stack was inherited', () => {
    const env = fullEnv();
    expect(env.SLOTH_WORKTREE).toBe(path.join(String(env.SLOTH_WORKTREES_DIR), 'slot-1'));
    expect(env.SLOTH_WARM).toBe('1');
    expect(env.SLOTH_WARM_SAME).toBe('1');
  });
});
