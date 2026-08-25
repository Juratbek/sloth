import { useState } from 'react';
import type { Overview } from '../../server/types';
import useTick from '../hooks/use-tick';
import { clock, nextAt } from '../lib/format';

const COOLDOWN_MS = 10_000;

const BUCKET_NAMES: Record<string, string> = { core: 'REST', graphql: 'GraphQL', search: 'Search' };

function Pill({ label, value, tone = 'zinc' }: { label: string; value: string; tone?: 'zinc' | 'red' | 'amber' | 'emerald' }) {
  const tones = {
    zinc: 'border-zinc-800 text-zinc-300',
    red: 'border-red-900 bg-red-950/50 text-red-300',
    amber: 'border-amber-900 bg-amber-950/50 text-amber-300',
    emerald: 'border-emerald-900 bg-emerald-950/40 text-emerald-300',
  };
  return (
    <span className={`rounded-md border px-2 py-0.5 text-xs ${tones[tone]}`}>
      <span className="text-zinc-500">{label} </span>
      {value}
    </span>
  );
}

function TickButton({ busy }: { busy: boolean }) {
  const tick = useTick();
  const [until, setUntil] = useState(0);
  const cooling = until > Date.now();
  return (
    <button
      disabled={busy || cooling || tick.isPending}
      onClick={() => {
        setUntil(Date.now() + COOLDOWN_MS);
        tick.mutate();
      }}
      className="rounded-md border border-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
    >
      {busy ? 'Ticking…' : cooling ? 'Ticked' : 'Tick now'}
    </button>
  );
}

export default function TopBar({
  overview,
  onHome,
  onSettings,
}: {
  overview: Overview;
  onHome: () => void;
  onSettings: () => void;
}) {
  const { config, watcher, rateLimit, sessions } = overview;
  const working = sessions.filter((s) => s.status === 'running').length;
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  const full = working >= config.maxActive;
  const paused = watcher.pausedUntil && watcher.pausedUntil * 1000 > Date.now();
  // Only a bucket that is nearly spent is worth a pill.
  const low = Object.entries(rateLimit ?? {}).find(([, b]) => b.remaining < b.limit * 0.1);

  return (
    <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
      <button onClick={onHome} className="mr-2 text-sm font-semibold text-zinc-100 hover:text-white">
        {config.title}
      </button>
      <Pill
        label="sessions"
        value={`${working}${full ? `/${config.maxActive}` : ''} working · ${waiting} waiting`}
        tone={full ? 'amber' : 'emerald'}
      />
      <Pill label="pickup" value={config.pickupColumn} />
      <Pill label="board" value={nextAt(watcher.loop.nextBoard)} />
      <Pill label="comments" value={nextAt(watcher.loop.nextComment)} />
      <TickButton busy={watcher.loop.ticking} />
      {paused && <Pill label="paused until" value={clock(watcher.pausedUntil! * 1000)} tone="amber" />}
      <span className="flex-1" />
      <button
        onClick={onSettings}
        title="Settings"
        aria-label="Settings"
        className="rounded-md border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
      >
        ⚙
      </button>
      {low && (
        <Pill
          label={`${BUCKET_NAMES[low[0]] ?? low[0]} quota`}
          value={`${low[1].remaining}/${low[1].limit} · resets ${clock(low[1].reset * 1000)}`}
          tone={low[1].remaining === 0 ? 'red' : 'amber'}
        />
      )}
    </header>
  );
}
