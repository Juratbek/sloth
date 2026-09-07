import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../server/config-file';
import { setDry } from '../server/runner/log';
import { reap, stop } from '../server/runner/run-control';
import { localDate } from '../server/runner/qa';
import { daysBetween, requestSmoke, smokeDue, smokeTick, smokeVerdicts } from '../server/runner/smoke';
import { FAKE_PID, resetSpawn, spawned } from './child-process-mock';
import { onGh, resetGh } from './gh-mock';
import { alivePid, baseConfig, configure, exists, makeSession, read, readLog, runRef, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

const HEAD = 'c'.repeat(40);
const log = () => readLog().join('\n');
/** Noon on a given day of September 2026, local time — past a `00:00` start, before a `23:59` one. */
const noon = (day: number) => new Date(2026, 8, day, 12, 0);
const posted: Record<string, any>[] = [];

/** Every smoke test here is due by the clock unless a case says otherwise: on, at midnight, never run. */
beforeEach(() => {
  configure({
    smoke: { everyDays: 1, at: '00:00', branch: 'release', budgetMinutes: 90, brief: '' },
    chrome: false,
    maxActive: 2,
    maxAlive: 3,
    helpWebhook: 'https://hooks.example.com/x',
    webhookEvents: ['smokePassed', 'smokeFailed'],
  });
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
  onGh(/api repos\/acme\/widgets\/commits\/release/, () => HEAD);
  onGh(/repo view acme\/widgets --json defaultBranchRef/, 'main');
  onGh(/api repos\/acme\/widgets\/commits\/main/, () => HEAD);
  posted.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, statusText: 'OK' };
    }),
  );
});
afterEach(() => {
  setDry(false);
  vi.unstubAllGlobals();
});

describe('daysBetween', () => {
  it('counts calendar days, across a month and a year end', () => {
    expect(daysBetween('2026-09-04', '2026-09-04')).toBe(0);
    expect(daysBetween('2026-09-04', '2026-09-06')).toBe(2);
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-07')).toBe(7);
  });
});

describe('smokeDue', () => {
  it('is never due with the schedule off', () => {
    configure({ smoke: { everyDays: 0, at: '00:00', branch: '', budgetMinutes: 90, brief: '' } });
    expect(smokeDue(noon(4))).toBe(false);
  });

  it('waits for the time of day', () => {
    configure({ smoke: { everyDays: 1, at: '23:59', branch: '', budgetMinutes: 90, brief: '' } });
    expect(smokeDue(noon(4))).toBe(false);
    expect(smokeDue(new Date(2026, 8, 4, 23, 59))).toBe(true);
  });

  it('is due when it has never run, then every N calendar days from the last scheduled start', () => {
    configure({ smoke: { everyDays: 2, at: '00:00', branch: '', budgetMinutes: 90, brief: '' } });
    expect(smokeDue(noon(4))).toBe(true);
    fs.writeFileSync(statePath('smoke_ran'), '2026-09-04');
    expect(smokeDue(noon(4))).toBe(false);
    expect(smokeDue(noon(5))).toBe(false);
    expect(smokeDue(noon(6))).toBe(true);
    // A machine that was off on the day still owes the run.
    expect(smokeDue(noon(9))).toBe(true);
  });

  it('is weekly with 7', () => {
    configure({ smoke: { everyDays: 7, at: '00:00', branch: '', budgetMinutes: 90, brief: '' } });
    fs.writeFileSync(statePath('smoke_ran'), '2026-09-01');
    expect(smokeDue(noon(7))).toBe(false);
    expect(smokeDue(noon(8))).toBe(true);
  });

  it('treats a last-run mark it cannot read as never run', () => {
    fs.writeFileSync(statePath('smoke_ran'), 'yesterday');
    expect(smokeDue(noon(4))).toBe(true);
  });
});

