import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { TrelloInfo } from '../../server/trello-credentials';
import { fetchJson, postJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';
import { Button, Error, Field, inputStyle } from './ui';

type Connected = TrelloInfo & { username?: string; error?: string };

const trelloKey = ['setup', 'trello'] as const;

export const useTrelloInfo = () => useQuery({ queryKey: trelloKey, queryFn: () => fetchJson<TrelloInfo>('/api/setup/trello'), staleTime: 60_000, retry: false });

/** Saves the three values once Trello accepts them, then the boards list, the environment checks and the health chip all read the new state. */
function useConnectTrello() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { key: string; token: string; secret: string }) => postJson<Connected>('/api/setup/trello', body),
    onSuccess: () => {
      for (const queryKey of [trelloKey, queryKeys.setupEnv, queryKeys.setupProjects, queryKeys.health]) void queryClient.invalidateQueries({ queryKey });
    },
  });
}

function Secret({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <input type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} autoComplete="off" className={inputStyle} />;
}

/**
 * The Trello key, token and secret, typed here rather than into a file: the wizard's environment step
 * and Settings → Board both show it. Nothing saved is ever shown back — only that it is there.
 */
export default function TrelloConnect({ compact = false }: { compact?: boolean }) {
  const info = useTrelloInfo();
  const connect = useConnectTrello();
  const [key, setKey] = useState('');
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [open, setOpen] = useState(false);
  const state = info.data;
  const result = connect.data;
  const status = !state
    ? ''
    : state.source === 'env'
      ? 'Set in Sloth’s environment — the environment wins over anything typed here.'
      : state.configured
        ? `Connected${result?.username ? ` as ${result.username}` : ''}${state.secret ? ', webhook secret set' : ', no webhook secret — card comments are polled'}.`
        : 'Not connected. Sloth watches GitHub Projects boards only until a Trello key and token are given.';

  const form = (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">
        Open{' '}
        <a href="https://trello.com/power-ups/admin" target="_blank" rel="noreferrer" className="underline hover:text-zinc-300">
          trello.com/power-ups/admin
        </a>
        , create a Power-Up (any name), open its <b>API key</b> page: the key and the secret are there, and the <b>Token</b> link beside the key
        makes the token — approve it for the account the board is on. Paste all three here.
      </p>
      <Field label="API key">
        <Secret value={key} onChange={setKey} placeholder="32 hex characters" />
      </Field>
      <Field label="Token">
        <Secret value={token} onChange={setToken} placeholder="ATTA…" />
      </Field>
      <Field label="Secret" hint="Optional. With it Sloth sets up a Trello webhook, so a comment on a card is read within seconds instead of at the next poll.">
        <Secret value={secret} onChange={setSecret} placeholder="64 hex characters" />
      </Field>
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!key.trim() || !token.trim() || connect.isPending} onClick={() => connect.mutate({ key, token, secret })}>
          {connect.isPending ? 'Checking…' : 'Connect Trello'}
        </Button>
        {state?.configured && (
          <Button disabled={connect.isPending} onClick={() => connect.mutate({ key: '', token: '', secret: '' })}>
            Forget
          </Button>
        )}
      </div>
      {result?.error && <Error>{result.error}</Error>}
      {connect.error && <Error>{String(connect.error)}</Error>}
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-sm ${state?.configured ? 'text-emerald-400' : 'text-zinc-500'}`}>{state?.configured ? '✓' : '○'}</span>
        <p className="text-sm text-zinc-100">Trello</p>
        {compact && (
          <button className="text-xs text-zinc-400 underline hover:text-zinc-200" onClick={() => setOpen(!open)}>
            {open ? 'hide' : state?.configured ? 'change' : 'connect'}
          </button>
        )}
      </div>
      <p className="text-xs text-zinc-400">{status}</p>
      {(!compact || open) && state?.source !== 'env' && form}
    </div>
  );
}
