import { useVersion } from '../hooks/use-update';
import { ago } from '../lib/format';
import { Button } from '../setup/ui';
import { Row } from './ui';

const STEP: Record<string, string> = { pull: 'Pulling…', install: 'Installing…', build: 'Building…', restart: 'Restarting…' };

/** Which Sloth this is, whether a newer one is on the remote, and the button that installs it. */
export default function AboutSection() {
  const { query, check, update } = useVersion(true);
  const v = query.data;
  if (!v) return <p className="py-3 text-xs text-zinc-500">{query.isError ? `Version unavailable: ${String(query.error)}` : 'Loading…'}</p>;
  const u = v.update;
  const busy = u.running || u.restarting;
  const where = `origin/${v.branch ?? 'main'}`;
  const state = u.restarting
    ? 'Restarting — the page reloads when Sloth is back.'
    : check.isPending
      ? 'Checking…'
      : v.checkError
        ? `Check failed: ${v.checkError}`
        : v.behind === undefined
          ? 'Not checked yet.'
          : v.behind === 0
            ? `Up to date with ${where} (checked ${ago(v.checkedAt)} ago).`
            : `${v.behind} commit${v.behind === 1 ? '' : 's'} behind ${where} (checked ${ago(v.checkedAt)} ago).`;
  return (
    <>
      <Row
        label="Version"
        hint={v.date ? `Commit ${v.commit ?? '?'} on ${v.branch ?? 'detached HEAD'}, ${new Date(v.date).toLocaleString()}. The patch is the number of PRs merged.` : undefined}
      >
        <span className="font-mono text-sm text-zinc-200">
          {v.version || '?'}
          {v.commit && <span className="text-zinc-500"> · {v.commit}</span>}
          {v.dirty && (
            <span className="ml-1 text-amber-400" title="Tracked files are changed in the checkout; a pull may refuse.">
              · local changes
            </span>
          )}
        </span>
      </Row>
      <Row
        label="Update"
        hint={
          <>
            {state}
            <br />
            Update runs <code>git pull --ff-only</code>, <code>pnpm install</code> and <code>pnpm build</code> in the Sloth checkout, then restarts
            this process with the same command line. Running sessions are not touched. Whatever wrapped it — <code>pnpm start</code>,{' '}
            <code>caffeinate</code> — exits with the old process.
          </>
        }
        wide
      >
        <span className="flex gap-2">
          <Button onClick={() => check.mutate()} disabled={busy || check.isPending}>
            {check.isPending ? 'Checking…' : 'Check'}
          </Button>
          <Button variant="primary" onClick={() => update.mutate()} disabled={busy || update.isPending || !v.behind}>
            {busy ? STEP[u.step ?? ''] ?? 'Updating…' : 'Update'}
          </Button>
        </span>
      </Row>
      {(u.output || u.error || update.error) && (
        <div className="space-y-1 py-3">
          {(u.error || update.error) && <p className="text-xs text-red-400">{u.error ?? String(update.error)}</p>}
          {u.output && (
            <pre className="max-h-64 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-[11px] whitespace-pre-wrap text-zinc-400">
              {u.output}
            </pre>
          )}
        </div>
      )}
    </>
  );
}
