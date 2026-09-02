// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Card from '../src/components/Board/Card';
import type { BoardCard } from '../server/types';

afterEach(cleanup);

/**
 * The board card's answer to "why is nothing happening?" — the one line the loop used to keep to
 * itself. It has to be on the card without making the card taller than the ones around it, which is
 * why the sentence is also the `title`: truncated in the column, whole on a hover.
 */

const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  issue: 42,
  title: 'Add a health check',
  assignees: [],
  labels: [],
  closed: false,
  retries: 0,
  cost: null,
  ...over,
});

describe('a board card with a hold', () => {
  const hold = 'Sloth is paused — it starts no new work until you resume it.';

  it('shows the reason and carries the whole sentence in its title', () => {
    render(<Card card={card({ hold })} role="pickup" onSelect={() => {}} />);
    const line = screen.getByText(hold);
    expect(line.getAttribute('title')).toBe(hold);
    // Truncated rather than wrapped: a column of cards stays readable.
    expect(line.className).toContain('truncate');
  });

  it('says nothing at all when Sloth is free to work on the card', () => {
    render(<Card card={card()} role="pickup" onSelect={() => {}} />);
    expect(screen.queryByTitle(hold)).toBeNull();
    expect(screen.getByText('Add a health check')).toBeTruthy();
  });

  it('keeps the hold beside everything else the card already says', () => {
    render(<Card card={card({ hold, blocked: 'its QA test died 3 times.', retries: 2, sessionId: 'x', cost: 1.5 })} role="qa" onSelect={() => {}} />);
    expect(screen.getByText(hold)).toBeTruthy();
    expect(screen.getByText('blocked')).toBeTruthy();
    expect(screen.getByText('retries 2')).toBeTruthy();
  });
});
