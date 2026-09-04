import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cfg } from '../server/config';
import { hoursReport, monthArg } from '../server/hours';
import { clearSnapshot, setSnapshot } from '../server/runner/board-snapshot';
import { bookRun, ledgerFile, readLedger, unpublishedFile } from '../server/runner/hours';
import { checkCopy, copyStatus, publishHours } from '../server/runner/hours-copy';
import { nowSec, setDry } from '../server/runner/log';
import { BUDGET_REASON, reap, stop } from '../server/runner/run-control';
import { trackWaiting } from '../server/runner/waiting';
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
  clearSnapshot();
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
    const dir = makeSession('issue', 7, { started: String(nowSec() - 2 * HOUR), paused_total: '600', session_id: 'sid-7', 'state.json': { state: 'done', since: nowSec() } });
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
    const dir = makeSession('issue', 8, { started: String(nowSec() - 2 * HOUR), paused_total: '60', waiting_total: String(40 * 60), waiting: String(nowSec() - 600), 'state.json': { state: 'waiting', since: nowSec() } });
    const e = bookRun('issue', 8, dir, 'waiting')!;
    expect(e).toMatchObject({ pausedSeconds: 60, ending: 'waiting', billable: true });
    expect(e.waitedSeconds).toBeGreaterThanOrEqual(50 * 60);
    expect(e.waitedSeconds).toBeLessThanOrEqual(50 * 60 + 2);
    expect(e.seconds).toBeGreaterThanOrEqual(2 * HOUR - 60 - 50 * 60 - 4);
    expect(e.seconds).toBeLessThanOrEqual(2 * HOUR - 60 - 50 * 60);
    expect(readLog().join('\n')).toMatch(/booked issue-8: 1h 9m — billable \(waiting\)/);
  });

  it('ends a done or waiting run when it said so, not when the tick noticed — and a wait opened after that counts nothing', () => {
    const now = nowSec();
    // Done half an hour ago; the tick only now noticing adds nothing.
    const done = makeSession('issue', 11, { started: String(now - 2 * HOUR), 'state.json': { state: 'done', step: '9', since: now - 1800 } });
    expect(bookRun('issue', 11, done, 'done')).toMatchObject({ endedAt: now - 1800, seconds: 2 * HOUR - 1800 });
    // Asked ten minutes ago and the process died waiting: the run ended at the question, and the wait the
    // server opened after it is not subtracted twice.
    const asked = makeSession('issue', 12, { started: String(now - 2 * HOUR), waiting: String(now - 500), 'state.json': { state: 'waiting', step: 'Q', since: now - 600 } });
    expect(bookRun('issue', 12, asked, 'waiting')).toMatchObject({ endedAt: now - 600, waitedSeconds: 0, seconds: 2 * HOUR - 600 });
    // A since outside the run's life is not trusted; a run killed working has no mark of its own.
    const odd = makeSession('issue', 13, { started: String(now - HOUR), 'state.json': { state: 'done', since: now - 2 * HOUR } });
    expect(bookRun('issue', 13, odd, 'done')!.endedAt).toBeGreaterThanOrEqual(now);
    const killed = makeSession('issue', 14, { started: String(now - HOUR), 'state.json': { state: 'working', since: now - 1800 } });
    expect(bookRun('issue', 14, killed, 'budget')!.endedAt).toBeGreaterThanOrEqual(now);
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
    // Done at the question step: it asked, and waitHours passed with no answer — out of response.
    dead('issue', 4, { 'state.json': { state: 'done', step: 'Q', note: 'no answer in 2 h' } });
    await reap();
    expect(readLedger().entries.map((e) => [e.target, e.ending, e.billable])).toEqual([
      [1, 'done', true],
      [2, 'waiting', true],
      [3, 'died', false],
      [4, 'noResponse', true],
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
    // A finished run says when it finished, as a real one does; a run without a mark is capped at its budget.
    bookRun(kind, n, makeSession(kind, n, { started: String(nowSec() - hours * HOUR), ...(ending === 'done' ? { 'state.json': { state: 'done', since: nowSec() } } : {}), ...files }), ending);

  it('sums one month by issue, lists the failed runs with their reasons, and keeps the other months for the picker', async () => {
    vi.useFakeTimers();
    at('2026-08-20T10:00:00Z');
    book('issue', 1, 2, 'done');
    at('2026-09-02T10:00:00Z');
    book('issue', 1, 1, 'died');
    // The retry starts after the death, as a retry does — that is what makes the died run continued.
    at('2026-09-02T14:00:00Z');
    book('issue', 1, 3, 'done');
    book('approved', 50, 0.5, 'verdict', { issue: '1' });
    book('qa', 2, 1, 'done');
    // Issue 1's died run was taken up by the run after it — continued, half rate. Nobody came back for #3.
    book('qa', 3, 1, 'died');
    at('2026-09-03T12:00:00Z');
    const r = await hoursReport('2026-09');
    expect(r.month).toBe('2026-09');
    expect(r.billableSeconds).toBe(4.5 * HOUR);
    expect(r.continuedSeconds).toBe(HOUR);
    expect(r.excludedSeconds).toBe(HOUR);
    expect(r.runs).toBe(5);
    expect(r.totalSeconds).toBe(6.5 * HOUR);
    expect(r.totalContinuedSeconds).toBe(HOUR);
    expect(r.since).toBe(Date.parse('2026-08-20T10:00:00Z') / 1000);
    expect(r.issues.map((i) => [i.issue, i.seconds, i.runs, i.byKind, i.continuedSeconds, i.excludedSeconds])).toEqual([
      [1, 3.5 * HOUR, 2, { issue: 3 * HOUR, approved: 0.5 * HOUR }, HOUR, 0],
      [2, HOUR, 1, { qa: HOUR }, 0, 0],
      [3, 0, 0, {}, 0, HOUR],
    ]);
    const at10 = Date.parse('2026-09-02T10:00:00Z') / 1000;
    const at14 = Date.parse('2026-09-02T14:00:00Z') / 1000;
    expect(r.excluded).toEqual([
      { n: 6, kind: 'qa', target: 3, issue: 3, seconds: HOUR, ending: 'died', endedAt: at14, continued: false },
      { n: 2, kind: 'issue', target: 1, issue: 1, seconds: HOUR, ending: 'died', endedAt: at10, continued: true },
    ]);
    expect(r.months).toEqual([
      { month: '2026-09', billableSeconds: 4.5 * HOUR, continuedSeconds: HOUR, excludedSeconds: HOUR, runs: 5 },
      { month: '2026-08', billableSeconds: 2 * HOUR, continuedSeconds: 0, excludedSeconds: 0, runs: 1 },
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
    // A failed run on #9 counts as taken up only once the run alive on it now is booked billable — not yet.
    bookRun('issue', 9, makeSession('approved', 52, { started: String(nowSec() - HOUR), issue: '9' }), 'died');
    const r = await hoursReport();
    expect(r.excluded[0]).toMatchObject({ target: 9, continued: false });
    expect(r.excludedSeconds).toBeGreaterThanOrEqual(HOUR - 2);
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
    // The witness is never overwritten: no commit, no push, the marker stays.
    expect(called(/^git .* (commit-tree|push) /)).toHaveLength(0);
    expect(exists(unpublishedFile())).toBe(true);
    expect(readLog().join('\n')).toMatch(/not pushed over its copy — the copy on sloth-assets has 1 line/);
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
    expect(called(/^git .* push /)).toHaveLength(0);
    expect(readLog().join('\n')).toMatch(/not pushed while its chain is broken/);
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
    // A day of it, and the absent witness is raised — once.
    fs.writeFileSync(statePath('hours_copy.json'), JSON.stringify({ ...copyStatus(), checkedAt: nowSec() - 2 * HOUR, unreachableSince: nowSec() - 25 * HOUR }));
    resetGh();
    onCommand(/^git .* ls-remote /, { ok: false, out: '', err: 'no route' });
    await checkCopy();
    expect(posted.map((p) => p.text)).toHaveLength(1);
    expect(posted[0].text).toMatch(/the copy on sloth-assets has been out of reach for more than a day/);
    // A status file dated in the future is no check at all: the next tick compares again.
    fs.writeFileSync(statePath('hours_copy.json'), JSON.stringify({ copy: 'ok', checkedAt: nowSec() + 10 * HOUR }));
    resetGh();
    origin('abc');
    await checkCopy();
    expect(called(/^git .* ls-remote /).length).toBeGreaterThan(0);
  });
});

describe('never rounded in Sloth’s favour', () => {
  it('a run that ended without a word ended when its process exited, else at its last line of output', () => {
    const now = nowSec();
    const exited = makeSession('issue', 21, { started: String(now - HOUR), exited: String(now - 900), 'state.json': { state: 'working' } });
    expect(bookRun('issue', 21, exited, 'died')).toMatchObject({ endedAt: now - 900, seconds: HOUR - 900 });
    const logged = makeSession('issue', 22, { started: String(now - HOUR), 'run.log': 'x\n', 'state.json': { state: 'working' } });
    fs.utimesSync(path.join(logged, 'run.log'), new Date((now - 600) * 1000), new Date((now - 600) * 1000));
    expect(bookRun('issue', 22, logged, 'died')).toMatchObject({ endedAt: now - 600, seconds: HOUR - 600 });
    // An exit older than the launch belongs to an earlier run; a kill ended now, whatever the log says.
    const stale = makeSession('issue', 23, { started: String(now - HOUR), exited: String(now - 2 * HOUR), 'run.log': 'x\n' });
    fs.utimesSync(path.join(stale, 'run.log'), new Date((now - 600) * 1000), new Date((now - 600) * 1000));
    expect(bookRun('issue', 23, stale, 'died')!.endedAt).toBe(now - 600);
    expect(bookRun('issue', 23, stale, 'budget')!.endedAt).toBeGreaterThanOrEqual(now);
  });

  it('a wait begins when the session said it asked — after the launch and its last answer, never in the future', () => {
    const now = nowSec();
    const dir = makeSession('issue', 24, { started: String(now - HOUR), 'state.json': { state: 'waiting', step: 'Q', since: now - 1200 } });
    trackWaiting(dir, 24);
    expect(read(path.join(dir, 'waiting'))).toBe(String(now - 1200));
    // Before the launch, or before the answer it already got: the tick's own time.
    const early = makeSession('issue', 25, { started: String(now - HOUR), 'state.json': { state: 'waiting', since: now - 2 * HOUR } });
    trackWaiting(early, 25);
    expect(Number(read(path.join(early, 'waiting')))).toBeGreaterThanOrEqual(now);
    const answered = makeSession('issue', 26, { started: String(now - HOUR), answered: String(now - 300), 'state.json': { state: 'waiting', since: now - 600 } });
    trackWaiting(answered, 26);
    expect(Number(read(path.join(answered, 'waiting')))).toBeGreaterThanOrEqual(now);
  });

  it('a card standing in the needs-help column is waiting whatever its session says', () => {
    const now = nowSec();
    const column = cfg().statusField.columns.needsHelp.name;
    expect(column).toBeTruthy();
    const dir = makeSession('issue', 27, { started: String(now - HOUR), 'state.json': { state: 'working', step: '3', since: now - 1800 } });
    // After makeSession: the harness reloads the config, and a reload drops the board.
    setSnapshot([{ number: 27, title: 't', status: column, labels: [], assignees: [], closed: false }]);
    trackWaiting(dir, 27);
    // The session did not say it was asking, so its `since` is not the wait's start: the tick is.
    expect(Number(read(path.join(dir, 'waiting')))).toBeGreaterThanOrEqual(now);
    // A review on the same issue never parks.
    const review = makeSession('approved', 60, { started: String(now - HOUR), issue: '27', 'state.json': { state: 'working' } });
    setSnapshot([{ number: 27, title: 't', status: column, labels: [], assignees: [], closed: false }]);
    trackWaiting(review);
    expect(exists(review, 'waiting')).toBe(false);
    // Moved out of the column: the wait closes.
    setSnapshot([]);
    trackWaiting(dir, 27);
    expect(exists(dir, 'waiting')).toBe(false);
    expect(exists(dir, 'answered')).toBe(true);
  });

  it('ending a parked run whose process is gone books it as waiting', async () => {
    const now = nowSec();
    makeSession('issue', 28, { pid: DEAD, started: String(now - HOUR), 'state.json': { state: 'waiting', step: 'Q', since: now - 1800 } });
    expect(await stop('issue', 28, 'from the monitor', 'x')).toBe(true);
    expect(readLedger().entries.map((e) => [e.target, e.ending, e.billable, e.seconds])).toEqual([[28, 'waiting', true, 1800]]);
    expect(exists(sessionDir('issue', 28), 'pid')).toBe(false);
  });
});

describe('what takes a failed run up', () => {
  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  const book = (kind: 'issue' | 'approved' | 'qa', n: number, hours: number, ending: 'done' | 'died' | 'verdict', files: Record<string, string> = {}) =>
    // A finished run says when it finished, as a real one does; a run without a mark is capped at its budget.
    bookRun(kind, n, makeSession(kind, n, { started: String(nowSec() - hours * HOUR), ...(ending === 'done' ? { 'state.json': { state: 'done', since: nowSec() } } : {}), ...files }), ending);
  const continuedOf = async (month: string) => (await hoursReport(month)).excluded.map((e) => [e.n, e.continued]);

  it('only a billable run that started after the failure, within the window, and did not start over', async () => {
    vi.useFakeTimers();
    at('2026-09-01T10:00:00Z');
    book('issue', 1, 1, 'died'); // n1: followed by another failure only
    book('issue', 2, 1, 'died'); // n2: followed by a run that started over
    book('issue', 3, 1, 'died'); // n3: followed by a review's verdict — taken up
    book('issue', 4, 1, 'died'); // n4: taken up 31 days later — outside the window
    book('issue', 5, 1, 'died'); // n5: a live run on the card counts for nothing yet
    at('2026-09-01T12:00:00Z');
    book('issue', 1, 1, 'died');
    book('issue', 2, 1, 'done', { started_fresh: '1' });
    book('approved', 30, 0.5, 'verdict', { issue: '3' });
    makeSession('issue', 5, { pid: alivePid(), started: String(nowSec() - 600) });
    at('2026-10-02T12:00:00Z');
    book('issue', 4, 1, 'done');
    // Newest first; the five that ended together keep their booking order.
    expect(await continuedOf('2026-09')).toEqual([
      [6, false],
      [1, false],
      [2, false],
      [3, true],
      [4, false],
      [5, false],
    ]);
    const r = await hoursReport('2026-09');
    expect(r.continuedSeconds).toBe(HOUR);
    expect(r.excludedSeconds).toBe(5 * HOUR);
    expect(r.issues.find((i) => i.issue === 2)).toMatchObject({ seconds: HOUR, continuedSeconds: 0, excludedSeconds: HOUR });
    expect(readLedger().entries.find((e) => e.target === 2 && e.ending === 'done')?.fresh).toBe(true);
  });
});

describe('booked once, and never more than it could have lived', () => {
  it('ending a parked run reap already booked does not book it again', async () => {
    const now = nowSec();
    makeSession('issue', 31, { pid: DEAD, started: String(now - HOUR), 'state.json': { state: 'waiting', step: 'Q', since: now - 1800 } });
    await reap();
    expect(readLedger().entries).toHaveLength(1);
    expect(await stop('issue', 31, 'from the monitor', 'x')).toBe(true);
    expect(readLedger().entries).toHaveLength(1);
  });

  it('a state nobody defined is a run that died working, not a question', async () => {
    makeSession('issue', 32, { pid: DEAD, started: String(nowSec() - HOUR), 'state.json': { state: 'blocked', since: nowSec() - 60 }, 'run.log': 'x\n' });
    await reap();
    expect(readLedger().entries[0]).toMatchObject({ target: 32, ending: 'died', billable: false });
  });

  it('a dry tick books nothing and forgets nothing, so the real tick books the run once', async () => {
    const dir = makeSession('issue', 33, { pid: DEAD, started: String(nowSec() - HOUR), waiting_total: '600', 'state.json': { state: 'done' } });
    setDry(true);
    await reap();
    expect(exists(dir, 'pid')).toBe(true);
    expect(exists(dir, 'waiting_total')).toBe(true);
    setDry(false);
    await reap();
    expect(readLedger().entries.map((e) => [e.target, e.waitedSeconds])).toEqual([[33, 600]]);
    expect(exists(dir, 'pid')).toBe(false);
  });

  it('with no mark at all, a run ended no later than its budget and the kill grace allow', () => {
    const now = nowSec();
    const dir = makeSession('issue', 34, { started: String(now - 3 * HOUR) });
    expect(bookRun('issue', 34, dir, 'died')!.endedAt).toBe(now - 3 * HOUR + cfg().budgetMinutes * 60 + 5 * 60);
    // The earliest honest mark wins over a later one.
    const marked = makeSession('issue', 35, { started: String(now - HOUR), exited: String(now - 300), 'state.json': { state: 'done', since: now - 900 } });
    expect(bookRun('issue', 35, marked, 'done')!.endedAt).toBe(now - 900);
  });
});
