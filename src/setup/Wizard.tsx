import { useState } from 'react';
import type { SlothConfig } from '../../server/types';
import StepColumns from './StepColumns';
import StepDone from './StepDone';
import StepEnv from './StepEnv';
import StepProject from './StepProject';
import StepRunner from './StepRunner';
import type { Draft } from './use-setup';
import { draftFrom } from './use-setup';

const STEPS = ['Environment', 'Project board', 'Columns', 'Repository & runner', 'Done'];

export default function Wizard({ existing, onClose }: { existing: SlothConfig | null; onClose?: () => void }) {
  const [step, setStep] = useState(existing ? 1 : 0);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(existing));
  const next = (patch: Partial<Draft> = {}) => {
    setDraft({ ...draft, ...patch });
    setStep(step + 1);
  };
  const back = () => setStep(step - 1);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <span className="text-sm font-semibold text-zinc-100">Sloth</span>
        <span className="text-xs text-zinc-500">{existing ? 'Settings' : 'Get started'}</span>
        <span className="flex-1" />
        {onClose && (
          <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-200">
            Close
          </button>
        )}
      </header>

      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <ol className="mb-6 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'text-zinc-100' : i < step ? 'text-zinc-500' : 'text-zinc-700'}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>
        <h1 className="mb-4 text-lg font-semibold text-zinc-100">{STEPS[step]}</h1>

        {step === 0 && <StepEnv onContinue={() => next()} />}
        {step === 1 && (
          <StepProject
            selected={draft.project}
            onSelect={(project) => setDraft({ ...draft, project, ...(project.id === draft.project?.id ? {} : blank) })}
            onBack={() => setStep(0)}
            onContinue={() => next()}
          />
        )}
        {step === 2 && <StepColumns draft={draft} onBack={back} onContinue={next} />}
        {step === 3 && <StepRunner draft={draft} onBack={back} onContinue={next} />}
        {step === 4 && <StepDone draft={draft} existing={existing} onBack={back} onSaved={() => onClose?.()} />}
      </div>
    </div>
  );
}

/** Picking a different board invalidates the columns chosen for the previous one. */
const blank = { statusFieldId: undefined, pickup: undefined, inProgress: undefined, needsHelp: undefined, codeReview: undefined };