describe('smokeTick, when the run is due', () => {
  it('launches /sloth:smoke 1 on the smoke model at the head of the branch, pinned beside the run, and marks the day', async () => {
    await smokeTick();

    expect(spawned).toHaveLength(1);
    const [{ cmd, args, options }] = spawned;
    expect(cmd).toBe('claude');
    expect(args.slice(0, 2)).toEqual(['-p', '/sloth:smoke 1']);
    expect(args[args.indexOf('--model') + 1]).toBe('fable');
    expect(options.env.SLOTH_SMOKE_RUN).toBe('1');
    expect(options.env.SLOTH_SMOKE_BRANCH).toBe('release');
    expect(options.env.SLOTH_SMOKE_SHA).toBe(HEAD);
    expect(options.env.SLOTH_BUDGET_MIN).toBe('90');
    expect(options.env.SLOTH_ISSUE).toBeUndefined();
    expect(options.env.SLOTH_WORKTREE).toMatch(/slot-1$/);
    const dir = sessionDir('smoke', 1);
    expect(read(path.join(dir, 'sha'))).toBe(HEAD);
    expect(read(path.join(dir, 'branch'))).toBe('release');
    expect(exists(dir, 'brief.md')).toBe(false);
    expect(read(statePath('smoke_seq'))).toBe('1');
    expect(read(statePath('smoke_ran'))).toBe(localDate());
    expect(log()).toMatch(/launch smoke test 1 on fable \(release @ ccccccc\)/);
  });

  it('resolves an empty branch to the default branch, and hands the brief to the session', async () => {
    configure({ smoke: { everyDays: 1, at: '00:00', branch: '', budgetMinutes: 90, brief: 'ADMIN: /dashboard — staff, settings' }, chrome: false });
    await smokeTick();
    expect(spawned[0].options.env.SLOTH_SMOKE_BRANCH).toBe('main');
    expect(read(path.join(sessionDir('smoke', 1), 'brief.md'))).toBe('ADMIN: /dashboard — staff, settings\n');
  });

  it('numbers the next run after the last', async () => {
    fs.writeFileSync(statePath('smoke_seq'), '4');
    await smokeTick();
    expect(spawned[0].args[1]).toBe('/sloth:smoke 5');
    expect(read(statePath('smoke_seq'))).toBe('5');
  });

  it('runs once a day: the second tick of the day starts nothing', async () => {
    await smokeTick();
    resetSpawn();
    await smokeTick();
    expect(spawned).toHaveLength(0);
  });

  it('stays due while the slots are full, and starts on the tick that can', async () => {
    configure({ smoke: { everyDays: 1, at: '00:00', branch: 'release', budgetMinutes: 90, brief: '' }, chrome: false, maxActive: 1, maxAlive: 1 });
    makeSession('issue', 7, { pid: alivePid(), 'state.json': { state: 'working' } });
    await smokeTick();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('smoke_ran'))).toBe(false);
    expect(log()).toMatch(/smoke test queued \(slots full\)/);

    fs.rmSync(sessionDir('issue', 7), { recursive: true });
    await smokeTick();
    expect(spawned).toHaveLength(1);
  });

  it('never starts a second one while one is running', async () => {
    makeSession('smoke', 3, { pid: alivePid(), 'state.json': { state: 'working' } });
    await smokeTick();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('smoke_ran'))).toBe(false);
  });

  it('starts nothing and writes nothing in a dry run', async () => {
    setDry(true);
    await smokeTick();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('smoke_seq'))).toBe(false);
    expect(exists(statePath('smoke_ran'))).toBe(false);
    expect(log()).toMatch(/dry-run: would launch smoke test 1 on fable \(release @ ccccccc\)/);
  });

  it('gives up on a head it cannot read, and stays due', async () => {
    resetGh();
    onGh(/api repos\/acme\/widgets\/commits\/release/, { ok: false, out: '', err: 'HTTP 404: Not Found' });
    await smokeTick();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('smoke_ran'))).toBe(false);
    expect(log()).toMatch(/smoke test: the head of release in acme\/widgets could not be read: HTTP 404/);
  });
});

