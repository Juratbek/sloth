import type { MonitorConfig, SessionDetail } from '../../../server/types';
import { STATUS_COLOR, ago, elapsed, githubUrl, k, label, newInput, stepLabel } from '../../lib/format';
import { ToolChips } from './Usage';

function Stats({ s }: { s: SessionDetail }) {
  const a = s.agentsUsage;
  return (
    <div className="space-y-0.5 font-mono text-xs text-zinc-400">
      <p>
        context {k(s.contextTokens)} · new input {k(newInput(s.usage))} · cache reads {k(s.usage.cacheRead)} · out{' '}
        {k(s.usage.output)} ({k(s.usage.thinking)} thinking) · {s.turns} turns · {s.messages.length} messages
        {s.agents.length > 0 &&
          ` · subagents: new ${k(newInput(a))} · cache reads ${k(a.cacheRead)} · out ${k(a.output)} (${s.agents.length})`}
      </p>
      {s.byModel.length > 1 && (
        <p className="text-zinc-500">
          {s.byModel.map((m) => `${m.model.replace(/^claude-/, '')} ${m.requests}× ↑${k(m.output)}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

function WatcherLine({ s }: { s: SessionDetail }) {
  const w = s.watcher;
  if (!w) return <p className="text-xs text-zinc-600">No watcher session dir linked.</p>;
  const st = w.state;
  return (
    <div className="space-y-1 text-xs text-zinc-400">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-zinc-500">{w.name}</span>
        {st?.step && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]" title={`step ${st.step}`}>
            {stepLabel(w.kind, st.step)}
          </span>
        )}
        {st?.branch && <span className="font-mono text-[11px] text-zinc-500">{st.branch}</span>}
        {st?.pr && (
          <a href={st.pr} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
            {st.pr.replace(/.*\//, 'PR #')}
          </a>
        )}
        {st?.servers && <span className="text-[11px] text-zinc-500">servers: {st.servers}</span>}
        {w.retries > 0 && <span className="text-amber-400">retries {w.retries}</span>}
        {w.blocked && <span className="text-red-400">blocked</span>}
        {w.inbox.length > 0 && <span className="text-sky-400">inbox {w.inbox.length}</span>}
        <span className="text-zinc-600">updated {ago(w.updatedAt)} ago</span>
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
        <span className="text-[11px] text-zinc-500">{elapsed(s)}</span>
        <span className="ml-auto hidden font-mono text-[11px] text-zinc-600 sm:inline">{s.id}</span>
      </div>
      <Stats s={s} />
      <p className="truncate font-mono text-xs text-zinc-500">{s.prompt}</p>
      <WatcherLine s={s} />
      <ToolChips counts={s.toolCounts} />
    </header>
  );
}
