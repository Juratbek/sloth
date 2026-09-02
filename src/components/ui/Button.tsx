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

// `primary` is the inverted one: the text colour becomes the fill and the surface becomes the ink,
// which is why it reads `bg-fg-strong text-surface-raised` rather than naming a seventh token.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-fg-strong text-surface-raised hover:bg-white disabled:bg-surface-inset disabled:text-fg-faint',
  ghost: 'border border-edge text-fg-soft hover:bg-surface-raised disabled:text-fg-disabled disabled:hover:bg-transparent',
  icon: 'border border-edge text-fg-muted hover:bg-surface-raised hover:text-fg disabled:text-fg-disabled disabled:hover:bg-transparent',
  accent: 'border border-info-edge-strong bg-info-tint/60 text-info-fg-strong hover:bg-info-tint-strong/60 disabled:text-fg-disabled',
  danger: 'border border-danger-edge text-danger-fg hover:bg-danger-tint/60 disabled:opacity-50 disabled:hover:bg-transparent',
  warn: 'border border-warn-edge-strong bg-warn-tint/50 text-warn-fg hover:bg-warn-tint-strong/50 disabled:text-fg-disabled',
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