describe('smokeTick, asked for from the monitor', () => {
  beforeEach(() => configure({ smoke: { everyDays: 0, at: '00:00', branch: 'release', budgetMinutes: 90, brief: '' }, chrome: false }));

  it('starts a run whatever the schedule says, and forgets the request', async () => {
    requestSmoke();
    expect(exists(statePath('smoke_due'))).toBe(true);
    await smokeTick();
    expect(spawned).toHaveLength(1);
    expect(exists(statePath('smoke_due'))).toBe(false);
    // Not the day's scheduled run: the schedule is off, and nothing says it ran today.
    expect(exists(statePath('smoke_ran'))).toBe(false);
  });

  it('keeps the request while the machine is full', async () => {
    configure({ smoke: { everyDays: 0, at: '00:00', branch: 'release', budgetMinutes: 90, brief: '' }, chrome: false, maxActive: 1, maxAlive: 1 });
    makeSession('issue', 7, { pid: alivePid(), 'state.json': { state: 'working' } });
    requestSmoke();
    await smokeTick();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('smoke_due'))).toBe(true);
  });

  it('drops the request while a smoke test is running', async () => {
    makeSession('smoke', 1, { pid: alivePid(), 'state.json': { state: 'working' } });
    requestSmoke();
    await smokeTick();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('smoke_due'))).toBe(false);
    expect(log()).toMatch(/one is already running — the request is dropped/);
  });

  it('counts as the day\'s run when the day was due anyway', async () => {
    configure({ smoke: { everyDays: 1, at: '00:00', branch: 'release', budgetMinutes: 90, brief: '' }, chrome: false });
    requestSmoke();
    await smokeTick();
    expect(spawned).toHaveLength(1);
    expect(read(statePath('smoke_ran'))).toBe(localDate());
    expect(exists(statePath('smoke_due'))).toBe(false);
  });

  it('only logs in a dry run', () => {
    setDry(true);
    requestSmoke();
    expect(exists(statePath('smoke_due'))).toBe(false);
    expect(log()).toMatch(/dry-run: would ask for a smoke test/);
  });
});

describe('smokeVerdicts', () => {
  const ended = (n: number, verdict: string, extra: Record<string, string> = {}) =>
    makeSession('smoke', n, { pid: String(FAKE_PID), 'state.json': { state: 'done', step: '6' }, sha: HEAD, branch: 'release', verdict, ...extra });

  it('tells the webhook a NO-GO, with the report issue, once', async () => {
    ended(1, 'no-go', { report_issue: '42' });
    await smokeVerdicts();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ event: 'smokeFailed', issue: 42, url: 'https://github.com/acme/widgets/issues/42' });
    expect(posted[0].text).toMatch(/^Smoke test 1 on release @ ccccccc: NO-GO/);
    expect(exists(sessionDir('smoke', 1), 'handled')).toBe(true);
    expect(log()).toMatch(/smoke test 1: NO-GO on release @ ccccccc — the report is on #42/);
    await smokeVerdicts();
    expect(posted).toHaveLength(1);
  });

  it('a GO and a GO with risks pass; anything else fails', async () => {
    ended(1, 'go');
    ended(2, 'go-with-risks');
    ended(3, 'inconclusive');
    ended(4, 'maybe');
    await smokeVerdicts();
    const events = Object.fromEntries(posted.map((p) => [p.text.split(' ')[2], p.event]));
    expect(events).toEqual({ '1': 'smokePassed', '2': 'smokePassed', '3': 'smokeFailed', '4': 'smokeFailed' });
    expect(posted.find((p) => p.text.startsWith('Smoke test 2'))!.text).toMatch(/: GO with risks — /);
    // No report issue recorded: the link is the repository's.
    expect(posted[0].url).toBe('https://github.com/acme/widgets');
  });

  it('leaves a run with no verdict, and a live one, alone', async () => {
    makeSession('smoke', 1, { pid: String(FAKE_PID), 'state.json': { state: 'working' }, sha: HEAD });
    makeSession('smoke', 2, { pid: alivePid(), 'state.json': { state: 'working' }, sha: HEAD, verdict: 'go' });
    await smokeVerdicts();
    expect(posted).toHaveLength(0);
    expect(exists(sessionDir('smoke', 1), 'handled')).toBe(false);
    expect(exists(sessionDir('smoke', 2), 'handled')).toBe(false);
  });

  it('marks nothing handled in a dry run', async () => {
    ended(1, 'go');
    setDry(true);
    await smokeVerdicts();
    expect(posted).toHaveLength(0);
    expect(exists(sessionDir('smoke', 1), 'handled')).toBe(false);
    expect(log()).toMatch(/dry-run: would notify webhook: Smoke test 1 on release @ ccccccc: GO/);
  });
});

