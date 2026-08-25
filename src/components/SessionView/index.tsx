import { useState } from 'react';
import type { MonitorConfig } from '../../../server/types';
import useSession from '../../hooks/use-session';
import Agents from '../Agents';
import Chat from '../Chat';
import AgentView from './AgentView';
import Header from './Header';
import WatcherTab from './WatcherTab';

type Tab = 'chat' | 'agents' | 'watcher';

export default function SessionView({ id, config }: { id: string; config: MonitorConfig }) {
  const { data, error } = useSession(id);
  const [tab, setTab] = useState<Tab>('chat');
  const [agentId, setAgentId] = useState<string | null>(null);

  if (error) return <div className="p-6 text-red-400">Session unavailable: {String(error)}</div>;
  if (!data) return <div className="p-6 text-zinc-500">Loading session…</div>;

  const openAgent = (a: string) => {
    setAgentId(a);
    setTab('agents');
  };
  const tabs: [Tab, string][] = [
    ['chat', 'Chat'],
    ['agents', `Subagents (${data.agents.length})`],
    ['watcher', 'Watcher'],
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header s={data} config={config} />
      <nav className="flex gap-1 border-b border-zinc-800 px-3">
        {tabs.map(([value, text]) => (
          <button
            key={value}
            onClick={() => {
              setTab(value);
              setAgentId(null);
            }}
            className={`px-3 py-1.5 text-xs ${tab === value ? 'border-b-2 border-sky-500 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            {text}
          </button>
        ))}
      </nav>
      {agentId ? (
        <AgentView key={agentId} id={id} agentId={agentId} onBack={() => setAgentId(null)} />
      ) : tab === 'chat' ? (
        <Chat key={id} messages={data.messages} live={data.live} onOpenAgent={openAgent} />
      ) : tab === 'agents' ? (
        <Agents agents={data.agents} onOpen={setAgentId} />
      ) : (
        <WatcherTab watcher={data.watcher} />
      )}
    </div>
  );
}
