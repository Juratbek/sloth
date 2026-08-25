import type { UsageBucket } from '../../../server/types';

/** Fixed drawing box; the SVG scales uniformly, so nothing (text included) is stretched. */
export const VIEW = { w: 1000, h: 220 };
export const PLOT = { x: 46, y: 12, w: 944, h: 182 };

/** Stacked bottom → top. Cache reads are the recessive bulk; the two spend series sit on top. */
export const SERIES = [
  { key: 'cacheRead', label: 'cache reads', color: '#71717a' },
  { key: 'newInput', label: 'new input', color: '#3987e5' },
  { key: 'output', label: 'output', color: '#199e70' },
] as const satisfies readonly { key: keyof Omit<UsageBucket, 'hour'>; label: string; color: string }[];

export const GRID = '#27272a';
export const AXIS = '#3f3f46';
export const INK = '#a1a1aa';
