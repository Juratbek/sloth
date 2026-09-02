import type { UsageBucket } from '../../../server/types';

/** Fixed drawing box; the SVG scales uniformly, so nothing (text included) is stretched. */
export const VIEW = { w: 1000, h: 220 };
export const PLOT = { x: 46, y: 12, w: 944, h: 182 };

/**
 * The chart's ink. SVG paints through `fill`/`stroke` attributes, which take a colour and not a class,
 * so these have to be literals — but they are literals in one object, each named beside the token it
 * mirrors, rather than scattered down `index.tsx` and `Bars.tsx`. A repaint changes the token in
 * `index.css` and its twin here; nothing else in the chart holds a colour.
 */
export const PALETTE = {
  /** `--color-fg-faint` (zinc-500) — the recessive bulk of the stack. */
  cacheRead: '#71717a',
  /** No token: the chart's own blue, a series colour rather than a UI one. */
  newInput: '#3987e5',
  /** No token: the chart's own green, paired with the blue above. */
  output: '#199e70',
  /** `--color-edge` (zinc-800) — the horizontal rules behind the bars. */
  grid: '#27272a',
  /** `--color-edge-strong` (zinc-700) — the baseline and the tick marks. */
  axis: '#3f3f46',
  /** `--color-fg-muted` (zinc-400) — axis labels and the legend. */
  ink: '#a1a1aa',
} as const;

/** Stacked bottom → top. Cache reads are the recessive bulk; the two spend series sit on top. */
export const SERIES = [
  { key: 'cacheRead', label: 'cache reads', color: PALETTE.cacheRead },
  { key: 'newInput', label: 'new input', color: PALETTE.newInput },
  { key: 'output', label: 'output', color: PALETTE.output },
] as const satisfies readonly { key: keyof Omit<UsageBucket, 'hour'>; label: string; color: string }[];

export const GRID = PALETTE.grid;
export const AXIS = PALETTE.axis;
export const INK = PALETTE.ink;
