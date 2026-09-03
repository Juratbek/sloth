import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hoursReport, monthArg } from '../server/hours';
import { bookRun, ledgerFile, readLedger, unpublishedFile } from '../server/runner/hours';
import { checkCopy, copyStatus, publishHours } from '../server/runner/hours-copy';
import { nowSec, setDry } from '../server/runner/log';
import { BUDGET_REASON, reap, stop } from '../server/runner/run-control';
import { resetSpawn } from './child-process-mock';
import { called, onCommand, onGh, resetGh } from './gh-mock';
import { alivePid, configure, exists, makeSession, read, readLog, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/** A pid no process has — above every platform's ceiling, so `process.kill(pid, 0)` says no. */
const DEAD = '4000000';
const HOUR = 3600;

const posted: { event: string; text: string }[] = [];

beforeEach(() => {
  configure({ helpWebhook: 'https://hooks.example.com/x', webhookEvents: ['hoursTampered'], budgetMinutes: 60 });
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
  posted.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return { ok: true, status: 200, statusText: 'OK' };
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const lines = () => read(ledgerFile()).trimEnd().split('\n');

describe('bookRun', () => {
  it('books the run’s own seconds — launched to now, less the time it stood paused — and chains onto the line before', () => {
    const dir = makeSession('issue', 7, { started: String(nowSec() - 2 * HOUR), paused_total: '600', session_id: 'sid-7' });
    const first = bookRun('issue', 7, dir, 'done')!;
    expect(first).toMatchObject({ n: 1, kind: 'issue', target: 7, issue: 7, sessionId: 'sid-7', pausedSeconds: 600, waitedSeconds: 0, ending: 'done', billable: true, prev: '' });
    expect(first.seconds).toBeGreaterThanOrEqual(2 * HOUR - 600 - 2);
    expect(first.seconds).toBeLessThanOrEqual(2 * HOUR - 600);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    // A review's issue is the one written beside it; a failed ending is booked, and not billed.
    const review = makeSession('approved', 30, { started: String(nowSec() - HOUR), issue: '7' });
    const second = bookRun('approved', 30, review, 'died')!;
    expect(second).toMatchObject({ n: 2, issue: 7, billable: false, prev: first.hash });
    expect(readLedger()).toEqual({ entries: [first, second] });
    expect(read(unpublishedFile())).toBe('2');
    expect(readLog().join('\n')).toMatch(/booked issue-7: 1h 50m — billable \(done\)/);
    expect(readLog().join('\n')).toMatch(/booked approved-30: 1h 0m — not billable \(died\)/);
  });

  it('credits back the time a run sat in needs-help waiting for an answer — booked and still open', () => {
    // Answered once (40 min credited), asked again 10 minutes ago and still waiting: neither is worked time.
    const dir = makeSession('issue', 8, { started: String(nowSec() - 2 * HOUR), paused_total: '60', waiting_total: String(40 * 60), waiting: String(nowSec() - 600) });
    const e = bookRun('issue', 8, dir, 'waiting')!;
    expect(e).toMatchObject({ pausedSeconds: 60, ending: 'waiting', billable: true });
    expect(e.waitedSeconds).toBeGreaterThanOrEqual(50 * 60);
    expect(e.waitedSeconds).toBeLessThanOrEqual(50 * 60 + 2);
    expect(e.seconds).toBeGreaterThanOrEqual(2 * HOUR - 60 - 50 * 60 - 4);
    expect(e.seconds).toBeLessThanOrEqual(2 * HOUR - 60 - 50 * 60);
    expect(readLog().join('\n')).toMatch(/booked issue-8: 1h 9m — billable \(waiting\)/);
  });

  it('books nothing on a dry tick', () => {
    setDry(true);
    const dir = makeSession('issue', 7, { started: String(nowSec() - HOUR) });
    expect(bookRun('issue', 7, dir, 'done')).toBeUndefined();
    expect(exists(ledgerFile())).toBe(false);
    expect(readLog().join('\n')).toMatch(/dry-run: would book issue-7/);
  });
});

describe('readLedger', () => {
  const three = () => {
    for (const n of [1, 2, 3]) bookRun('issue', n, makeSession('issue', n, { started: String(nowSec() - HOUR) }), 'done');
  };
  it('reads a whole ledger back', () => {
    three();
    expect(readLedger().entries.map((e) => e.n)).toEqual([1, 2, 3]);
  });
  it('sees a changed line', () => {
    three();
    const [a, b, c] = lines();
    fs.writeFileSync(ledgerFile(), `${a}\n${b.replace('"seconds":', '"seconds":1,"was":')}\n${c}\n`);
    const { entries, problem } = readLedger();
    expect(entries.map((e) => e.n)).toEqual([1]);
    expect(problem).toBe('line 2 was changed after it was written');
  });
  it('sees a removed line', () => {
    three();
    const [, b, c] = lines();
    fs.writeFileSync(ledgerFile(), `${b}\n${c}\n`);
    expect(readLedger().problem).toBe('line 1 is numbered 2 — 1 line(s) before it were removed');
  });
  it('sees a line slipped in, and a line that is not an entry', () => {
    three();
    const [a, b, c] = lines();
    fs.writeFileSync(ledgerFile(), `${a}\n${a}\n${b}\n${c}\n`);
    expect(readLedger().problem).toBe('line 2 is numbered 1 — a line was inserted before it');
    fs.writeFileSync(ledgerFile(), `${a}\nnot json\n${c}\n`);
    expect(readLedger().problem).toBe('line 2 is not a ledger entry');
  });
  it('chains a new line onto the last one even after a break, so the break stays where it was', () => {
    three();
    const [a, , c] = lines();
    fs.writeFileSync(ledgerFile(), `${a}\n${c}\n`);
    bookRun('issue', 4, makeSession('issue', 4, { started: String(nowSec() - HOUR) }), 'done');
    const { entries, problem } = readLedger();
    expect(entries).toHaveLength(1);
    expect(problem).toMatch(/^line 2 is numbered 3/);
    expect(lines()).toHaveLength(3);
    expect(JSON.parse(lines()[2])).toMatchObject({ n: 4, prev: JSON.parse(c).hash });
  });
});

describe('reap books every ending', () => {
  const dead = (kind: 'issue' | 'approved' | 'qa', n: number, files: Record<string, string | object>) =>
    makeSession(kind, n, { pid: DEAD, started: String(nowSec() - HOUR), ...files });

  it('done and waiting are billable; a run that died working is not', async () => {
    dead('issue', 1, { 'state.json': { state: 'done' } });
    dead('issue', 2, { 'state.json': { state: 'waiting', step: '3' } });
    dead('issue', 3, { 'state.json': { state: 'working', step: '4' }, 'run.log': 'x\n' });
    await reap();
    expect(readLedger().entries.map((e) => [e.target, e.ending, e.billable])).toEqual([
      [1, 'done', true],
      [2, 'waiting', true],
      [3, 'died', false],
    ]);
    // The pid and the pause files are gone all the same.
    expect(exists(sessionDir('issue', 3), 'pid')).toBe(false);
  });

  it('a review that ended working with its verdict on the PR is billable; a usage-limit exit is not', async () => {
    dead('approved', 40, { 'state.json': { state: 'working' }, sha: 'abc123', issue: '5' });
    onGh(/pullRequest\(number: 40\)/, { data: { repository: { pullRequest: { reviews: { nodes: [{ body: '**Sloth:**\nReview: **passed** — 8/10.', commit: { oid: 'abc123' } }] } } } } });
    dead('issue', 6, { 'state.json': { state: 'working' }, 'run.log': 'Claude AI usage limit reached|1\n' });
    await reap();
    const byTarget = Object.fromEntries(readLedger().entries.map((e) => [e.target, e]));
    expect(byTarget[40]).toMatchObject({ kind: 'approved', issue: 5, ending: 'verdict', billable: true });
    expect(byTarget[6]).toMatchObject({ ending: 'usageLimit', billable: false });
  });

  it('a run the machine rebooted under is booked as such', async () => {
    const dir = dead('issue', 8, { 'state.json': { state: 'working' } });
    // A pid file older than the boot: what a reboot leaves behind.
    const old = new Date(0);
    fs.utimesSync(path.join(dir, 'pid'), old, old);
    await reap();
    expect(readLedger().entries[0]).toMatchObject({ target: 8, ending: 'rebooted', billable: false });
  });

  it('a dry tick books nothing', async () => {
    setDry(true);
    dead('issue', 1, { 'state.json': { state: 'done' } });
    await reap();
    expect(exists(ledgerFile())).toBe(false);
  });
});

describe('stop books the kill', () => {
  it('from the monitor as stopped, past the budget as budget — neither billable', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      makeSession('issue', 7, { pid: '12345', started: String(nowSec() - HOUR), 'state.json': { state: 'working' } });
      makeSession('qa', 9, { pid: '12346', started: String(nowSec() - 2 * HOUR), 'state.json': { state: 'working' } });
      onGh(/project item-add/, 'ITEM');
      expect(await stop('issue', 7, 'stopped from the monitor', 'a human stopped this run.')).toBe(true);
      expect(await stop('qa', 9, BUDGET_REASON, 'hung.')).toBe(true);
      expect(readLedger().entries.map((e) => [e.kind, e.target, e.ending, e.billable])).toEqual([
        ['issue', 7, 'stopped', false],
        ['qa', 9, 'budget', false],
      ]);
      expect(readLedger().entries[1].seconds).toBeGreaterThanOrEqual(2 * HOUR - 2);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('hoursReport', () => {
  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  const book = (kind: 'issue' | 'approved' | 'qa', n: number, hours: number, ending: 'done' | 'died' | 'verdict', files: Record<string, string> = {}) =>
    bookRun(kind, n, makeSession(kind, n, { started: String(nowSec() - hours * HOUR), ...files }), ending);

  it('sums one month by issue, lists the failed runs with their reasons, and keeps the other months for the picker', async () => {
    vi.useFakeTimers();
    at('2026-08-20T10:00:00Z');
    book('issue', 1, 2, 'done');
    at('2026-09-02T10:00:00Z');
    book('issue', 1, 1, 'died');
    book('issue', 1, 3, 'done');
    book('approved', 50, 0.5, 'verdict', { issue: '1' });
    book('qa', 2, 1, 'done');
    at('2026-09-03T12:00:00Z');
    const r = await hoursReport('2026-09');
    expect(r.month).toBe('2026-09');
    expect(r.billableSeconds).toBe(4.5 * HOUR);
    expect(r.excludedSeconds).toBe(HOUR);
    expect(r.runs).toBe(4);
    expect(r.totalSeconds).toBe(6.5 * HOUR);
    expect(r.since).toBe(Date.parse('2026-08-20T10:00:00Z') / 1000);
    expect(r.issues.map((i) => [i.issue, i.seconds, i.runs, i.byKind, i.excludedSeconds])).toEqual([
      [1, 3.5 * HOUR, 2, { issue: 3 * HOUR, approved: 0.5 * HOUR }, HOUR],
      [2, HOUR, 1, { qa: HOUR }, 0],
    ]);
    expect(r.excluded).toEqual([{ n: 2, kind: 'issue', target: 1, issue: 1, seconds: HOUR, ending: 'died', endedAt: Date.parse('2026-09-02T10:00:00Z') / 1000 }]);
    expect(r.months).toEqual([
      { month: '2026-09', billableSeconds: 4.5 * HOUR, excludedSeconds: HOUR, runs: 4 },
      { month: '2026-08', billableSeconds: 2 * HOUR, excludedSeconds: 0, runs: 1 },
    ]);
    expect(r.integrity).toEqual({ chain: 'ok', copy: 'unchecked', problem: undefined, checkedAt: undefined });
    // August on its own; a month with nothing is empty, not an error; a bad month is this one.
    expect((await hoursReport('2026-08')).billableSeconds).toBe(2 * HOUR);
    expect(await hoursReport('2026-07')).toMatchObject({ month: '2026-07', runs: 0, issues: [], totalSeconds: 6.5 * HOUR });
    expect(monthArg('2026-13')).toBe('2026-09');
    expect(monthArg(null)).toBe('2026-09');
  });

  it('shows the runs still going, with their seconds so far, and a broken chain', async () => {
    makeSession('issue', 9, { pid: alivePid(), started: String(nowSec() - 600), paused_total: '60', waiting: String(nowSec() - 30) });
    makeSession('approved', 51, { pid: alivePid(), started: String(nowSec() - 300), issue: '9' });
    makeSession('issue', 10, { pid: DEAD, started: String(nowSec() - 600) });
    const r = await hoursReport();
    expect(r.live.map((l) => [l.kind, l.target, l.issue])).toEqual([
      ['issue', 9, 9],
      ['approved', 51, 9],
    ]);
    expect(r.live[0].seconds).toBeGreaterThanOrEqual(508);
    expect(r.live[0].seconds).toBeLessThanOrEqual(510);
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
    fs.writeFileSync(ledgerFile(), 'garbage\n');
    expect((await hoursReport()).integrity).toMatchObject({ chain: 'broken', problem: 'line 1 is not a ledger entry' });
  });
});

describe('the copy on the assets branch', () => {
  /** Origin with the branch at `head` holding `remote` as the ledger; no branch when `head` is empty. */
  const origin = (head: string, remote = '') => {
    onCommand(/^git .* ls-remote /, head ? `${head}\trefs/heads/sloth-assets` : '');
    onCommand(/^git .* rev-parse /, head);
    onCommand(/^git .* hash-object /, 'blob1');
    onCommand(/^git .* write-tree$/, 'tree1');
    onCommand(/^git .* commit-tree /, 'commit1');
    onCommand(/^git .* show /, remote);
  };
  const booked = () => bookRun('issue', 1, makeSession('issue', 1, { started: String(nowSec() - HOUR) }), 'done')!;

  it('commits the ledger on top of the branch out of its own index, and pushes it', async () => {
    booked();
    origin('abc');
    expect(await publishHours()).toBe(true);
    const git = called(/^git /).map((c) => c.args.slice(2).join(' '));
    expect(git).toContain('read-tree abc');
    expect(git).toContain(`hash-object -w ${ledgerFile()}`);
    expect(git).toContain('update-index --add --cacheinfo 100644,blob1,hours/ledger.jsonl');
    expect(git).toContain('commit-tree tree1 -p abc -m hours: run 1 booked');
    expect(git).toContain('push -q origin commit1:refs/heads/sloth-assets');
    expect(exists(unpublishedFile())).toBe(false);
    expect(exists(statePath('hours.index'))).toBe(false);
    expect(readLog().join('\n')).toMatch(/ledger copied to sloth-assets \(1 runs booked\)/);
  });

  it('starts the branch when there is none, and keeps the marker when origin cannot be reached', async () => {
    booked();
    origin('');
    expect(await publishHours()).toBe(true);
    expect(called(/^git .* commit-tree tree1 -m /)).toHaveLength(1);
    expect(called(/read-tree/)).toHaveLength(0);
    booked();
    resetGh();
    onCommand(/^git .* ls-remote /, { ok: false, out: '', err: 'could not resolve host' });
    expect(await publishHours()).toBe(false);
    expect(read(unpublishedFile())).toBe('2');
    expect(readLog().join('\n')).toMatch(/origin could not be reached/);
  });

  it('retries a push that lost the race to a session, then gives up until the next tick', async () => {
    booked();
    origin('abc');
    onCommand(/^git .* push /, { ok: false, out: '', err: 'rejected: fetch first' });
    expect(await publishHours()).toBe(false);
    expect(called(/^git .* push /)).toHaveLength(3);
    expect(exists(unpublishedFile())).toBe(true);
  });

  it('checkCopy pushes what waits, then finds the copy equal, behind or diverged — and raises diverged once', async () => {
    const e = booked();
    origin('abc', JSON.stringify(e));
    await checkCopy();
    expect(called(/^git .* push /)).toHaveLength(1);
    expect(copyStatus()).toMatchObject({ copy: 'ok' });
    expect(posted).toEqual([]);

    // Behind: the branch has the first line only after a second run was booked and nothing pushed yet.
    resetGh();
    booked();
    onCommand(/^git .* push /, { ok: false, out: '', err: 'offline' });
    origin('abc', JSON.stringify(e));
    await checkCopy();
    expect(copyStatus()).toMatchObject({ copy: 'behind' });
    expect(posted).toEqual([]);

    // Diverged: the branch holds a line the file no longer has.
    resetGh();
    fs.writeFileSync(ledgerFile(), `${JSON.stringify(e)}\n`);
    origin('abc', `${JSON.stringify(e)}\n${JSON.stringify({ ...e, n: 2 })}`);
    fs.writeFileSync(unpublishedFile(), '2');
    await checkCopy();
    expect(copyStatus()).toMatchObject({ copy: 'diverged', problem: 'the copy on sloth-assets has 1 line(s) the ledger no longer has' });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ event: 'hoursTampered', text: expect.stringContaining('has 1 line(s) the ledger no longer has') });
    expect((await hoursReport()).integrity).toMatchObject({ chain: 'ok', copy: 'diverged', problem: expect.stringContaining('no longer has') });
    // The same problem is not raised twice; a different line is a different problem.
    fs.writeFileSync(unpublishedFile(), '2');
    await checkCopy();
    expect(posted).toHaveLength(1);
    fs.writeFileSync(ledgerFile(), `${JSON.stringify({ ...e, seconds: 1 })}\n`);
    fs.writeFileSync(unpublishedFile(), '2');
    await checkCopy();
    expect(posted).toHaveLength(2);
    expect(posted[1].text).toContain('line 1 was changed after it was written (local file)');
  });

  it('is quiet between checks, and unreachable origin is said but not raised', async () => {
    booked();
    origin('abc');
    await checkCopy();
    resetGh();
    origin('abc');
    await checkCopy();
    expect(called(/^git /)).toHaveLength(0);
    // Forced by a pending push, origin gone: a warning, no alarm.
    fs.writeFileSync(unpublishedFile(), '1');
    onCommand(/^git .* ls-remote /, { ok: false, out: '', err: 'no route' });
    resetGh();
    onCommand(/^git .* ls-remote /, { ok: false, out: '', err: 'no route' });
    await checkCopy();
    expect(copyStatus()).toMatchObject({ copy: 'unreachable' });
    expect(posted).toEqual([]);
  });
});
