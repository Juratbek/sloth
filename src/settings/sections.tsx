import type { AgentRole } from '../../server/config-types';
import { NumberInput, TextInput } from '../setup/ui';
import { ListInput, ModelPicker, Row, Toggle } from './ui';
import type { SectionProps } from './ui';

const LOGINS = /[\s,]+/;

export function General({ draft, patch }: SectionProps) {
  return (
    <>
      <Row label="Mention" hint="The word in an issue or PR comment that wakes Sloth. Only the team's logins are heard.">
        <TextInput value={draft.mention} onChange={(mention) => patch({ mention })} placeholder="@sloth" />
      </Row>
      <Row
        label="Comment prefix"
        hint="The first line of every comment Sloth writes. It writes with your GitHub account, so each comment identifies itself."
      >
        <TextInput value={draft.botPrefix} onChange={(botPrefix) => patch({ botPrefix })} placeholder="**Sloth:**" />
      </Row>
      <Row label="Board poll" hint="Seconds between two reads of the board — pickups, relaunches, reviews. At least 30.">
        <NumberInput min={30} value={draft.boardSeconds} onChange={(boardSeconds) => patch({ boardSeconds })} />
      </Row>
      <Row label="Comment poll" hint="Seconds between two checks for mentions in issue and PR comments. At least 30.">
        <NumberInput min={30} value={draft.commentSeconds} onChange={(commentSeconds) => patch({ commentSeconds })} />
      </Row>
      <Row
        label="Test in Chrome"
        hint="Start implement sessions with --chrome, so a tester subagent can click through the change in your Chrome before the PR opens."
      >
        <Toggle checked={draft.chrome} onChange={(chrome) => patch({ chrome })} label="Test in Chrome" />
      </Row>
      <Row
        label="Preview hours"
        hint="How long a finished session's app stays up behind a public link posted on its PR, so a reviewer can try the change without checking it out. 0 turns previews off."
      >
        <NumberInput min={0} value={draft.previewHours} onChange={(previewHours) => patch({ previewHours })} />
      </Row>
    </>
  );
}

export function Team({ draft, patch }: SectionProps) {
  const roles = (p: Partial<typeof draft.roles>) => patch({ roles: { ...draft.roles, ...p } });
  return (
    <>
      <p className="py-3 text-xs text-zinc-500">
        Who may talk to Sloth in comments. A mention from any other GitHub login is ignored, and their comments do not count as
        answers.
      </p>
      <Row label="Admin" hint="One login. Orders Sloth anything: work on an issue, move a card to any column, close an issue.">
        <TextInput value={draft.roles.admin} onChange={(admin) => roles({ admin })} placeholder="your-github-login" />
      </Row>
      <Row
        label="Developers"
        hint="Order work on an issue, within that issue — implement it, change the approach, address the review comments, start over, stop. Anything beyond the issue becomes a question for the admin."
      >
        <ListInput value={draft.roles.developers} onChange={(developers) => roles({ developers })} split={LOGINS} join=", " placeholder="alice, bob" />
      </Row>
      <Row label="Testers" hint="Answer the questions a parked card asks and ask for status; they cannot give orders.">
        <ListInput value={draft.roles.testers} onChange={(testers) => roles({ testers })} split={LOGINS} join=", " placeholder="carol, dave" />
      </Row>
    </>
  );
}

export function Notifications({ draft, patch }: SectionProps) {
  const column = draft.statusField.columns.needsHelp.name || 'needs help';
  return (
    <>
      <Row
        label="Logins to mention"
        hint={`Mentioned in the comment Sloth writes when it parks a card in “${column}”, so GitHub notifies them. Leave out the login gh is signed in as — GitHub never notifies an account of its own mention.`}
      >
        <ListInput value={draft.helpLogins} onChange={(helpLogins) => patch({ helpLogins })} split={LOGINS} join=", " placeholder="alice, bob" />
      </Row>
      <Row
        label="Webhook URL"
        hint={`Optional. A Slack or Discord incoming webhook (or your own endpoint) gets a JSON POST with the issue each time a card lands in “${column}”, within one board poll.`}
        wide
      >
        <TextInput value={draft.helpWebhook} onChange={(helpWebhook) => patch({ helpWebhook })} placeholder="https://hooks.slack.com/services/…" />
      </Row>
    </>
  );
}

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

export function Sessions({ draft, patch }: SectionProps) {
  return (
    <>
      <Row label="Max active sessions" hint="How many sessions run at once. A trigger with no free slot is retried on the next tick.">
        <NumberInput value={draft.maxActive} onChange={(maxActive) => patch({ maxActive })} />
      </Row>
      <Row label="Max alive sessions" hint="Running plus parked sessions waiting for an answer, before Sloth stops picking cards up.">
        <NumberInput value={draft.maxAlive} onChange={(maxAlive) => patch({ maxAlive })} />
      </Row>
      <Row label="Budget minutes" hint="A session's time budget. Five minutes past it the session is killed, cleaned up and its card parked.">
        <NumberInput value={draft.budgetMinutes} onChange={(budgetMinutes) => patch({ budgetMinutes })} />
      </Row>
      <Row
        label="Wait hours"
        hint="How long a parked session waits for an answer in the thread before it exits. A later answer starts a new session on the issue."
      >
        <NumberInput value={draft.waitHours} onChange={(waitHours) => patch({ waitHours })} />
      </Row>
      <Row label="Review rounds" hint="Reviewer-loop rounds inside an implement session before it gives up and asks for help.">
        <NumberInput value={draft.reviewRounds} onChange={(reviewRounds) => patch({ reviewRounds })} />
      </Row>
      <Row label="Max retries" hint="How many times in a row an In Progress card whose session died is relaunched before it is parked.">
        <NumberInput min={0} value={draft.maxRetries} onChange={(maxRetries) => patch({ maxRetries })} />
      </Row>
    </>
  );
}

export function Remote({ draft, patch }: SectionProps) {
  return (
    <>
      <Row
        label="Tunnel command"
        hint="Runs so the UI — and every preview — is reachable from outside; {port} is the port to expose. The first bare https:// URL it prints is the address. Words separated by spaces."
        wide
      >
        <ListInput value={draft.tunnel} onChange={(tunnel) => patch({ tunnel })} split={/\s+/} join=" " placeholder="cloudflared tunnel --url http://localhost:{port}" />
      </Row>
      <Row
        label="Public URL"
        hint="Where the UI is already reachable — your own tunnel or domain. When set, no tunnel is started for the UI; previews still run the command above."
        wide
      >
        <TextInput value={draft.publicUrl} onChange={(publicUrl) => patch({ publicUrl })} placeholder="https://sloth.example.com" />
      </Row>
    </>
  );
}
