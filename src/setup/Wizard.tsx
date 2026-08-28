import { useState } from 'react';
import type { SlothConfig } from '../../server/config-types';
import StepColumns from './StepColumns';
import StepDone from './StepDone';
import StepEnv from './StepEnv';
import StepProject from './StepProject';
import StepRunner from './StepRunner';
import StepTeam from './StepTeam';
import type { Draft } from './use-setup';
import { draftFrom } from './use-setup';

type StepKey = 'env' | 'project' | 'columns' | 'runner' | 'team' | 'done';

const LABELS: Record<StepKey, string> = {
  env: 'Environment',
  project: 'Project board',
  columns: 'Columns',
  runner: 'Repository & runner',
  team: 'Team',
  done: 'Done',
};
const STEPS: StepKey[] = ['env', 'project', 'columns', 'runner', 'team', 'done'];

/**
 * The step-by-step setup: the whole app on the first run (no config yet), and re-runnable from Settings,
 * prefilled with `existing`. Settings is where single values get changed; the wizard is the guided walk.
 */
export default function Wizard({ existing, onClose }: { existing: SlothConfig | null; onClose?: () => void }) {
  const steps = STEPS;
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(existing));
  const key = steps[step];
  const next = (patch: Partial<Draft> = {}) => {
    setDraft({ ...draft, ...patch });
    setStep(step + 1);
  };
  const back = () => setStep(Math.max(0, step - 1));

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <span className="text-sm font-semibold text-zinc-100">Sloth</span>
        <span className="text-xs text-zinc-500">{existing ? 'Setup wizard' : 'Get started'}</span>
        <span className="flex-1" />
        {onClose && (
          <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-200">
            Close
          </button>
        )}
      </header>

      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <ol className="mb-6 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {steps.map((s, i) => (
            <li key={s} className={i === step ? 'text-zinc-100' : i < step ? 'text-zinc-500' : 'text-zinc-700'}>
              {i + 1}. {LABELS[s]}
            </li>
          ))}
        </ol>
        <h1 className="mb-4 text-lg font-semibold text-zinc-100">{LABELS[key]}</h1>

        {key === 'env' && <StepEnv onContinue={() => next()} />}
        {key === 'project' && (
          <StepProject
            selected={draft.project}
            onSelect={(project) => setDraft({ ...draft, project, ...(project.id === draft.project?.id ? {} : blank) })}
            onBack={back}
            onContinue={() => next()}
          />
        )}
        {key === 'columns' && <StepColumns draft={draft} onBack={back} onContinue={next} />}
        {key === 'runner' && <StepRunner draft={draft} onBack={back} onContinue={next} />}
        {key === 'team' && <StepTeam draft={draft} onBack={back} onContinue={next} />}
        {key === 'done' && <StepDone draft={draft} existing={existing} onBack={back} onSaved={() => onClose?.()} />}
      </div>
    </div>
  );
}

/** Picking a different board invalidates the columns chosen for the previous one. */
const blank = { statusFieldId: undefined, pickup: undefined, inProgress: undefined, needsHelp: undefined, codeReview: undefined, approved: undefined };