describe('a smoke run, in reap and stop', () => {
  it('is forgotten when it dies without a verdict — no retry, the schedule goes on', async () => {
    makeSession('smoke', 1, { pid: String(FAKE_PID), 'state.json': { state: 'working', step: '3' }, sha: HEAD, branch: 'release' });
    await reap();
    expect(exists(sessionDir('smoke', 1), 'pid')).toBe(false);
    expect(log()).toMatch(/smoke-1 ended without a verdict — the next scheduled smoke test runs as planned/);
  });

  it('is killed past its own budget, not the implement one', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      // 90 minutes is the smoke budget; 70 is past the implement budget of 60 but within the smoke test's.
      const started = (min: number) => String(Math.floor(Date.now() / 1000) - min * 60);
      makeSession('smoke', 1, { pid: '12345', started: started(70), 'state.json': { state: 'working' } });
      await reap();
      expect(exists(sessionDir('smoke', 1), 'pid')).toBe(true);
      fs.writeFileSync(path.join(sessionDir('smoke', 1), 'started'), started(100));
      await reap();
      expect(exists(sessionDir('smoke', 1), 'pid')).toBe(false);
      expect(log()).toMatch(/smoke test 1 stopped: hung past the budget/);
    } finally {
      kill.mockRestore();
    }
  });

  it('is stopped from the monitor without touching any card', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      makeSession('smoke', 2, { pid: '12345', 'state.json': { state: 'working', step: '3' } });
      expect(await stop(runRef('smoke', 2), 'stopped from the monitor', 'unused')).toBe(true);
      expect(exists(sessionDir('smoke', 2), 'pid')).toBe(false);
      expect(log()).toMatch(/smoke test 2 stopped: stopped from the monitor/);
      expect(log()).not.toMatch(/park/);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('the smoke config', () => {
  it('defaults to off, early morning, two hours', () => {
    expect(normalizeConfig(baseConfig()).smoke).toEqual({ everyDays: 0, at: '06:00', branch: '', repo: '', budgetMinutes: 120, brief: '' });
    expect(normalizeConfig(baseConfig()).models.smoke).toBe('fable');
  });

  it('keeps what was set, trims the brief, and floors the days at 0', () => {
    const smoke = normalizeConfig(baseConfig({ smoke: { everyDays: 2, at: '07:30', branch: 'release', budgetMinutes: 45, brief: '  A: x\nB: y  ' } })).smoke;
    expect(smoke).toEqual({ everyDays: 2, at: '07:30', branch: 'release', repo: '', budgetMinutes: 45, brief: 'A: x\nB: y' });
    expect(normalizeConfig(baseConfig({ smoke: { everyDays: -3 } })).smoke.everyDays).toBe(0);
  });

  it('rejects a time that is not HH:MM and a branch that is not a branch name', () => {
    expect(() => normalizeConfig(baseConfig({ smoke: { at: 'noon' } }))).toThrow(/smoke\.at/);
    expect(() => normalizeConfig(baseConfig({ smoke: { branch: 'release; rm -rf' } }))).toThrow(/smoke\.branch/);
  });
});
