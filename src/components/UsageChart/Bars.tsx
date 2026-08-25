import type { UsageBucket } from '../../../server/types';
import { PLOT, SERIES } from './constants';
import { tooltip } from './utils';

const GAP = 2; // surface gap between stacked segments
const MIN_H = 1; // keep a sub-pixel segment visible
const RADIUS = 2;

/** Square at the baseline, rounded at the data end. */
function segPath(x: number, y: number, w: number, h: number, round: boolean) {
  const r = round ? Math.min(RADIUS, w / 2, h) : 0;
  if (r <= 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return `M${x} ${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - r}h${-w}Z`;
}

export default function Bars({ buckets, max }: { buckets: UsageBucket[]; max: number }) {
  const band = PLOT.w / buckets.length;
  const width = Math.max(1, Math.min(24, band - 1.7));
  const baseline = PLOT.y + PLOT.h;

  return (
    <g>
      {buckets.map((b, i) => {
        const bandX = PLOT.x + i * band;
        const x = bandX + (band - width) / 2;
        const active = SERIES.filter((s) => b[s.key] > 0);
        let bottom = baseline;

        return (
          <g key={b.hour}>
            {active.map((s, j) => {
              const top = bottom - (b[s.key] / max) * PLOT.h;
              const height = Math.max(MIN_H, bottom - top - (j === 0 ? 0 : GAP));
              bottom = top;
              return <path key={s.key} d={segPath(x, top, width, height, j === active.length - 1)} fill={s.color} />;
            })}
            {/* Full-band hit target — the bars themselves are only a few px wide. */}
            <rect x={bandX} y={PLOT.y} width={band} height={PLOT.h} fill="transparent">
              <title>{tooltip(b)}</title>
            </rect>
          </g>
        );
      })}
    </g>
  );
}
