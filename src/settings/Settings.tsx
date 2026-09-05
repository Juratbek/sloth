import { useEffect, useState, type ComponentType } from 'react';
import { CONFIG_DEFAULTS, DEFAULT_MODELS, defaultDirs } from '../../server/config-types';
import type { SlothConfig } from '../../server/config-types';
import { Button } from '../setup/ui';
import { useSaveConfig, useSetupEnv } from '../setup/use-setup';
import AboutSection from './AboutSection';
import BoardSection from './BoardSection';
import MachineSection from './MachineSection';
import NotificationsSection from './NotificationsSection';
import QaSection from './QaSection';
import RepositorySection from './RepositorySection';
import StackSection from './StackSection';
import { Models } from './ModelsSection';
import { General, Remote, Sessions, Team } from './sections';
import type { SectionProps } from './ui';

type Key = 'general' | 'board' | 'qa' | 'repository' | 'stack' | 'team' | 'notifications' | 'models' | 'sessions' | 'remote' | 'machine' | 'about';

const pick = <K extends keyof typeof CONFIG_DEFAULTS>(...keys: K[]) =>
  Object.fromEntries(keys.map((k) => [k, CONFIG_DEFAULTS[k]])) as Pick<typeof CONFIG_DEFAULTS, K>;

/** The sections, in nav order. `defaults` is what Restore defaults puts back; a section without one has nothing to restore. */
/** What Restore defaults puts back; `home` is this instance's — a second instance must not be sent to the first one's directories. */
const SECTIONS: { key: Key; label: string; component: ComponentType<SectionProps>; defaults?: (c: SlothConfig, home: string) => Partial<SlothConfig> }[] = [
  { key: 'general', label: 'General', component: General, defaults: () => pick('mention', 'botPrefix', 'boardSeconds', 'commentSeconds', 'fallbackCommentSeconds', 'chrome', 'previewHours', 'priorityField', 'autoMerge', 'resolveConflicts') },
  { key: 'board', label: 'Board', component: BoardSection },
  { key: 'qa', label: 'QA sweep', component: QaSection, defaults: () => pick('qa') },
  {
    key: 'repository',
    label: 'Repository',
    component: RepositorySection,
    defaults: (c, home) => {
      const { runnersDir, worktreesDir, sessionsDir, stateDir, watcherLog } = defaultDirs(c.repo.split('/')[1] ?? '', home);
      return { runnersDir, worktreesDir, sessionsDir, stateDir, watcherLog };
    },
  },
  { key: 'stack', label: 'Stack', component: StackSection, defaults: () => pick('stack') },
  { key: 'team', label: 'Team', component: Team },
  { key: 'notifications', label: 'Notifications', component: NotificationsSection, defaults: () => pick('helpLogins', 'helpWebhook', 'webhookEvents') },
  { key: 'models', label: 'Models', component: Models, defaults: () => ({ models: { ...DEFAULT_MODELS }, ...pick('orchestrator') }) },
  { key: 'sessions', label: 'Sessions', component: Sessions, defaults: () => pick('maxActive', 'maxAlive', 'minFreeMemory', 'minIdleCpu', 'minIdleDisk', 'machineSeconds', 'warmSlots', 'budgetMinutes', 'waitHours', 'reviewRounds', 'maxRetries', 'keepDays') },
  { key: 'remote', label: 'Remote access', component: Remote, defaults: () => pick('tunnel', 'publicUrl', 'liveLinks') },
  { key: 'machine', label: 'Machine', component: MachineSection, defaults: () => pick('autostart') },
  { key: 'about', label: 'About', component: AboutSection, defaults: () => pick('autoUpdate', 'updateSeconds') },
];

const navItem = 'rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap';

/**
 * Every value of the config, by section. Edits pile up in a draft; Save writes the whole config at once
 * (the server validates it, creates the columns that are still to be created, and restarts the watcher and
 * the tunnel on the new values). Only the machine Sloth runs on ever gets here.
 *
 * The open section comes from the URL (`/settings/about`), so a refresh keeps it; picking one calls `onSection`.
 * A section the URL names that does not exist shows the first one.
 */
export default function Settings({
  config,
  section: wanted,
  onSection,
  onClose,
  onWizard,
}: {
  config: SlothConfig;
  section?: string;
  onSection: (key: Key) => void;
  onClose: () => void;
  onWizard: () => void;
}) {
  const [baseline, setBaseline] = useState(config);
  const [draft, setDraft] = useState(config);
  /** Where the user wants to go with unsaved edits — asked to confirm first. */
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const save = useSaveConfig();
  const home = useSetupEnv().data?.home ?? '~/.sloth';
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  // The saved config can change underneath (the wizard just ran, a save landed): follow it while nothing is being edited.
  useEffect(() => {
    if (!dirty) {
      setBaseline(config);
      setDraft(config);
    }
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const section = SECTIONS.find((s) => s.key === wanted) ?? SECTIONS[0];
  const key = section.key;
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
        <span className="text-xs text-zinc-400">
          Settings <span className="mx-1 text-zinc-500">/</span> <span className="text-zinc-300">{section.label}</span>
        </span>
        <span className="flex-1" />
        {section.defaults && (
          <button
            onClick={() => {
              // Destructive and one click away from every section: it overwrites what is on this page,
              // saved or not. Asked the way the session view asks before it stops a run.
              if (window.confirm(`Restore the ${section.label} defaults? Every value in this section goes back to Sloth's own, replacing what is there.`)) {
                patch(section.defaults!(draft, home));
              }
            }}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            ↺ Restore defaults
          </button>
        )}
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[1240px] flex-1 flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-800 p-2 md:w-56 md:flex-col md:border-r md:border-b-0 md:p-3">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => onSection(s.key)}
              aria-current={s.key === key ? 'page' : undefined}
              className={`${navItem} ${s.key === key ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'}`}
            >
              {s.label}
            </button>
          ))}
          <span className="hidden flex-1 md:block" />
          <button onClick={() => leave(onWizard)} className={`${navItem} text-zinc-400 hover:text-zinc-200`} title="Walk through the setup again, step by step">
            Setup wizard
          </button>
          <button onClick={() => leave(onClose)} className={`${navItem} text-zinc-400 hover:text-zinc-200`}>
            ← Back
          </button>
        </nav>

        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="w-full px-6 py-6">
            <h1 className="text-lg font-semibold text-zinc-100">{section.label}</h1>
            <div className="mt-2 divide-y divide-zinc-900">
              <Section draft={draft} patch={patch} />
            </div>
          </div>
          {dirty && (
            <div className="sticky bottom-0 mt-auto border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
              <div className="flex w-full items-center gap-2 px-6 py-3 text-xs">
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
