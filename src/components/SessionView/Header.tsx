import type { MonitorConfig, SessionDetail } from '../../../server/types';
import useStopPreview from '../../hooks/use-preview';
import useStopSession from '../../hooks/use-stop-session';
import { STATUS_COLOR, ago, elapsed, githubUrl, k, label, newInput, safeUrl, stepLabel, untilLabel, usd } from '../../lib/format';
import { ToolChips } from './Usage';

function Stats({ s }: { s: SessionDetail }) {
  const a = s.agentsUsage;
  return (
    <div className="space-y-0.5 font-mono text-xs text-zinc-400">
      <p>
        context {k(s.contextTokens)} · new input {k(newInput(s.usage))} · cache reads {k(s.usage.cacheRead)} · out{' '}
        {k(s.usage.output)} ({k(s.usage.thinking)} thinking) · {s.turns} turns · {s.messages.length} messages ·{' '}
        {s.cost === null ? 'cost —' : usd(s.cost)}
        {s.agents.length > 0 &&
          ` · subagents: new ${k(newInput(a))} · cache reads ${k(a.cacheRead)} · out ${k(a.output)} (${s.agents.length})`}
      </p>
      {s.byModel.length > 1 && (
        <p className="text-zinc-400">
          {s.byModel.map((m) => `${m.model.replace(/^claude-/, '')} ${m.requests}× ↑${k(m.output)}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

/** The finished run's app, live behind a tunnel: the link, when it goes, and a way to take it down now. */
function PreviewLine({ issue, preview }: { issue: number; preview: NonNullable<SessionDetail['watcher']>['preview'] }) {
  const stop = useStopPreview();
  if (!preview) return null;
  // The guard in front of the app wants the key, exactly as the link posted on the PR carries it.
  const url = safeUrl(preview.url);
  const link = url && preview.key ? `${url}/?sloth_key=${preview.key}` : url;
  return (
    <span className="flex items-center gap-2">
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">
          preview
        </a>
      ) : (
        <span className="text-zinc-400">preview starting…</span>
      )}
      <span className="text-[11px] text-zinc-400">{untilLabel(preview.expiresAt)}</span>
      <button
        onClick={() => stop.mutate(issue)}
        disabled={stop.isPending}
        className="rounded border border-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:opacity-50"
      >
        {stop.isPending ? 'stopping…' : 'stop'}
      </button>
    </span>
  );
}

/** Ends a run: a live one is killed (an issue's card lands in needs-help); a parked one whose process is gone leaves needs-help. */
function StopButton({ s }: { s: SessionDetail }) {
  const stop = useStopSession();
  const w = s.watcher;
  if (!w || !(s.live || s.status === 'parked')) return null;
  const issue = w.kind === 'issue';
  const text = s.live
    ? issue
      ? { ask: `Stop ${w.name}? Its card goes to needs-help; a reply on the issue starts it again.`, hint: 'Kills the session and its servers, removes the worktree and parks the card in needs-help. The branch and PR stay.' }
      : { ask: `Stop ${w.name}?`, hint: 'Kills the review. This PR head is not reviewed again; the next push gets a fresh review.' }
    : {
        ask: `End the parked run ${w.name}? It leaves Needs help; the card stays parked until someone answers on the issue.`,
        hint: 'Ends the parked run: its servers, database and worktree go and it leaves Needs help. The card stays where it is; an answer on the issue starts a new run.',
      };
  return (
    <button
      onClick={() => {
        if (window.confirm(text.ask)) stop.mutate(s.id);
      }}
      disabled={stop.isPending}
      title={text.hint}
      className="rounded border border-red-900 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-950/60 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {stop.isPending ? 'stopping…' : s.live ? 'stop' : 'end'}
    </button>
  );
}

function WatcherLine({ s }: { s: SessionDetail }) {
  const w = s.watcher;
  if (!w) return <p className="text-xs text-zinc-500">No watcher session dir linked.</p>;
  const st = w.state;
  return (
    <div className="space-y-1 text-xs text-zinc-400">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-zinc-400">{w.name}</span>
        {st?.step && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]" title={`step ${st.step}`}>
            {stepLabel(w.kind, st.step)}
          </span>
        )}
        {st?.branch && <span className="font-mono text-[11px] text-zinc-400">{st.branch}</span>}
        {safeUrl(st?.pr) && (
          <a href={safeUrl(st?.pr)} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
            {st!.pr!.replace(/.*\//, 'PR #')}
          </a>
        )}
        {st?.servers && <span className="text-[11px] text-zinc-400">servers: {st.servers}</span>}
        <PreviewLine issue={w.target} preview={w.preview} />
        {w.retries > 0 && <span className="text-amber-400">retries {w.retries}</span>}
        {w.blocked && <span className="text-red-400">blocked</span>}
        {w.inbox.length > 0 && <span className="text-sky-400">inbox {w.inbox.length}</span>}
        <span className="text-zinc-500">updated {ago(w.updatedAt)} ago</span>
      </div>
      {st?.note && <p className="text-zinc-400">{st.note}</p>}
    </div>
  );
}

export default function Header({ s, config }: { s: SessionDetail; config: MonitorConfig }) {
  const url = githubUrl(s.kind, s.target, config);
  return (
    <header className="space-y-2 border-b border-zinc-800 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[s.status]} ${s.live ? 'animate-pulse' : ''}`} />
        <h1 className="text-sm font-semibold text-zinc-100">{label(s)}</h1>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="text-sm text-sky-400 hover:underline">
            {s.title ?? url.replace(`https://github.com/${config.repo}/`, '')}
          </a>
        )}
        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300">{s.status}</span>
        <span className="text-[11px] text-zinc-400">{elapsed(s)}</span>
        <StopButton s={s} />
        <span className="ml-auto hidden font-mono text-[11px] text-zinc-500 sm:inline">{s.id}</span>
      </div>
      <Stats s={s} />
      <p className="truncate font-mono text-xs text-zinc-400">{s.prompt}</p>
      <WatcherLine s={s} />
      <ToolChips counts={s.toolCounts} />
    </header>
  );
}
