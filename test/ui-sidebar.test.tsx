// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Sidebar from '../src/components/Sidebar';
import type { SessionSummary } from '../server/types';

afterEach(cleanup);

/**
 * What a run cost, on its row in the session list. It is the same list-price estimate the board header
 * and the session header already show, and a run whose model nobody has a price for shows nothing
 * rather than a zero — a `$0.00` beside a session that spent an hour is worse than no number.
 */

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 });

const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({
    id: 'sess',
    prompt: '',
    kind: 'sloth:implement',
    target: 42,
    status: 'done',
    live: false,
    agents: [],
    agentsUsage: usage(),
    usage: usage(),
    byModel: [],
    toolCounts: {},
    turns: 0,
    contextTokens: 1234,
    lastText: '',
    cost: 1.5,
    ...over,
  }) as SessionSummary;

const sidebar = (s: SessionSummary) => render(<Sidebar open sessions={[s]} selected={null} onSelect={() => {}} />);

describe('the session list', () => {
  it('shows what the run cost, as money', () => {
    sidebar(session({ cost: 12.3 }));
    expect(screen.getByText('$12.30')).toBeTruthy();
  });

  it('prints the cents of a small run rather than rounding it away', () => {
    sidebar(session({ cost: 0.07 }));
    expect(screen.getByText('$0.07')).toBeTruthy();
  });

  it('shows nothing where the run is unpriced', () => {
    const { container } = sidebar(session({ cost: null }));
    expect(container.textContent).not.toContain('$');
  });

  it('leaves a free run at zero on the row — that is a price, not a missing one', () => {
    sidebar(session({ cost: 0 }));
    expect(screen.getByText('$0.00')).toBeTruthy();
  });
});
