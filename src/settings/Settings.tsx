import { useEffect, useState, type ComponentType } from 'react';
import { CONFIG_DEFAULTS, DEFAULT_MODELS, defaultDirs } from '../../server/config-types';
import type { SlothConfig } from '../../server/config-types';
import { Button } from '../setup/ui';
import { useSaveConfig } from '../setup/use-setup';
import AboutSection from './AboutSection';
import BoardSection from './BoardSection';
import MachineSection from './MachineSection';
import NotificationsSection from './NotificationsSection';
import RepositorySection from './RepositorySection';
import StackSection from './StackSection';
import { Models } from './ModelsSection';
import { General, Remote, Sessions, Team } from './sections';
import type { SectionProps } from './ui';

type Key = 'general' | 'board' | 'repository' | 'stack' | 'team' | 'notifications' | 'models' | 'sessions' | 'remote' | 'machine' | 'about';

const pick = <K extends keyof typeof CONFIG_DEFAULTS>(...keys: K[]) =>
  Object.fromEntries(keys.map((k) => [k, CONFIG_DEFAULTS[k]])) as Pick<typeof CONFIG_DEFAULTS, K>;

/** The sections, in nav order. `defaults` is what Restore defaults puts back; a section without one has nothing to restore. */
const SECTIONS: { key: Key; label: string; component: ComponentType<SectionProps>; defaults?: (c: SlothConfig) => Partial<SlothConfig> }[] = [
  { key: 'general', label: 'General', component: General, defaults: () => pick('mention', 'botPrefix', 'boardSeconds', 'commentSeconds', 'chrome', 'previewHours', 'priorityField', 'autoMerge') },
  { key: 'board', label: 'Board', component: BoardSection },
  {
    key: 'repository',
    label: 'Repository',
    component: RepositorySection,
    defaults: (c) => {
      const { worktreesDir, sessionsDir } = defaultDirs(c.repo.split('/')[1] ?? '');
      return { ...pick('runnersDir', 'stateDir', 'watcherLog'), worktreesDir, sessionsDir };
    },
  },
  { key: 'stack', label: 'Stack', component: StackSection, defaults: () => pick('stack') },
  { key: 'team', label: 'Team', component: Team },
  { key: 'notifications', label: 'Notifications', component: NotificationsSection, defaults: () => pick('helpLogins', 'helpWebhook', 'webhookEvents') },
  { key: 'models', label: 'Models', component: Models, defaults: () => ({ models: { ...DEFAULT_MODELS } }) },
  { key: 'sessions', label: 'Sessions', component: Sessions, defaults: () => pick('maxActive', 'maxAlive', 'budgetMinutes', 'waitHours', 'reviewRounds', 'maxRetries', 'keepDays') },
  { key: 'remote', label: 'Remote access', component: Remote, defaults: () => pick('tunnel', 'publicUrl') },
  { key: 'machine', label: 'Machine', component: MachineSection, defaults: () => pick('autostart') },
  { key: 'about', label: 'About', component: AboutSection },
];

const navItem = 'rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap';

/**
 * Every value of the config, by section. Edits pile up in a draft; Save writes the whole config at once
 * (the server validates it, creates the columns that are still to be created, and restarts the watcher and
 * the tunnel on the new values). Only the machine Sloth runs on ever gets here.
 */
export default function Settings({ config, onClose, onWizard }: { config: SlothConfig; onClose: () => void; onWizard: () => void }) {
  const [key, setKey] = useState<Key>('general');
  const [baseline, setBaseline] = useState(config);
  const [draft, setDraft] = useState(config);
  /** Where the user wants to go with unsaved edits — asked to confirm first. */
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const save = useSaveConfig();
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  // The saved config can change underneath (the wizard just ran, a save landed): follow it while nothing is being edited.
  useEffect(() => {
    if (!dirty) {
      setBaseline(config);
      setDraft(config);
    }
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const section = SECTIONS.find((s) => s.key === key)!;
  const Section = section.component;
  const patch = (p: Partial<SlothConfig>) => setDraft((d) => ({ ...d, ...p }));
  // The guard is on Settings' own buttons only. The browser's back button changes the URL through
  // `popstate`, which is not worth fighting: going back leaves the draft behind without asking.
  const leave = (go: () => void) => (dirty ? setLeaving(() => go) : go());
  const discard = () => {
    setDraft(baseline);
    setLeaving(null);
    save.reset();
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <span className="text-sm font-semibold text-zinc-100">Sloth</span>
        <span className="text-xs text-zinc-500">
          Settings <span className="mx-1 text-zinc-700">/</span> <span className="text-zinc-300">{section.label}</span>
        </span>
        <span className="flex-1" />
        {section.defaults && (
          <button onClick={() => patch(section.defaults!(draft))} className="text-xs text-zinc-500 hover:text-zinc-200">
            ↺ Restore defaults
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-800 p-2 md:w-56 md:flex-col md:border-r md:border-b-0 md:p-3">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setKey(s.key)}
              aria-current={s.key === key ? 'page' : undefined}
              className={`${navItem} ${s.key === key ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'}`}
            >
              {s.label}
            </button>
          ))}
          <span className="hidden flex-1 md:block" />
          <button onClick={() => leave(onWizard)} className={`${navItem} text-zinc-500 hover:text-zinc-200`} title="Walk through the setup again, step by step">
            Setup wizard
          </button>
          <button onClick={() => leave(onClose)} className={`${navItem} text-zinc-500 hover:text-zinc-200`}>
            ← Back
          </button>
        </nav>

        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-6 py-6">
            <h1 className="text-lg font-semibold text-zinc-100">{section.label}</h1>
            <div className="mt-2 divide-y divide-zinc-900">
              <Section draft={draft} patch={patch} />
            </div>
          </div>
          {dirty && (
            <div className="sticky bottom-0 mt-auto border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
              <div className="mx-auto flex w-full max-w-2xl items-center gap-2 px-6 py-3 text-xs">
                {leaving ? (
                  <>
                    <span className="text-amber-300">Leave without saving?</span>
                    <span className="flex-1" />
                    <Button onClick={() => setLeaving(null)}>Stay</Button>
                    <Button variant="primary" onClick={leaving}>
                      Leave
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-zinc-400">Unsaved changes.</span>
                    {save.error && <span className="min-w-0 truncate text-red-400">{String(save.error)}</span>}
                    <span className="flex-1" />
                    <Button onClick={discard}>Discard</Button>
                    <Button
                      variant="primary"
                      disabled={save.isPending}
                      onClick={() =>
                        save.mutate(draft, {
                          onSuccess: (r) => {
                            setBaseline(r.config);
                            setDraft(r.config);
                          },
                        })
                      }
                    >
                      {save.isPending ? 'Saving…' : 'Save changes'}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
