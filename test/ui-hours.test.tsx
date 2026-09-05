// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HoursReport } from '../server/types';
import HoursPanel, { shiftMonth } from '../src/components/HoursPanel';

/** The hook is the seam: the panel is tested on what the server would answer, not on how it is fetched. */
const asked: string[] = [];
let answer: HoursReport | undefined;
vi.mock('../src/hooks/use-hours', () => ({
  default: (month: string) => {
    asked.push(month);
    return { data: answer, error: undefined };
  },
}));

afterEach(() => {
  cleanup();
  asked.length = 0;
});

const H = 3600;
const report = (over: Partial<HoursReport> = {}): HoursReport => ({
  month: '2026-09',
  months: [{ month: '2026-09', billableSeconds: 4.5 * H, continuedSeconds: H, excludedSeconds: 0.5 * H, runs: 5 }],
  billableSeconds: 4.5 * H,
  continuedSeconds: H,
  excludedSeconds: 0.5 * H,
  runs: 5,
  issues: [
    { repo: 'acme/widgets', issue: 1, title: 'Login screen', seconds: 3.5 * H, runs: 2, byKind: { issue: 3 * H, approved: 0.5 * H }, continuedSeconds: H, excludedSeconds: 0, lastAt: 1 },
    { repo: 'acme/widgets', issue: 2, title: 'Logout', seconds: H, runs: 1, byKind: { qa: H }, continuedSeconds: 0, excludedSeconds: 0, lastAt: 1 },
    { repo: 'acme/widgets', issue: 4, title: 'Search', seconds: 0, runs: 0, byKind: {}, continuedSeconds: 0, excludedSeconds: 0.5 * H, lastAt: 1 },
  ],
  excluded: [
    { n: 2, kind: 'issue', target: 1, repo: 'acme/widgets', issue: 1, seconds: H, ending: 'died', endedAt: Date.parse('2026-09-02T10:00:00Z') / 1000, continued: true },
    { n: 5, kind: 'issue', target: 4, repo: 'acme/widgets', issue: 4, seconds: 0.5 * H, ending: 'budget', endedAt: Date.parse('2026-09-02T11:00:00Z') / 1000, continued: false },
  ],
  live: [{ kind: 'issue', target: 3, repo: 'acme/widgets', issue: 3, seconds: 0.4 * H }],
  totalSeconds: 6.5 * H,
  totalContinuedSeconds: H,
  since: Date.parse('2026-08-20T10:00:00Z') / 1000,
  integrity: { chain: 'ok', copy: 'ok', checkedAt: 1 },
  ...over,
});

describe('shiftMonth', () => {
  it('moves by calendar months across a year end', () => {
    expect(shiftMonth('2026-09', -1)).toBe('2026-08');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
  });
});

describe('HoursPanel', () => {
  it('shows the month’s billable hours by issue, the failed runs under a fold, and what runs now', async () => {
    answer = report();
    render(<HoursPanel repo="acme/widgets" />);
    expect(asked).toEqual(['']);
    expect(screen.getByText('4.5 h')).toBeTruthy();
    expect(screen.getByText('6.5 h')).toBeTruthy();
    expect(screen.getByText('Login screen')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#2' }).getAttribute('href')).toBe('https://github.com/acme/widgets/issues/2');
    expect(screen.getByText('ledger intact')).toBeTruthy();
    expect(screen.getByText(/running now:/)).toBeTruthy();
    // The continued hours stand apart in the headline; the failed runs are behind the fold, each with how it
    // ended and whether a later run took it up.
    expect(screen.getByText(/continued at half rate/)).toBeTruthy();
    await userEvent.click(screen.getByText('2 failed runs'));
    expect(screen.getByText('died while working')).toBeTruthy();
    expect(screen.getByText('taken up by a later run · half rate')).toBeTruthy();
    expect(screen.getByText('hung past its budget')).toBeTruthy();
    expect(screen.getByText('not billed')).toBeTruthy();
  });

  it('pages by month, never past this one', async () => {
    answer = report({ month: new Date().toISOString().slice(0, 7) });
    render(<HoursPanel repo="acme/widgets" />);
    const next = screen.getByRole('button', { name: 'next month' });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'previous month' }));
    expect(asked.at(-1)).toBe(shiftMonth(answer.month, -1));
  });

  it('says so when nothing ended in the month, and when the record cannot be trusted', () => {
    answer = report({ runs: 0, issues: [], excluded: [], live: [], integrity: { chain: 'broken', copy: 'ok', problem: 'line 2 was changed after it was written' } });
    render(<HoursPanel repo="acme/widgets" />);
    expect(screen.getByText(/No run ended in/)).toBeTruthy();
    expect(screen.getByText('ledger tampered').getAttribute('title')).toBe('line 2 was changed after it was written');
  });
});
