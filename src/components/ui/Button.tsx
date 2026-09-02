import type { ReactNode } from 'react';

/**
 * What the button says about itself. `ghost` is the default outline; `icon` is the same box holding a
 * glyph, dimmer until hovered; `primary` is the light one that commits; `accent` the blue one the
 * remote dialog installs with; `danger` and `warn` the red and amber ones that stop and pause things.
 */
export type ButtonVariant = 'primary' | 'ghost' | 'icon' | 'accent' | 'danger' | 'warn';

/**
 * How big, named for where it belongs rather than for a t-shirt: the five geometries the UI actually
 * had. Naming them this way is what keeps them at five — a sixth would have to justify a sixth place.
 */
export type ButtonSize = 'inline' | 'bar' | 'dialog' | 'wide' | 'form';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500',
  ghost: 'border border-zinc-800 text-zinc-300 hover:bg-zinc-900 disabled:text-zinc-600 disabled:hover:bg-transparent',
  icon: 'border border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:text-zinc-600 disabled:hover:bg-transparent',
  accent: 'border border-sky-800 bg-sky-950/60 text-sky-200 hover:bg-sky-900/60 disabled:text-zinc-600',
  danger: 'border border-red-900 text-red-300 hover:bg-red-950/60 disabled:opacity-50 disabled:hover:bg-transparent',
  warn: 'border border-amber-800 bg-amber-950/50 text-amber-300 hover:bg-amber-900/50 disabled:text-zinc-600',
};

const SIZES: Record<ButtonSize, string> = {
  /** Sitting in a line of running text — the session header's stop and end. */
  inline: 'rounded px-1.5 py-0.5 text-[11px]',
  /** In the header bar, beside the chips. */
  bar: 'rounded-md px-2 py-0.5 text-xs',
  /** A dialog's footer row. */
  dialog: 'rounded-md px-2 py-1 text-xs',
  /** A dialog's one committing button, which is wider than the rest of its row. */
  wide: 'rounded-md px-3 py-1.5 text-xs',
  /** The wizard and the settings, where a button stands on its own. */
  form: 'rounded-md px-3 py-1.5 text-sm',
};

/**
 * The one button in the UI. Every pressable box was its own string of Tailwind classes — a dozen of
 * them across the header, the dialogs, the wizard and the session view, alike enough to be the same
 * thing and different enough that a change to one never reached the others.
 *
 * Size and variant are separate on purpose and neither may be overridden through `className`: two
 * Tailwind utilities of one family in the same class list are settled by the order of the generated
 * stylesheet, not by the order they are written in, so a `text-xs` "override" on a `text-sm` size is a
 * coin toss. `className` is for what no variant claims — a margin, a `md:hidden`, an extra border colour.
 */
export default function Button({
  children,
  onClick,
  disabled,
  variant = 'ghost',
  size = 'form',
  type = 'button',
  title,
  className = '',
  'aria-label': ariaLabel,
  'aria-expanded': ariaExpanded,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
  'aria-label'?: string;
  'aria-expanded'?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      className={`disabled:cursor-not-allowed ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
