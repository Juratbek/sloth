import { WEBHOOK_EVENTS, type WebhookEvent } from '../../server/config-types';
import { TextInput } from '../setup/ui';
import { ListInput, Row, Toggle } from './ui';
import type { SectionProps } from './ui';

const LOGINS = /[\s,]+/;

/** Every event the webhook can hear about, in the order a card meets them. */
const EVENTS: { event: WebhookEvent; label: string; hint: string }[] = [
  { event: 'needsHelp', label: 'Needs help', hint: 'A card lands in the needs-help column: a session asked its questions and is waiting.' },
  { event: 'codeReview', label: 'Code Review', hint: 'A card arrives in Code Review — its PR is open and waits for Sloth\'s review.' },
  { event: 'finalPassed', label: 'Review passed', hint: 'A card reached Approved with the `Fable: approved` label: its PR passed the review and is ready for a human to test — the message carries the preview link.' },
  { event: 'finalFailed', label: 'Review pass taken back', hint: 'A card lost that label again — the branch moved on after the pass, or its checks turned red.' },
  { event: 'merged', label: 'Issue closed', hint: 'A PR was merged and Sloth filed its card away in Done.' },
  { event: 'qaPassed', label: 'QA passed', hint: 'The daily QA sweep tested a card on the QA branch and it passed — the card is in Done.' },
  { event: 'qaFailed', label: 'QA failed', hint: 'The sweep found the fix wanting — the findings are on the issue and the card is back in In Progress.' },
  { event: 'stopped', label: 'Run stopped', hint: 'A session was stopped — past its budget, from the monitor, or relaunched too many times.' },
  { event: 'usageLimit', label: 'Usage limit', hint: 'A Claude usage limit stopped a session and paused the watcher for 30 minutes.' },
];

export default function NotificationsSection({ draft, patch }: SectionProps) {
  const column = draft.statusField.columns.needsHelp.name || 'needs help';
  const on = new Set(draft.webhookEvents);
  const toggle = (event: WebhookEvent, want: boolean) =>
    patch({ webhookEvents: WEBHOOK_EVENTS.filter((e) => (e === event ? want : on.has(e))) });
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
        hint="Optional. A Slack or Discord incoming webhook (or your own endpoint) gets a JSON POST for each event below, within one board poll."
        wide
      >
        <TextInput value={draft.helpWebhook} onChange={(helpWebhook) => patch({ helpWebhook })} placeholder="https://hooks.slack.com/services/…" />
      </Row>
      <div className={draft.helpWebhook ? '' : 'pointer-events-none opacity-40'}>
        {EVENTS.map(({ event, label, hint }) => (
          <Row key={event} label={label} hint={hint}>
            <Toggle label={label} checked={on.has(event)} onChange={(want) => toggle(event, want)} />
          </Row>
        ))}
      </div>
    </>
  );
}
