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
  months: [{ month: '2026-09', billableSeconds: 4.5 * H, excludedSeconds: H, runs: 4 }],
  billableSeconds: 4.5 * H,
  excludedSeconds: H,
  runs: 4,
  issues: [
    { issue: 1, title: 'Login screen', seconds: 3.5 * H, runs: 2, byKind: { issue: 3 * H, approved: 0.5 * H }, excludedSeconds: H, lastAt: 1 },
    { issue: 2, title: 'Logout', seconds: H, runs: 1, byKind: { qa: H }, excludedSeconds: 0, lastAt: 1 },
  ],
  excluded: [{ n: 2, kind: 'issue', target: 1, issue: 1, seconds: H, ending: 'died', endedAt: Date.parse('2026-09-02T10:00:00Z') / 1000 }],
  live: [{ kind: 'issue', target: 3, issue: 3, seconds: 0.4 * H }],
  totalSeconds: 6.5 * H,
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
    // The failed run is behind the fold, with the reason it is not billed.
    await userEvent.click(screen.getByText('1 failed run not billed'));
    expect(screen.getByText('died while working')).toBeTruthy();
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
