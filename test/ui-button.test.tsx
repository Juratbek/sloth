// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Button from '../src/components/ui/Button';
import Chip from '../src/components/ui/Chip';
import ErrorNote from '../src/components/ui/ErrorNote';

afterEach(cleanup);

/**
 * The three primitives every other component is built out of. Size and variant are separate class sets
 * on purpose — two Tailwind utilities of one family in the same list are settled by the order of the
 * generated stylesheet, not by the order they are written in — so what matters is that each lands.
 */

describe('Button', () => {
  it('is a plain button unless it is asked to submit — a default of "submit" posts the form it sits in', () => {
    render(<Button>Tick</Button>);
    expect(screen.getByRole('button', { name: 'Tick' }).getAttribute('type')).toBe('button');
    cleanup();
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('submit');
  });

  it('wears the variant and the size it was given, and the caller’s className beside them', () => {
    render(
      <Button variant="danger" size="inline" className="ml-auto">
        Stop
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Stop' });
    expect(button.className).toContain('border-red-900'); // danger
    expect(button.className).toContain('text-[11px]'); // inline
    expect(button.className).toContain('ml-auto');
  });

  it('falls back to the outline button in a form, which is what most of the UI wants', () => {
    render(<Button>Install</Button>);
    const button = screen.getByRole('button', { name: 'Install' });
    expect(button.className).toContain('border-zinc-800'); // ghost
    expect(button.className).toContain('text-sm'); // form
  });

  it('does not fire while disabled, and says as much to the browser', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Tick
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Tick' });
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires once per click when it is not', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Tick</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Tick' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('carries the labels a glyph button needs to be readable at all', () => {
    render(
      <Button variant="icon" aria-label="Settings" aria-expanded={false} title="Settings">
        ⚙
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Settings' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('title')).toBe('Settings');
  });
});

describe('Chip', () => {
  it('says one fact, with the dim label in front of it when it has one', () => {
    render(
      <Chip label="sessions" tone="emerald" size="xs" title="two working">
        2 working
      </Chip>,
    );
    const chip = screen.getByTitle('two working');
    expect(chip.textContent).toBe('sessions 2 working');
    expect(chip.className).toContain('border-emerald-900');
    expect(chip.className).toContain('text-[10px]');
  });

  it('is never a button — nothing about it is pressable', () => {
    render(<Chip>opus</Chip>);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ErrorNote', () => {
  it('is nothing at all while nothing has gone wrong, so the layout does not move', () => {
    const { container } = render(<ErrorNote error={undefined} />);
    expect(container.innerHTML).toBe('');
    cleanup();
    expect(render(<ErrorNote error={null} />).container.innerHTML).toBe('');
    cleanup();
    expect(render(<ErrorNote error="" />).container.innerHTML).toBe('');
  });

  it('says what the server said, as an alert a screen reader hears without going looking', () => {
    render(<ErrorNote error={new Error('the tunnel is not up')} />);
    const note = screen.getByRole('alert');
    expect(note.textContent).toBe('the tunnel is not up'); // no "Error:" in front of it
    expect(note.className).toContain('text-red-400');
  });

  it('shows a thrown string and an unhelpful object rather than swallowing either', () => {
    render(<ErrorNote error="pause refused" />);
    expect(screen.getByRole('alert').textContent).toBe('pause refused');
    cleanup();
    render(<ErrorNote error={{ message: 'no space left on device' }} />);
    expect(screen.getByRole('alert').textContent).toBe('no space left on device');
  });
});
