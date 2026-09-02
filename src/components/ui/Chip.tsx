import type { ReactNode } from 'react';

/** A chip's colour: what it is saying, not where it sits. */
export type ChipTone = 'zinc' | 'outline' | 'solid' | 'solidDim' | 'red' | 'amber' | 'emerald' | 'sky';
/** How loud it is: `2xs` inside a dense card, `md` in the header bar. */
export type ChipSize = '2xs' | 'xs' | 'sm' | 'md';

const TONES: Record<ChipTone, string> = {
  zinc: 'border border-zinc-800 text-zinc-400',
  outline: 'border border-zinc-700 text-zinc-300',
  solid: 'bg-zinc-800 text-zinc-300',
  solidDim: 'bg-zinc-800 text-zinc-400',
  red: 'border border-red-900 bg-red-950/50 text-red-300',
  amber: 'border border-amber-900 bg-amber-950/50 text-amber-300',
  emerald: 'border border-emerald-900 bg-emerald-950/40 text-emerald-300',
  sky: 'border border-sky-900 bg-sky-950/40 text-sky-300',
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
      {label && <span className="text-zinc-400">{label} </span>}
      {children}
    </span>
  );
}
