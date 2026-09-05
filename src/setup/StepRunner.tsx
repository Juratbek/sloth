import { useState } from 'react';
import type { RepoConfig } from '../../server/config-types';
import { Button, Choice, Field, NumberInput, TextInput } from './ui';
import type { Draft } from './use-setup';
import { REPO_RE, newRepo, useProjectFields, useSetupEnv } from './use-setup';

/**
 * Which repositories the sessions work in — one or several. The board's linked repositories are offered
 * as toggles; any other is typed as `owner/repo`. Each picked repository gets its checkout path (cloned by
 * Sloth once the setup is saved) and a one-line note saying what it is, which is what a card that names no
 * repository is placed by. The first picked is where a run with no card of its own — the smoke test — works.
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
  const [typed, setTyped] = useState('');
  const [caps, setCaps] = useState({ maxActive: draft.maxActive, maxAlive: draft.maxAlive, previewHours: draft.previewHours });

  const has = (slug: string) => repos.some((r) => r.slug.toLowerCase() === slug.toLowerCase());
  const toggle = (slug: string) => setRepos(has(slug) ? repos.filter((r) => r.slug.toLowerCase() !== slug.toLowerCase()) : [...repos, newRepo(slug, home)]);
  const add = () => {
    const slug = typed.trim();
    if (!REPO_RE.test(slug) || has(slug)) return;
    setRepos([...repos, newRepo(slug, home)]);
    setTyped('');
  };
  const update = (slug: string, patch: Partial<RepoConfig>) => setRepos(repos.map((r) => (r.slug === slug ? { ...r, ...patch } : r)));
  const ready = repos.length > 0 && repos.every((r) => REPO_RE.test(r.slug) && r.root.trim());

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-zinc-400">Which repositories do the sessions work in? Pick one or several.</p>
        {linked.map((r) => (
          <Choice key={r} selected={has(r)} onSelect={() => toggle(r)} title={r} />
        ))}
        <div className="flex gap-2">
          <TextInput value={typed} onChange={setTyped} placeholder={linked.length ? 'another repository — owner/repo' : 'owner/repo'} />
          <Button disabled={!REPO_RE.test(typed.trim()) || has(typed.trim())} onClick={add}>
            Add
          </Button>
        </div>
      </div>

      {repos.length > 0 && (
        <div className="space-y-3">
          {repos.map((r, i) => (
            <div key={r.slug} className="space-y-2 rounded-md border border-zinc-800 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-100">{r.slug}</span>
                {i === 0 && repos.length > 1 && <span className="text-[11px] text-zinc-500">first — the smoke test and the stack install run here</span>}
                <span className="flex-1" />
                {!linked.includes(r.slug) && (
                  <button onClick={() => toggle(r.slug)} className="text-xs text-zinc-400 hover:text-zinc-200">
                    remove
                  </button>
                )}
              </div>
              <Field
                label="Checkout"
                hint="Sloth clones the repository here itself once the setup is saved, if the folder is not there yet. The worktree slots the sessions work in are made next to it, under ~/.sloth/worktrees."
              >
                <TextInput value={r.root} onChange={(root) => update(r.slug, { root })} placeholder={`~/.sloth/runners/${r.slug.split('/')[1] ?? 'repo'}`} />
              </Field>
              {repos.length > 1 && (
                <Field label="What it is" hint="One line: what this repository holds. A Trello card that names no repository is placed by these notes.">
                  <TextInput value={r.note} onChange={(note) => update(r.slug, { note })} placeholder="the web app · the mobile API · the shared component library" />
                </Field>
              )}
            </div>
          ))}
        </div>
      )}

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
