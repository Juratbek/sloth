import type { MergeMethod } from '../../server/config-types';
import { NumberInput, TextInput } from '../setup/ui';
import { Choose, ListInput, Row, Toggle } from './ui';
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
        hint="Give implement sessions a headless Chrome (Playwright), so a tester subagent can click through the change and screenshot it for the PR before it opens. Needs Google Chrome on this machine."
      >
        <Toggle checked={draft.chrome} onChange={(chrome) => patch({ chrome })} label="Test in Chrome" />
      </Row>
      <Row
        label="Preview hours"
        hint="How long a finished session's app stays up behind a public link posted on its PR, so a reviewer can try the change without checking it out. 0 turns previews off."
      >
        <NumberInput min={0} value={draft.previewHours} onChange={(previewHours) => patch({ previewHours })} />
      </Row>
      <Row
        label="Priority field"
        hint="A single-select field on the board; cards are picked up from the watched column in its option order — first option first — and unprioritised cards last. Leave empty to pick up in board order."
      >
        <TextInput value={draft.priorityField} onChange={(priorityField) => patch({ priorityField })} />
      </Row>
      <Row
        label="Auto-merge"
        hint="Merge a PR once its review passed, its checks are green and it merges cleanly, with this gh pr merge method — as soon as it passes, so nobody tests it in Approved first. Off leaves the merge to a human; the card still reaches Done when the issue closes."
      >
        <Choose
          label="Auto-merge"
          value={draft.autoMerge}
          onChange={(autoMerge) => patch({ autoMerge: autoMerge as MergeMethod })}
          options={MERGE_OPTIONS}
        />
      </Row>
    </>
  );
}

const MERGE_OPTIONS = [
  { id: '', name: 'Off — a human merges' },
  { id: 'squash', name: 'Squash and merge' },
  { id: 'merge', name: 'Merge commit' },
  { id: 'rebase', name: 'Rebase and merge' },
];

export function Team({ draft, patch }: SectionProps) {
  const roles = (p: Partial<typeof draft.roles>) => patch({ roles: { ...draft.roles, ...p } });
  return (
    <>
      <p className="py-3 text-xs text-zinc-400">
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

export function Sessions({ draft, patch }: SectionProps) {
  return (
    <>
      <Row label="Max active sessions" hint="How many sessions run at once, and how many worktree slots the pool holds. A trigger with no free slot is retried on the next tick.">
        <NumberInput value={draft.maxActive} onChange={(maxActive) => patch({ maxActive })} />
      </Row>
      <Row label="Max alive sessions" hint="Running plus parked sessions waiting for an answer, before Sloth stops picking cards up.">
        <NumberInput value={draft.maxAlive} onChange={(maxAlive) => patch({ maxAlive })} />
      </Row>
      <Row label="Min free memory %" hint="No session starts while less than this much of the machine's memory is available. Running sessions go on; 0 turns the check off.">
        <NumberInput min={0} value={draft.minFreeMemory} onChange={(minFreeMemory) => patch({ minFreeMemory })} />
      </Row>
      <Row label="Min idle CPU %" hint="No session starts while less than this much of the CPU is idle, averaged since the previous tick. 0 turns the check off.">
        <NumberInput min={0} value={draft.minIdleCpu} onChange={(minIdleCpu) => patch({ minIdleCpu })} />
      </Row>
      <Row label="Min idle disk %" hint="No session starts while the busiest disk is idle less than this much of the time since the previous tick — the opposite of Task Manager's Disk column. 0 turns the check off.">
        <NumberInput min={0} value={draft.minIdleDisk} onChange={(minIdleDisk) => patch({ minIdleDisk })} />
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
      <Row
        label="Keep days"
        hint="Finished runs older than this are deleted — their session directory and status replies. Transcripts belong to Claude Code and are left alone."
      >
        <NumberInput value={draft.keepDays} onChange={(keepDays) => patch({ keepDays })} />
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
