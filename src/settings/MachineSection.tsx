import { useQuery } from '@tanstack/react-query';
import type { ServiceStatus } from '../../server/types';
import { fetchJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';
import { Row, Toggle } from './ui';
import type { SectionProps } from './ui';

/** What this Mac does with Sloth on its own — for now, whether it starts it at login. */
export default function MachineSection({ draft, patch }: SectionProps) {
  const service = useQuery({ queryKey: queryKeys.service, queryFn: () => fetchJson<ServiceStatus>('/api/service'), retry: false });
  const s = service.data;
  const state = !s
    ? 'Checking…'
    : !s.supported
      ? 'Only macOS is supported: the toggle saves, but nothing is registered here.'
      : s.installed
        ? `Registered as ${s.label} — it starts at the next login.`
        : 'Not registered.';
  return (
    <>
      <Row
        label="Start at login"
        hint={
          <>
            Registers Sloth with macOS launchd so it starts when you log in, restarts if it crashes and keeps the Mac awake
            (<code>caffeinate</code>). Turning it off unloads and removes the launch agent. Only on this machine. The agent serves the built
            UI, so the checkout needs a <code>pnpm build</code> first — the Update button in About builds too.
            <br />
            {state}
          </>
        }
        wide
      >
        <Toggle label="Start at login" checked={draft.autostart} onChange={(autostart) => patch({ autostart })} />
      </Row>
      {s?.error && <p className="py-3 text-xs text-red-400">{s.error}</p>}
    </>
  );
}
