import { useState } from 'react';
import type { RepoConfig } from '../../server/config-types';
import RepoPicker from './RepoPicker';
import { CheckoutField, NoteField } from './RepoFields';
import { Button, Field, NumberInput } from './ui';
import type { Draft } from './use-setup';
import { REPO_RE, useProjectFields, useSetupEnv } from './use-setup';

/**
 * Which repositories the sessions work in — one or several. Every repository the logged-in GitHub account
 * can reach is listed and ticked off; one it cannot see can still be named by hand. A ticked repository
 * opens on its checkout path (cloned by Sloth once the setup is saved) and, once there are several, a
 * one-line note saying what it is, which is what a card that names no repository is placed by. The first
 * picked is where a run with no card of its own — the smoke test — works.
 */
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
  const home = useSetupEnv().data?.home ?? '~/.sloth';
  const linked = data?.repositories ?? [];
  const [repos, setRepos] = useState<RepoConfig[]>(draft.repos);
  const [caps, setCaps] = useState({ maxActive: draft.maxActive, maxAlive: draft.maxAlive, previewHours: draft.previewHours });

  const update = (at: number, patch: Partial<RepoConfig>) => setRepos(repos.map((r, i) => (i === at ? { ...r, ...patch } : r)));
  const ready = repos.length > 0 && repos.every((r) => REPO_RE.test(r.slug) && r.root.trim());

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-fg-muted">Which repositories do the sessions work in? Tick one or several.</p>
        <RepoPicker
          repos={repos}
          onChange={setRepos}
          linked={linked}
          home={home}
          bounded
          details={(repo, at) => (
            <div className="space-y-2">
              {at === 0 && repos.length > 1 && <p className="text-[11px] text-fg-faint">first — the smoke test and the stack install run here</p>}
              <CheckoutField repo={repo} onChange={(root) => update(at, { root })} />
              {repos.length > 1 && <NoteField repo={repo} onChange={(note) => update(at, { note })} />}
            </div>
          )}
        />
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
        <Button variant="primary" disabled={!ready} onClick={() => onContinue({ repos, ...caps })}>
          Continue
        </Button>
      </div>
    </div>
  );
}
