import { useState } from 'react';
import { Button, Choice, Field, NumberInput, TextInput } from './ui';
import type { Draft } from './use-setup';
import { useClone, useProjectFields } from './use-setup';

export default function StepRunner({
  draft,
  onBack,
  onContinue,
}: {
  draft: Draft;
  onBack: () => void;
  onContinue: (patch: Partial<Draft>) => void;
}) {
  const { data } = useProjectFields(draft.project?.id);
  const linked = data?.repositories ?? [];
  const clone = useClone();
  const [repo, setRepo] = useState(draft.repo);
  const [typed, setTyped] = useState(!!draft.repo && !linked.includes(draft.repo));
  const [root, setRoot] = useState<string | undefined>(draft.runnerRoot || undefined);
  const [caps, setCaps] = useState({ maxActive: draft.maxActive, maxAlive: draft.maxAlive, previewHours: draft.previewHours });

  const runnerRoot = root ?? (repo ? `~/.sloth/runners/${repo.split('/')[1]}` : '');
  const ready = /^[\w.-]+\/[\w.-]+$/.test(repo) && !!runnerRoot;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-zinc-400">Which repository do the sessions work in?</p>
        {linked.map((r) => (
          <Choice
            key={r}
            selected={!typed && repo === r}
            onSelect={() => {
              setTyped(false);
              setRepo(r);
            }}
            title={r}
          />
        ))}
        {linked.length > 0 && <Choice selected={typed} onSelect={() => setTyped(true)} title="Another repository…" subtitle="owner/repo" />}
        {(typed || linked.length === 0) && <TextInput value={repo} onChange={setRepo} placeholder="owner/repo" />}
      </div>

      <Field label="Runner root" hint="The checkout the sessions run from. The worktree slots the sessions work in are made next to it, under ~/.sloth/worktrees.">
        <TextInput value={runnerRoot} onChange={setRoot} placeholder="~/.sloth/runners/repo" />
      </Field>
      <div className="flex items-center gap-2">
        <Button disabled={!ready || clone.isPending} onClick={() => clone.mutate({ repo, path: runnerRoot })}>
          {clone.isPending ? 'Cloning…' : 'Clone it'}
        </Button>
        <span className="text-xs text-zinc-400">
          {clone.data?.ok
            ? `Ready at ${clone.data.path}`
            : clone.error
              ? String(clone.error)
              : 'Only needed if that folder does not exist yet.'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Max active sessions" hint="how many run at once">
          <NumberInput value={caps.maxActive} onChange={(maxActive) => setCaps({ ...caps, maxActive })} />
        </Field>
        <Field label="Max alive sessions" hint="active plus parked, before Sloth stops picking up">
          <NumberInput value={caps.maxAlive} onChange={(maxAlive) => setCaps({ ...caps, maxAlive })} />
        </Field>
        <Field label="Preview hours" hint="a finished session's app stays up behind a link on its PR this long; 0 turns previews off">
          <NumberInput min={0} value={caps.previewHours} onChange={(previewHours) => setCaps({ ...caps, previewHours })} />
        </Field>
      </div>

      <div className="flex gap-2">
        <Button onClick={onBack}>Back</Button>
        <Button
          variant="primary"
          disabled={!ready}
          onClick={() => onContinue({ repo, runnerRoot, ...caps })}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
