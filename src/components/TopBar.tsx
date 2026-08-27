import { useState } from 'react';
import type { Overview } from '../../server/types';
import usePause from '../hooks/use-pause';
import useTick from '../hooks/use-tick';
import { clock, nextAt } from '../lib/format';

const COOLDOWN_MS = 10_000;

const BUCKET_NAMES: Record<string, string> = { core: 'REST', graphql: 'GraphQL', search: 'Search' };

function Pill({ label, value, tone = 'zinc' }: { label?: string; value: string; tone?: 'zinc' | 'red' | 'amber' | 'emerald' }) {
  const tones = {
    zinc: 'border-zinc-800 text-zinc-300',
    red: 'border-red-900 bg-red-950/50 text-red-300',
    amber: 'border-amber-900 bg-amber-950/50 text-amber-300',
    emerald: 'border-emerald-900 bg-emerald-950/40 text-emerald-300',
  };
  return (
    <span className={`rounded-md border px-2 py-0.5 text-xs ${tones[tone]}`}>
      {label && <span className="text-zinc-500">{label} </span>}
      {value}
    </span>
  );
}

function PauseButton({ paused }: { paused: boolean }) {
  const pause = usePause();
  return (
    <button
      disabled={pause.isPending}
      onClick={() => pause.mutate(!paused)}
      title={
        paused
          ? 'Resume: Sloth starts new work again — pickups, relaunches, reviews and orders.'
          : 'Pause: Sloth starts no new work. Running sessions continue, and Tick now still reaps, delivers @sloth comments and answers status questions.'
      }
      className={`rounded-md border px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:text-zinc-600 ${
        paused
          ? 'border-amber-800 bg-amber-950/50 text-amber-300 hover:bg-amber-900/50'
          : 'border-zinc-800 text-zinc-300 hover:bg-zinc-900'
      }`}
    >
      {paused ? 'Resume' : 'Pause'}
    </button>
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
      title="Runs the next tick now. While paused it still reaps, delivers @sloth comments and answers status questions — it starts no new work."
      className="rounded-md border border-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
    >
      {busy ? 'Ticking…' : cooling ? 'Ticked' : 'Tick now'}
    </button>
  );
}

const iconButton = 'rounded-md border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200';

export default function TopBar({
  overview,
  menu,
  onMenu,
  onHome,
  onSettings,
  onRemote,
}: {
  overview: Overview;
  menu: boolean;
  onMenu: () => void;
  onHome: () => void;
  onSettings: () => void;
  /** Opens the QR dialog; absent when the page is not on the machine Sloth runs on, where there is no QR. */
  onRemote?: () => void;
}) {
  const { config, watcher, rateLimit, sessions, remote } = overview;
  const working = sessions.filter((s) => s.status === 'running').length;
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  const full = working >= config.maxActive;
  const limitPaused = watcher.pausedUntil && watcher.pausedUntil * 1000 > Date.now();
  // Only a bucket that is nearly spent is worth a pill.
  const low = Object.entries(rateLimit ?? {}).find(([, b]) => b.remaining < b.limit * 0.1);

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 md:px-4">
      <button onClick={onHome} className="mr-2 text-sm font-semibold text-zinc-100 hover:text-white">
        {config.title}
      </button>
      <Pill
        label="sessions"
        value={`${working}${full ? `/${config.maxActive}` : ''} working · ${waiting} waiting`}
        tone={full ? 'amber' : 'emerald'}
      />
      <span className="hidden md:contents">
        <Pill label="pickup" value={config.pickupColumn} />
        <Pill label="board" value={nextAt(watcher.loop.nextBoard)} />
        <Pill label="comments" value={nextAt(watcher.loop.nextComment)} />
      </span>
      <TickButton busy={watcher.loop.ticking} />
      <PauseButton paused={watcher.paused} />
      {watcher.paused && <Pill value="paused" tone="amber" />}
      {limitPaused && <Pill label="paused until" value={clock(watcher.pausedUntil! * 1000)} tone="amber" />}
      <span className="flex-1" />
      {onRemote && (
        <button
          onClick={onRemote}
          title={remote.error ?? 'Open on your phone'}
          aria-label="Open on your phone"
          className={`${iconButton} ${remote.error ? 'border-amber-900 text-amber-300' : ''}`}
        >
          ▦
        </button>
      )}
      <button onClick={onSettings} title="Settings" aria-label="Settings" className={iconButton}>
        ⚙
      </button>
      <button onClick={onMenu} className={`${iconButton} md:hidden`} aria-expanded={menu}>
        {menu ? 'Close' : 'Sessions'}
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
