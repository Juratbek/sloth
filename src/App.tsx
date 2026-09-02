import { useState } from 'react';
import useOverview from './hooks/use-overview';
import useLiveUpdates from './hooks/use-live-updates';
import useRoute from './hooks/use-route';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import SessionView from './components/SessionView';
import WatcherPanel from './components/WatcherPanel';
import BoardPage from './components/Board';
import RemoteDialog from './components/RemoteDialog';
import { isLocalPage } from './hooks/use-remote';
import { parseRoute, pathFor, type Page } from './lib/routes';
import Settings from './settings/Settings';
import Wizard from './setup/Wizard';
import { useConfig } from './setup/use-setup';
import { Button } from './setup/ui';

export default function App() {
  useLiveUpdates();
  const local = isLocalPage();
  const config = useConfig(local);
  const { data, error } = useOverview();
  const { path, navigate } = useRoute();
  const [remote, setRemote] = useState(false);
  // On a phone the session list and the page take turns; `menu` is which one shows. It is not a page:
  // opening the list is not somewhere the back button should return to.
  const [menu, setMenu] = useState(false);

  const wanted = parseRoute(path);
  // Configuring happens on the machine Sloth runs on; a phone reached Sloth through the tunnel, which
  // only starts once a config exists, so it skips the wizard and never calls the setup endpoints —
  // /settings and /setup opened on a phone show the monitor instead.
  const page = !local && (wanted.page === 'settings' || wanted.page === 'wizard') ? 'monitor' : wanted.page;
  const selected = wanted.sessionId ?? null;
  const go = (to: Page) => navigate(pathFor(to));
  // Picking a session is a page change too: a card on the board opens its run back on the monitor.
  const show = (id: string | null) => {
    setMenu(false);
    navigate(pathFor('monitor', id ?? undefined));
  };

  if (local && config.isPending) return <div className="p-6 text-fg-muted">Loading…</div>;
  // A read that failed is not "no config yet". Both left `data` undefined, so a transient failure of
  // GET /api/setup/config showed the get-started wizard to a configured user — and Save there writes a
  // config assembled from wizard defaults over the real ~/.sloth/config.json. `useConfig` answers null,
  // and only null, when the file is genuinely missing; anything else is said out loud and retried.
  if (local && config.isError)
    return (
      <div className="space-y-3 p-6">
        <p className="text-danger">Could not read the configuration: {String(config.error)}</p>
        <p className="text-sm text-fg-muted">Sloth is not showing the get-started wizard, because that would overwrite the configuration it cannot read.</p>
        <Button onClick={() => void config.refetch()}>Try again</Button>
      </div>
    );
  // No config file yet ⇒ the get-started wizard is the whole app, whatever the URL says.
  if (local && config.data === null) return <Wizard existing={null} />;
  if (page === 'wizard') return <Wizard existing={config.data!} onClose={() => go('settings')} />;
  if (page === 'settings')
    return (
      <Settings
        config={config.data!}
        section={wanted.section}
        onSection={(key) => navigate(pathFor('settings', key))}
        onClose={() => go('monitor')}
        onWizard={() => go('wizard')}
      />
    );

  if (error) return <div className="p-6 text-danger">Monitor API unreachable: {String(error)}</div>;
  if (!data) return <div className="p-6 text-fg-muted">Loading…</div>;
  if (page === 'board') return <BoardPage board={data.board} onSelect={show} onClose={() => go('monitor')} />;

  return (
    <div className="flex h-full flex-col">
      <TopBar
        overview={data}
        menu={menu}
        onMenu={() => setMenu(!menu)}
        onHome={() => show(null)}
        onBoard={() => go('board')}
        onSettings={local ? () => go('settings') : undefined}
        onRemote={local ? () => setRemote(true) : undefined}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar open={menu} sessions={data.sessions} selected={selected} onSelect={show} />
        <main className={`${menu ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col md:flex`}>
          {selected ? <SessionView key={selected} id={selected} config={data.config} /> : <WatcherPanel overview={data} onSelect={show} />}
        </main>
      </div>
      {remote && <RemoteDialog onClose={() => setRemote(false)} />}
    </div>
  );
}
