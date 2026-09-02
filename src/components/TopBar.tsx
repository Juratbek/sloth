import type { Overview } from '../../server/types';
import usePause from '../hooks/use-pause';
import useCooldown from '../hooks/use-cooldown';
import useTick from '../hooks/use-tick';
import { clock, nextAt } from '../lib/format';
import Button from './ui/Button';
import Chip from './ui/Chip';
import ErrorNote from './ui/ErrorNote';

const COOLDOWN_MS = 10_000;

const BUCKET_NAMES: Record<string, string> = { core: 'REST', graphql: 'GraphQL', search: 'Search' };

function PauseButton({ paused }: { paused: boolean }) {
  const pause = usePause();
  return (
    <>
      <Button
        size="bar"
        variant={paused ? 'warn' : 'ghost'}
        disabled={pause.isPending}
        onClick={() => pause.mutate(!paused)}
        title={
          paused
            ? 'Resume: Sloth starts new work again — pickups, relaunches, reviews and orders.'
            : 'Pause: Sloth starts no new work. Running sessions continue, and Tick now still reaps, delivers @sloth comments and answers status questions.'
        }
      >
        {paused ? 'Resume' : 'Pause'}
      </Button>
      <ErrorNote error={pause.error} />
    </>
  );
}

function TickButton({ busy }: { busy: boolean }) {
  const tick = useTick();
  const { cooling, arm } = useCooldown(COOLDOWN_MS);
  return (
    <>
      <Button
        size="bar"
        disabled={busy || cooling || tick.isPending}
        onClick={() => {
          arm();
          tick.mutate();
        }}
        title="Runs the next tick now. While paused it still reaps, delivers @sloth comments and answers status questions — it starts no new work."
      >
        {busy ? 'Ticking…' : cooling ? 'Ticked' : 'Tick now'}
      </Button>
      <ErrorNote error={tick.error} />
    </>
  );
}

export default function TopBar({
  overview,
  menu,
  onMenu,
  onHome,
  onBoard,
  onSettings,
  onRemote,
}: {
  overview: Overview;
  menu: boolean;
  onMenu: () => void;
  onHome: () => void;
  /** Opens the board page; it only reads the last tick's board, so a phone gets it too. */
  onBoard: () => void;
  /** Opens the settings wizard; absent on a phone, where the config is out of reach. */
  onSettings?: () => void;
  /** Opens the QR dialog; absent when the page is not on the machine Sloth runs on, where there is no QR. */
  onRemote?: () => void;
}) {
  const { config, watcher, rateLimit, sessions, remote } = overview;
  const working = sessions.filter((s) => s.status === 'running').length;
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  const full = working >= config.maxActive;
  const limitPaused = watcher.pausedUntil && watcher.pausedUntil * 1000 > Date.now();
  const machine = watcher.loop.machine;
  // Only a bucket that is nearly spent is worth a chip.
  const low = Object.entries(rateLimit ?? {}).find(([, b]) => b.remaining < b.limit * 0.1);

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 md:px-4">
      <button onClick={onHome} className="mr-2 text-sm font-semibold text-zinc-100 hover:text-white">
        {config.title}
      </button>
      <Chip label="sessions" tone={full ? 'amber' : 'emerald'}>
        {`${working}${full ? `/${config.maxActive}` : ''} working · ${waiting} waiting`}
      </Chip>
      {machine?.hold && (
        <Chip label="machine" tone="amber" title={`${machine.hold} — running sessions go on; new ones wait for the next tick`}>
          {`${machine.memoryFree}% memory · ${machine.cpuIdle}% CPU idle${machine.diskIdle === undefined ? '' : ` · ${machine.diskIdle}% disk idle`}`}
        </Chip>
      )}
      <span className="hidden md:contents">
        <Chip label="pickup">{config.pickupColumn}</Chip>
        <Chip label="board">{nextAt(watcher.loop.nextBoard)}</Chip>
        <Chip label="comments">{nextAt(watcher.loop.nextComment)}</Chip>
      </span>
      <TickButton busy={watcher.loop.ticking} />
      <PauseButton paused={watcher.paused} />
      <Button size="bar" onClick={onBoard} title="The board as the last tick read it, on a page of its own">
        Board
      </Button>
      {watcher.paused && <Chip tone="amber">paused</Chip>}
      {limitPaused && (
        <Chip label="paused until" tone="amber">
          {clock(watcher.pausedUntil! * 1000)}
        </Chip>
      )}
      <span className="flex-1" />
      {onRemote && (
        <Button
          size="bar"
          variant="icon"
          onClick={onRemote}
          title={remote.error ?? 'Open on your phone'}
          aria-label="Open on your phone"
          className={remote.error ? 'border-amber-900 text-amber-300' : ''}
        >
          ▦
        </Button>
      )}
      {onSettings && (
        <Button size="bar" variant="icon" onClick={onSettings} title="Settings" aria-label="Settings">
          ⚙
        </Button>
      )}
      <Button size="bar" variant="icon" onClick={onMenu} className="md:hidden" aria-expanded={menu}>
        {menu ? 'Close' : 'Sessions'}
      </Button>
      {low && (
        <Chip label={`${BUCKET_NAMES[low[0]] ?? low[0]} quota`} tone={low[1].remaining === 0 ? 'red' : 'amber'}>
          {`${low[1].remaining}/${low[1].limit} · resets ${clock(low[1].reset * 1000)}`}
        </Chip>
      )}
    </header>
  );
}
