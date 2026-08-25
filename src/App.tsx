import { useState } from 'react';
import useOverview from './hooks/use-overview';
import useLiveUpdates from './hooks/use-live-updates';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import SessionView from './components/SessionView';
import WatcherPanel from './components/WatcherPanel';
import Wizard from './setup/Wizard';
import { useConfig } from './setup/use-setup';

export default function App() {
  useLiveUpdates();
  const config = useConfig();
  const { data, error } = useOverview();
  const [settings, setSettings] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  if (config.isPending) return <div className="p-6 text-zinc-500">Loading…</div>;
  // No config file yet ⇒ the get-started wizard is the whole app.
  if (!config.data || settings)
    return <Wizard existing={config.data ?? null} onClose={config.data ? () => setSettings(false) : undefined} />;

  if (error) return <div className="p-6 text-red-400">Monitor API unreachable: {String(error)}</div>;
  if (!data) return <div className="p-6 text-zinc-500">Loading…</div>;

  return (
    <div className="flex h-full flex-col">
      <TopBar overview={data} onHome={() => setSelected(null)} onSettings={() => setSettings(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar sessions={data.sessions} selected={selected} onSelect={setSelected} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected ? <SessionView key={selected} id={selected} config={data.config} /> : <WatcherPanel overview={data} />}
        </main>
      </div>
    </div>
  );
}
