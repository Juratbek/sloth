import type { SetupCheck } from '../../server/config-types';
import { Button, Error, Loading } from './ui';
import { useSetupEnv } from './use-setup';

const HINTS: Record<string, { label: string; hint: string; href: string }> = {
  claude: { label: 'Claude Code', hint: 'Install Claude Code', href: 'https://docs.claude.com/en/docs/claude-code/quickstart' },
  gh: { label: 'GitHub CLI', hint: 'Install the gh CLI', href: 'https://cli.github.com' },
  ghAuth: { label: 'GitHub login', hint: 'Run `gh auth login`', href: 'https://cli.github.com/manual/gh_auth_login' },
};

function Row({ id, check }: { id: string; check: SetupCheck }) {
  const { label, hint, href } = HINTS[id];
  return (
    <div className="flex items-start gap-3 rounded-md border border-zinc-800 px-3 py-2">
      <span className={`text-sm ${check.ok ? 'text-emerald-400' : 'text-red-400'}`}>{check.ok ? '✓' : '✗'}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-100">{label}</p>
        <p className="truncate text-xs text-zinc-400">{check.version ?? check.login ?? check.error ?? ''}</p>
      </div>
      {!check.ok && (
        <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-zinc-400 underline hover:text-zinc-200">
          {hint}
        </a>
      )}
    </div>
  );
}

export default function StepEnv({ onContinue }: { onContinue: () => void }) {
  const { data, error, isFetching, refetch } = useSetupEnv();
  const ready = !!data && data.claude.ok && data.gh.ok && data.ghAuth.ok;

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">Sloth drives Claude Code through the GitHub CLI, so both have to be installed and logged in.</p>
      {error && <Error>{String(error)}</Error>}
      {!data && isFetching && <Loading what="environment" />}
      {data && (
        <div className="space-y-2">
          {(['claude', 'gh', 'ghAuth'] as const).map((id) => (
            <Row key={id} id={id} check={data[id]} />
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? 'Checking…' : 'Re-check'}
        </Button>
        <Button variant="primary" onClick={onContinue} disabled={!ready}>
          Continue
        </Button>
      </div>
    </div>
  );
}
