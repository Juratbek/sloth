import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Everything a Tab can land on. `:not([disabled])` keeps a pending button out of the cycle. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusable = (box: HTMLElement) => [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);

/**
 * The dialog both of Sloth's modals sit in: a backdrop that closes on a click, Escape that closes,
 * and the keyboard kept inside until it does.
 *
 * Both dialogs were a `fixed inset-0` div with `role="dialog"` and nothing else, so a screen reader was
 * never told the page behind had gone (`aria-modal`), Escape did nothing, and Tab walked straight out of
 * the dialog into the header behind it — where the button that opened it still had the focus ring. Focus
 * moves in on open, cycles inside, and goes back to the opener on close.
 *
 * The dialog's own box is the focus target when nothing inside asks for it; an element marked
 * `data-autofocus` (the sudo password field) gets it instead, which is also what `autoFocus` would have
 * done before this effect ran.
 */
export default function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** The row of buttons along the bottom, inside the dialog and inside the focus trap. */
  footer?: ReactNode;
}) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);

  // Effect is unavoidable: focus lives on the document, not in React. It is moved in on mount and
  // handed back to whatever opened the dialog on unmount.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = box.current;
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el)?.focus();
    return () => opener?.focus();
  }, []);

  // Effect is unavoidable: Escape and Tab are pressed on the window, above whatever has the focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = box.current;
      if (!el) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable(el);
      const active = document.activeElement;
      if (!items.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const outside = !(active instanceof Node) || !el.contains(active);
      if (e.shiftKey ? outside || active === first : outside || active === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-sm space-y-3 rounded-lg border border-edge bg-surface p-4 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <h2 id={titleId} className="text-sm font-semibold text-fg-strong">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-fg-muted hover:text-fg">
            ✕
          </button>
        </div>
        {children}
        {footer && <div className="flex gap-2">{footer}</div>}
      </div>
    </div>
  );
}
