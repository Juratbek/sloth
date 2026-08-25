import { useMemo, useState } from 'react';
import type { ColumnRef } from '../../server/types';
import { Button, Choice, Error, Field, Loading, Select } from './ui';
import type { Draft } from './use-setup';
import { useProjectFields } from './use-setup';

type Role = 'pickup' | 'inProgress' | 'needsHelp' | 'codeReview';
type Picked = Partial<Record<Role, ColumnRef | null>>;

const MATCH: Record<Role, RegExp> = {
  pickup: /^\s*to[\s_-]?do\s*$/i,
  inProgress: /in[\s_-]?progress/i,
  needsHelp: /needs?[\s_-]?help|blocked|question/i,
  codeReview: /review/i,
};
const OTHERS: { role: Role; label: string; hint: string }[] = [
  { role: 'inProgress', label: 'In Progress', hint: 'where a card goes while a session works on it' },
  { role: 'needsHelp', label: 'Needs help', hint: 'where a blocked session parks its card — optional' },
  { role: 'codeReview', label: 'Code Review', hint: 'where a card goes once its PR is open' },
];

export default function StepColumns({
  draft,
  onBack,
  onContinue,
}: {
  draft: Draft;
  onBack: () => void;
  onContinue: (patch: Partial<Draft>) => void;
}) {
  const { data, error, isFetching } = useProjectFields(draft.project?.id);
  const options = useMemo(() => data?.statusField?.options ?? [], [data]);
  const [picked, setPicked] = useState<Picked>({
    pickup: draft.pickup,
    inProgress: draft.inProgress,
    needsHelp: draft.needsHelp,
    codeReview: draft.codeReview,
  });

  // Untouched roles fall back to the first column whose name matches that role.
  const value = (role: Role): ColumnRef | null =>
    picked[role] !== undefined ? picked[role]! : (options.find((o) => MATCH[role].test(o.name)) ?? null);
  const set = (role: Role, id: string) => setPicked({ ...picked, [role]: options.find((o) => o.id === id) ?? null });

  const ready = !!data?.statusField && !!value('pickup') && !!value('inProgress') && !!value('codeReview');

  return (
    <div className="space-y-4">
      {error && <Error>{String(error)}</Error>}
      {!data && isFetching && <Loading what="columns" />}
      {data && !data.statusField && <Error>This project has no Status field — add one on the board first.</Error>}
      {data?.statusField && (
        <>
          <div className="space-y-2">
            <p className="text-sm text-zinc-400">Which column should Sloth keep an eye on?</p>
            <div className="max-h-[34vh] space-y-1.5 overflow-y-auto pr-1">
              {options.map((o) => (
                <Choice key={o.id} selected={value('pickup')?.id === o.id} onSelect={() => set('pickup', o.id)} title={o.name} />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {OTHERS.map(({ role, label, hint }) => (
              <Field key={role} label={label} hint={hint}>
                <Select value={value(role)?.id ?? ''} onChange={(id) => set(role, id)} options={options} />
              </Field>
            ))}
          </div>
        </>
      )}
      <div className="flex gap-2">
        <Button onClick={onBack}>Back</Button>
        <Button
          variant="primary"
          disabled={!ready}
          onClick={() =>
            onContinue({
              statusFieldId: data!.statusField!.id,
              pickup: value('pickup')!,
              inProgress: value('inProgress')!,
              needsHelp: value('needsHelp'),
              codeReview: value('codeReview')!,
            })
          }
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
