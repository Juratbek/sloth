import type { AgentRole } from '../../server/config-types';
import { ModelPicker, Row, Toggle } from './ui';
import type { SectionProps } from './ui';

/** Sloth's agents, in the order a card meets them. `implement` reads differently with an orchestrator on. */
const AGENTS: { role: AgentRole; label: string; hint: string; orchestrated?: { label: string; hint: string } }[] = [
  {
    role: 'implement',
    label: 'Implement',
    hint: 'The session that claims a card, writes the code in its own worktree, verifies it and opens the PR — a pickup, a relaunch or an order.',
    orchestrated: {
      label: 'Implementor',
      hint: 'The subagent the orchestrator hands every code change to: it edits the worktree, runs the project\'s checks and reports back. The orchestrator keeps the issue, the board and the PR.',
    },
  },
  {
    role: 'tester',
    label: 'Browser tester',
    hint: 'The subagent an implement session spawns to click through the change in a headless Chrome and screenshot it for the PR. Only used while Test in Chrome is on.',
  },
  {
    role: 'reviewer',
    label: 'Reviewer loop',
    hint: 'The subagent that reviews the PR inside the implement session, for up to the configured review rounds, before the card reaches Code Review.',
  },
  {
    role: 'final',
    label: 'Code review',
    hint: "The independent review of every PR in Code Review — Sloth's own and a human's — once per PR head. Its verdict lands on the PR; a pass moves the card to Approved for a human to test, a fail sends it back to In Progress.",
  },
  { role: 'status', label: 'Mentions', hint: 'Answers a mention on an issue or PR when no session is running on it — where is it, why is it waiting.' },
];

export function Models({ draft, patch }: SectionProps) {
  const set = (role: AgentRole, m: string) => patch({ models: { ...draft.models, [role]: m } });
  return (
    <>
      <p className="py-3 text-xs text-zinc-400">
        Which model each of Sloth's agents runs on: a Claude Code alias or a full model id, passed as <code>--model</code>. A change
        applies to sessions started after the save; running ones keep theirs.
      </p>
      <Row
        label="Orchestrator"
        hint="Run implement sessions as an orchestrator that never edits code itself: it reads the issue, briefs an implementor subagent, verifies, runs the tester and the reviewer, and opens the PR. Off, the implement model does all of it in one session. Keeps a capable model on the judgement calls and a cheaper one on the typing."
      >
        <Toggle checked={draft.orchestrator} onChange={(orchestrator) => patch({ orchestrator })} label="Use an orchestrator" />
      </Row>
      {draft.orchestrator && (
        <Row label="Orchestrator model" hint="The model the implement session itself runs on while the orchestrator is on.">
          <ModelPicker label="Orchestrator model" value={draft.models.orchestrator} onChange={(m) => set('orchestrator', m)} />
        </Row>
      )}
      {AGENTS.map(({ role, label, hint, orchestrated }) => {
        const shown = draft.orchestrator && orchestrated ? orchestrated : { label, hint };
        return (
          <Row key={role} label={shown.label} hint={shown.hint}>
            <ModelPicker label={`${shown.label} model`} value={draft.models[role]} onChange={(m) => set(role, m)} />
          </Row>
        );
      })}
    </>
  );
}
