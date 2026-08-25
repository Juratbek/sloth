import { useState } from 'react';
import useOverview from './hooks/use-overview';
import useLiveUpdates from './hooks/use-live-updates';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import SessionView from './components/SessionView';
import WatcherPanel from './components/WatcherPanel';

export default function App() {
  useLiveUpdates();
  const { data, error } = useOverview();
  const [selected, setSelected] = useState<string | null>(null);

  if (error) return <div className="p-6 text-red-400">Monitor API unreachable: {String(error)}</div>;
  if (!data) return <div className="p-6 text-zinc-500">Loading…</div>;

  return (
    <div className="flex h-full flex-col">
      <TopBar overview={data} onHome={() => setSelected(null)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar sessions={data.sessions} selected={selected} onSelect={setSelected} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected ? <SessionView key={selected} id={selected} config={data.config} /> : <WatcherPanel overview={data} />}
        </main>
      </div>
    </div>
  );
}
