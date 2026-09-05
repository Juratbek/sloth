import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { GhLogin as Status } from '../../server/config-types';
import { fetchJson, postJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';
import { Button } from './ui';

const key = queryKeys.setupGhLogin;

/** The login in flight, read every second and a half while `gh` waits for the code to be entered. */
const useGhLoginStatus = () =>
  useQuery({
    queryKey: key,
    queryFn: () => fetchJson<Status>('/api/setup/gh-login'),
    refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
    retry: false,
  });

/** A POST that answers with the login's new state, which becomes the status without another read. */
function useGhLoginPost(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<Status>(path, {}),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });
}

function Code({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => setCopied(true));
  };
  return (
    <button type="button" onClick={copy} title="Copy the code" className="rounded border border-edge bg-surface-raised px-2 py-0.5 font-mono text-sm tracking-widest text-fg-strong hover:bg-surface-inset">
      {code}
      <span className="ml-2 font-sans text-[11px] tracking-normal text-fg-muted">{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}

/**
 * The GitHub login row's action: one button runs `gh auth login` on the machine, which opens the
 * browser there and prints a one-time code — shown here to type at the URL, and copied with a click.
 * Once `gh` reports the login, the environment checks, the boards and the health chip are read again.
 */
export default function GhLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
  const status = useGhLoginStatus();
  const start = useGhLoginPost('/api/setup/gh-login');
  const cancel = useGhLoginPost('/api/setup/gh-login/cancel');
  const queryClient = useQueryClient();
  const state = status.data;
  const running = !!state?.running;
  const error = start.error ?? cancel.error ?? (state?.error ? new Error(state.error) : undefined);

  useEffect(() => {
    if (!state?.ok) return;
    for (const queryKey of [queryKeys.setupEnv, queryKeys.setupProjects, queryKeys.health]) void queryClient.invalidateQueries({ queryKey });
    onLoggedIn();
  }, [state?.ok]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {running ? (
          <Button onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Cancel
          </Button>
        ) : (
          <Button variant="accent" onClick={() => start.mutate()} disabled={start.isPending}>
            {state?.ok ? 'Log in again' : 'Log in'}
          </Button>
        )}
        {running && !state?.code && <span className="text-xs text-fg-muted">Starting gh…</span>}
        {state?.ok && !running && <span className="text-xs text-ok">Logged in — checking…</span>}
      </div>
      {running && state?.code && (
        <div className="space-y-1 text-xs text-fg-muted">
          <p>
            A browser tab opened on this machine. Enter this code there
            {state.url && (
              <>
                {' '}
                or at{' '}
                <a href={state.url} target="_blank" rel="noreferrer" className="underline hover:text-fg">
                  {state.url.replace(/^https:\/\//, '')}
                </a>
              </>
            )}
            :
          </p>
          <Code code={state.code} />
          <p>Waiting for GitHub to confirm…</p>
        </div>
      )}
      {error && <p className="text-xs text-danger">{String(error instanceof Error ? error.message : error)}</p>}
    </div>
  );
}
