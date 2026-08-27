import { useState } from 'react';
import useOverview from './hooks/use-overview';
import useLiveUpdates from './hooks/use-live-updates';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import SessionView from './components/SessionView';
import WatcherPanel from './components/WatcherPanel';
import RemoteDialog from './components/RemoteDialog';
import { isLocalPage } from './hooks/use-remote';
import Wizard from './setup/Wizard';
import { useConfig } from './setup/use-setup';

export default function App() {
  useLiveUpdates();
  // Configuring happens on the machine Sloth runs on; a phone reached Sloth through the tunnel, which
  // only starts once a config exists, so it skips the wizard and never calls the setup endpoints.
  const local = isLocalPage();
  const config = useConfig(local);
  const { data, error } = useOverview();
  const [settings, setSettings] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [remote, setRemote] = useState(false);
  // On a phone the session list and the page take turns; `menu` is which one shows.
  const [menu, setMenu] = useState(false);
  const show = (id: string | null) => {
    setSelected(id);
    setMenu(false);
  };

  if (local && config.isPending) return <div className="p-6 text-zinc-500">Loading…</div>;
  // No config file yet ⇒ the get-started wizard is the whole app.
  if (local && (!config.data || settings))
    return <Wizard existing={config.data ?? null} onClose={config.data ? () => setSettings(false) : undefined} />;

  if (error) return <div className="p-6 text-red-400">Monitor API unreachable: {String(error)}</div>;
  if (!data) return <div className="p-6 text-zinc-500">Loading…</div>;

  return (
    <div className="flex h-full flex-col">
      <TopBar
        overview={data}
        menu={menu}
        onMenu={() => setMenu(!menu)}
        onHome={() => show(null)}
        onSettings={local ? () => setSettings(true) : undefined}
        onRemote={local ? () => setRemote(true) : undefined}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar open={menu} sessions={data.sessions} selected={selected} onSelect={show} />
        <main className={`${menu ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col md:flex`}>
          {selected ? <SessionView key={selected} id={selected} config={data.config} /> : <WatcherPanel overview={data} />}
        </main>
      </div>
      {remote && <RemoteDialog onClose={() => setRemote(false)} />}
    </div>
  );
}
