import { useState } from 'react';
import { Button, Field, TextInput } from './ui';
import type { Draft } from './use-setup';
import { useSetupEnv } from './use-setup';

/** `alice, @bob` → `['alice', 'bob']`, in order, without repeats. */
const parse = (text: string) => [...new Set(text.split(/[\s,]+/).map((l) => l.replace(/^@/, '')).filter(Boolean))];

export default function StepTeam({
  draft,
  onBack,
  onContinue,
}: {
  draft: Draft;
  onBack: () => void;
  onContinue: (patch: Partial<Draft>) => void;
}) {
  const login = useSetupEnv().data?.ghAuth.login ?? '';
  const [admin, setAdmin] = useState<string | undefined>(draft.admin || undefined);
  const [developers, setDevelopers] = useState(draft.developers.join(', '));
  const [testers, setTesters] = useState(draft.testers.join(', '));

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        {draft.project?.provider === 'trello'
          ? 'Who may talk to Sloth on the cards. Sloth only listens to these Trello usernames (without the @) — a comment from anyone else is ignored.'
          : 'Who may talk to Sloth in issue comments. Sloth only listens to these GitHub logins — a mention from anyone else is ignored.'}
      </p>

      <Field label="Admin" hint="One login. Orders Sloth anything: work on an issue, move a card to any column, close an issue.">
        <TextInput value={admin ?? login} onChange={setAdmin} placeholder={draft.project?.provider === 'trello' ? 'your-trello-username' : 'your-github-login'} />
      </Field>
      <Field
        label="Developers"
        hint="Order work on an issue, within that issue — implement it, change the approach, address the review comments, start over, stop. Anything beyond the issue becomes a question for the admin."
      >
        <TextInput value={developers} onChange={setDevelopers} placeholder="alice, bob" />
      </Field>
      <Field label="Testers" hint="Answer the questions a parked card asks and ask for status; they cannot give orders.">
        <TextInput value={testers} onChange={setTesters} placeholder="carol, dave" />
      </Field>

      <div className="flex gap-2">
        <Button onClick={onBack}>Back</Button>
        <Button
          variant="primary"
          onClick={() => onContinue({ admin: (admin ?? login).trim().replace(/^@/, ''), developers: parse(developers), testers: parse(testers) })}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
