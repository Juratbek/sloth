// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Modal from '../src/components/ui/Modal';
import Button from '../src/components/ui/Button';

/**
 * The dialog both of Sloth's modals sit in. Before it they were a `fixed inset-0` div with
 * `role="dialog"` and nothing else: a screen reader was never told the page behind had gone, Escape did
 * nothing, and Tab walked straight out into the header behind — where the button that opened the dialog
 * still had the focus ring. So the behaviour under test is the keyboard's, not the markup's.
 */

/**
 * jsdom has no layout, so `offsetParent` is null on everything and the `focusable()` filter would throw
 * away every element in the dialog. This stands in for what that filter is really asking — "is this on
 * the page and not hidden" — so the focus trap can be exercised at all.
 */
const realOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hidden || this.style.display === 'none' ? null : this.parentElement;
    },
  });
});
afterAll(() => {
  if (realOffsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', realOffsetParent);
});
afterEach(cleanup);

/** The page as it is when a dialog is opened: an opener button that keeps the focus, and the dialog. */
function Page({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <button type="button">Open</button>
      {open && (
        <Modal title="Stop the session" onClose={onClose} footer={<Button onClick={() => undefined}>Confirm</Button>}>
          <input aria-label="Reason" />
        </Modal>
      )}
    </>
  );
}

/** An open dialog on that page, and the handles a test wants on it. */
function open(onClose = vi.fn()) {
  const view = render(<Page open onClose={onClose} />);
  const dialog = screen.getByRole('dialog');
  return {
    onClose,
    dialog,
    backdrop: dialog.parentElement!,
    close: screen.getByRole('button', { name: 'Close' }),
    reason: screen.getByLabelText('Reason'),
    confirm: screen.getByRole('button', { name: 'Confirm' }),
    rerender: view.rerender,
  };
}

describe('Modal, to a screen reader', () => {
  it('is a modal dialog named by its own title', () => {
    const { dialog } = open();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The name comes from the heading through `aria-labelledby`, so it cannot drift from what is shown.
    expect(screen.getByRole('dialog', { name: 'Stop the session' })).toBe(dialog);
    expect(screen.getByRole('heading', { name: 'Stop the session' }).id).toBe(dialog.getAttribute('aria-labelledby'));
  });
});

describe('Modal, closing', () => {
  it('closes on Escape, wherever inside it the focus is', async () => {
    const { onClose, reason } = open();
    reason.focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a click on the backdrop', async () => {
    const { onClose, backdrop } = open();
    await userEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on a click inside it — a click is not a miss just because it missed a control', async () => {
    const { onClose, dialog, reason } = open();
    await userEvent.click(dialog);
    await userEvent.click(reason);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on the ✕', async () => {
    const { onClose, close } = open();
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Modal, the focus', () => {
  it('moves inside on open and goes back to the opener on close', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Page open={false} onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();

    rerender(<Page open onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));

    rerender(<Page open={false} onClose={onClose} />);
    expect(document.activeElement).toBe(opener);
  });

  it('goes to the field that asks for it rather than to the dialog’s own box', () => {
    render(
      <Modal title="Unlock" onClose={vi.fn()}>
        <input aria-label="Password" data-autofocus />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
  });

  it('wraps from the last control back to the first on Tab, instead of leaving the dialog', () => {
    const { close, confirm } = open();
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });

  it('wraps from the first control back to the last on Shift+Tab', () => {
    const { close, confirm } = open();
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('leaves a Tab in the middle of the cycle to the browser', () => {
    const { reason } = open();
    reason.focus();
    fireEvent.keyDown(reason, { key: 'Tab' });
    expect(document.activeElement).toBe(reason); // untouched — jsdom does not move it, and nor did the trap
  });

  it('pulls the focus back in when it is somewhere behind the dialog', () => {
    const { close } = open();
    const behind = screen.getByRole('button', { name: 'Open' });
    behind.focus();
    fireEvent.keyDown(behind, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });

  it('stops listening once it is gone, so Escape on the page behind closes nothing', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<Page open onClose={onClose} />);
    rerender(<Page open={false} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
