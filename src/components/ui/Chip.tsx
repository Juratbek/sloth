import type { ReactNode } from 'react';

/** A chip's colour: what it is saying, not where it sits. */
export type ChipTone = 'zinc' | 'outline' | 'solid' | 'solidDim' | 'red' | 'amber' | 'emerald' | 'sky';
/** How loud it is: `2xs` inside a dense card, `md` in the header bar. */
export type ChipSize = '2xs' | 'xs' | 'sm' | 'md';

const TONES: Record<ChipTone, string> = {
  zinc: 'border border-edge text-fg-muted',
  outline: 'border border-edge-strong text-fg-soft',
  solid: 'bg-surface-inset text-fg-soft',
  solidDim: 'bg-surface-inset text-fg-muted',
  red: 'border border-danger-edge bg-danger-tint/50 text-danger-fg',
  amber: 'border border-warn-edge bg-warn-tint/50 text-warn-fg',
  emerald: 'border border-ok-edge bg-ok-tint/40 text-ok-fg',
  sky: 'border border-info-edge bg-info-tint/40 text-info-fg',
};

const SIZES: Record<ChipSize, string> = {
  '2xs': 'rounded px-1 text-[10px]',
  xs: 'rounded px-1.5 py-0.5 text-[10px]',
  sm: 'rounded px-1.5 py-0.5 text-[11px]',
  md: 'rounded-md px-2 py-0.5 text-xs',
};

/**
 * A small labelled box that says one fact and is never pressed — the header's pills, the tool counts,
 * a session's step and model, the queued triggers, the counts of cards the board leaves out. Seven
 * near-identical spans, now one; a chip that needs a colour asks for a tone rather than a hex.
 *
 * `label` is the dim word in front of the value ("sessions 2 working"), which only the header uses.
 */
export default function Chip({
  children,
  label,
  tone = 'zinc',
  size = 'md',
  title,
  className = '',
}: {
  children: ReactNode;
  label?: string;
  tone?: ChipTone;
  size?: ChipSize;
  title?: string;
  className?: string;
}) {
  return (
    <span title={title} className={`${SIZES[size]} ${TONES[tone]} ${className}`}>
      {label && <span className="text-fg-muted">{label} </span>}
      {children}
    </span>
  );
}
