import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VersionInfo } from '../../server/types';
import { fetchJson, postJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

const CHECK_EVERY_MS = 10 * 60_000;

/**
 * Sloth's version and its update. While an update runs the poll is quick, so its output streams; once
 * the server says it is restarting, the page waits for it to go away and come back, then reloads —
 * the UI it is showing was built before the pull.
 */
export function useVersion(enabled: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.update,
    queryFn: () => fetchJson<VersionInfo>('/api/update'),
    enabled,
    retry: false,
    refetchInterval: (q) => (q.state.data?.update.running || q.state.data?.update.restarting || q.state.error ? 1_500 : 15_000),
  });
  const restarting = !!query.data?.update.restarting;
  const down = useRef(false);
  // Effect is unavoidable: it watches the poll for the restart's gap and reloads the page after it.
  useEffect(() => {
    if (restarting) down.current = true;
    else if (down.current && query.isError) down.current = true;
    if (down.current && query.isSuccess && !restarting) location.reload();
  }, [restarting, query.isError, query.isSuccess]);
  const check = useMutation({
    mutationFn: () => postJson<VersionInfo>('/api/update/check', {}),
    onSuccess: (v) => queryClient.setQueryData(queryKeys.update, v),
  });
  const update = useMutation({
    mutationFn: () => postJson<VersionInfo>('/api/update/run', {}),
    onSuccess: (v) => queryClient.setQueryData(queryKeys.update, v),
  });
  // One check when the section opens, unless a recent one is on record.
  const checkedAt = query.data?.checkedAt;
  const stale = query.isSuccess && (!checkedAt || Date.now() - Date.parse(checkedAt) > CHECK_EVERY_MS);
  useEffect(() => {
    if (enabled && stale && !check.isPending && !query.data?.update.running) check.mutate();
  }, [enabled, stale]); // eslint-disable-line react-hooks/exhaustive-deps
  return { query, check, update };
}
