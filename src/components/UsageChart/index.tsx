import useUsage from '../../hooks/use-usage';
import { usd } from '../../lib/format';
import Bars from './Bars';
import { AXIS, GRID, INK, PLOT, SERIES, VIEW } from './constants';
import { dayLabel, millions, niceMax, totalOf } from './utils';

const TICKS = 3; // → 4 gridlines counting the baseline

export default function UsageChart({ days = 7 }: { days?: number }) {
  const { data, error } = useUsage(days);

  if (error) return <p className="text-sm text-red-400">{String(error)}</p>;
  if (!data) return <p className="text-sm text-zinc-400">Loading usage…</p>;

  const { buckets, cost, byModel } = data;
  const max = niceMax(Math.max(...buckets.map(totalOf)), TICKS);
  const band = PLOT.w / buckets.length;
  const baseline = PLOT.y + PLOT.h;
  const totals = SERIES.map((s) => ({ ...s, total: buckets.reduce((n, b) => n + b[s.key], 0) }));
  const unpriced = byModel.filter((m) => m.cost === null);

  return (
    <section className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">
          token usage · last {days} days
        </h3>
        <span className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-zinc-400">
          <span className="text-base font-semibold text-zinc-100">{usd(cost)}</span>
          <span className="text-zinc-400">API estimate</span>
          {byModel
            .filter((m) => m.cost !== null)
            .map((m) => (
              <span key={m.model}>
                {m.model.replace(/^claude-/, '')} <span className="text-zinc-200">{usd(m.cost ?? 0)}</span>
              </span>
            ))}
          {unpriced.length > 0 && (
            <span className="text-amber-400" title="No list price known for these models, so their tokens are not counted.">
              excl. {unpriced.map((m) => m.model).join(', ')}
            </span>
          )}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-[11px] text-zinc-400">
          {totals.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
              {s.label} <span className="text-zinc-200">{millions(s.total)}</span>
            </span>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
        className="w-full rounded-md border border-zinc-800 bg-zinc-900/40"
        role="img"
        aria-label={`Hourly token usage over the last ${days} days`}
      >
        {Array.from({ length: TICKS + 1 }, (_, i) => {
          const value = (max * i) / TICKS;
          const y = baseline - (PLOT.h * i) / TICKS;
          return (
            <g key={i}>
              <line x1={PLOT.x} x2={PLOT.x + PLOT.w} y1={y} y2={y} stroke={i ? GRID : AXIS} strokeWidth={1} />
              <text x={PLOT.x - 8} y={y + 4} textAnchor="end" fontSize={12} fill={INK}>
                {i ? millions(value) : '0'}
              </text>
            </g>
          );
        })}

        <Bars buckets={buckets} max={max} />

        {buckets.map((b, i) => {
          const hour = new Date(b.hour).getHours();
          if (hour % 6) return null;
          const x = PLOT.x + i * band + band / 2;
          return (
            <g key={b.hour}>
              <line x1={x} x2={x} y1={baseline} y2={baseline + (hour ? 3 : 5)} stroke={AXIS} strokeWidth={1} />
              {hour === 0 && (
                <text x={x} y={baseline + 18} textAnchor="middle" fontSize={12} fill={INK}>
                  {dayLabel(b.hour)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </section>
  );
}
