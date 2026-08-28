import type { AgentRole } from '../../server/config-types';
import { ModelPicker, Row } from './ui';
import type { SectionProps } from './ui';

/** Sloth's agents, in the order a card meets them. */
const AGENTS: { role: AgentRole; label: string; hint: string }[] = [
  {
    role: 'implement',
    label: 'Implement',
    hint: 'The session that claims a card, writes the code in its own worktree, verifies it and opens the PR — a pickup, a relaunch or an order.',
  },
  {
    role: 'tester',
    label: 'Browser tester',
    hint: 'The subagent an implement session spawns to click through the change in your Chrome. Only used while Test in Chrome is on.',
  },
  {
    role: 'reviewer',
    label: 'Reviewer loop',
    hint: 'The subagent that reviews the PR inside the implement session, for up to the configured review rounds, before the card reaches Code Review.',
  },
  { role: 'review', label: 'PR review', hint: "Reviews a human's PR in Code Review, once per PR head, and comments on it." },
  {
    role: 'final',
    label: 'Final review',
    hint: "The last review before merge, of an Approved card's PR. Its verdict lands on the PR and a pass labels the issue.",
  },
  { role: 'status', label: 'Mentions', hint: 'Answers a mention on an issue or PR when no session is running on it — where is it, why is it waiting.' },
];

export function Models({ draft, patch }: SectionProps) {
  return (
    <>
      <p className="py-3 text-xs text-zinc-500">
        Which model each of Sloth's agents runs on: a Claude Code alias or a full model id, passed as <code>--model</code>. A change
        applies to sessions started after the save; running ones keep theirs.
      </p>
      {AGENTS.map(({ role, label, hint }) => (
        <Row key={role} label={label} hint={hint}>
          <ModelPicker label={`${label} model`} value={draft.models[role]} onChange={(m) => patch({ models: { ...draft.models, [role]: m } })} />
        </Row>
      ))}
    </>
  );
}
