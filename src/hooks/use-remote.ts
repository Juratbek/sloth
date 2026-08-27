import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import type { RemoteLink } from '../../server/types';
import { fetchJson, postJson } from '../lib/api';

const REMOTE_QUERY_KEY = ['remote'] as const;

/** Whether this page is open on the machine Sloth runs on — the only place /api/remote answers. */
export const isLocalPage = () => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);

export interface Remote extends RemoteLink {
  /** The link as a QR code, a data URL. */
  qr?: string;
}

async function load(): Promise<Remote> {
  const r = await fetchJson<RemoteLink>('/api/remote');
  if (!r.link) return r;
  const qr = await QRCode.toDataURL(r.link, { margin: 1, width: 320, color: { dark: '#09090b', light: '#ffffff' } });
  return { ...r, qr };
}

export function useRemote(enabled: boolean) {
  return useQuery({
    queryKey: REMOTE_QUERY_KEY,
    queryFn: load,
    enabled,
    // Quicker while brew is talking, so its output and the moment the QR appears show up promptly.
    refetchInterval: (query) => (query.state.data?.install.running ? 1_500 : 5_000),
  });
}

/** Installs the tunnel tool with Homebrew; the QR appears by itself once the tunnel is up. */
export function useInstall() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<RemoteLink>('/api/remote/install', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: REMOTE_QUERY_KEY }),
  });
}

/** A new secret: the QR changes and every phone that scanned the old one is signed out. */
export function useRotate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<RemoteLink>('/api/remote/rotate', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: REMOTE_QUERY_KEY }),
  });
}
