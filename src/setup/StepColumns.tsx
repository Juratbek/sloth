import { useMemo, useState } from 'react';
import { DEFAULT_COLUMN_NAMES } from '../../server/config-types';
import type { ColumnRef, ColumnRole } from '../../server/config-types';
import { Button, Choice, Error, Field, Loading, Select, TextInput } from './ui';
import type { Draft } from './use-setup';
import { useProjectFields } from './use-setup';

type Picked = Partial<Record<ColumnRole, ColumnRef>>;

const MATCH: Record<ColumnRole, RegExp> = {
  pickup: /^\s*to[\s_-]?do\s*$/i,
  inProgress: /in[\s_-]?progress/i,
  needsHelp: /needs?[\s_-]?help|blocked|question/i,
  codeReview: /review/i,
  approved: /approved|accepted/i,
};
const OTHERS: { role: ColumnRole; label: string; hint: string }[] = [
  { role: 'inProgress', label: 'In Progress', hint: 'where a card goes while a session works on it' },
  { role: 'needsHelp', label: 'Needs help', hint: 'where a blocked session parks its card' },
  { role: 'codeReview', label: 'Code Review', hint: 'where a card goes once its PR is open' },
  { role: 'approved', label: 'Approved', hint: 'cards you approve get a final review of their PR' },
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
    approved: draft.approved,
  });
  const [helpLogins, setHelpLogins] = useState(draft.helpLogins.join(', '));
  const [helpWebhook, setHelpWebhook] = useState(draft.helpWebhook);

  // Untouched roles fall back to the first column whose name matches; with no match Sloth creates one.
  const value = (role: ColumnRole): ColumnRef => {
    const chosen = picked[role];
    if (chosen && (!chosen.id || options.some((o) => o.id === chosen.id))) return chosen;
    return options.find((o) => MATCH[role].test(o.name)) ?? { id: '', name: DEFAULT_COLUMN_NAMES[role] };
  };
  const set = (role: ColumnRole, id: string) =>
    setPicked({ ...picked, [role]: options.find((o) => o.id === id) ?? { id: '', name: DEFAULT_COLUMN_NAMES[role] } });

  const ready = !!data?.statusField && !!value('pickup').id;

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
                <Choice key={o.id} selected={value('pickup').id === o.id} onSelect={() => set('pickup', o.id)} title={o.name} />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {OTHERS.map(({ role, label, hint }) => (
              <Field key={role} label={label} hint={value(role).id ? hint : `“${value(role).name}” will be created`}>
                <Select
                  value={value(role).id}
                  onChange={(id) => set(role, id)}
                  options={options}
                  placeholder={`create “${DEFAULT_COLUMN_NAMES[role]}”`}
                />
              </Field>
            ))}
          </div>
          <div className="space-y-2">
            <p className="text-sm text-zinc-400">Who should hear about a card landing in “{value('needsHelp').name}”?</p>
            <Field
              label="GitHub logins to mention"
              hint="Mentioned in the comment Sloth writes when it parks a card, so GitHub notifies them. Leave out the login gh is signed in as — GitHub never notifies an account of its own mention."
            >
              <TextInput value={helpLogins} onChange={setHelpLogins} placeholder="alice, bob" />
            </Field>
            <Field
              label="Webhook URL"
              hint="Optional. A Slack or Discord incoming webhook (or your own endpoint) gets a JSON POST with the issue each time a card lands in that column, within one board poll."
            >
              <TextInput value={helpWebhook} onChange={setHelpWebhook} placeholder="https://hooks.slack.com/services/…" />
            </Field>
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
              pickup: value('pickup'),
              inProgress: value('inProgress'),
              needsHelp: value('needsHelp'),
              codeReview: value('codeReview'),
              approved: value('approved'),
              helpLogins: helpLogins.split(/[\s,]+/).map((l) => l.replace(/^@/, '')).filter(Boolean),
              helpWebhook: helpWebhook.trim(),
            })
          }
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
