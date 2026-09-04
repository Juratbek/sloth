import Chip from '../components/ui/Chip';
import ErrorNote from '../components/ui/ErrorNote';
import { useRetryWebhook, useWebhook } from '../hooks/use-webhook';
import { clock } from '../lib/format';
import { Button } from '../setup/ui';
import { Row } from './ui';

/**
 * The repository webhook, on the same page as the two intervals it decides between. Nobody configures
 * it — Sloth points GitHub at its own public address by itself — so all this offers is the answer to
 * "is it delivering", the reason when it is not, and the button that tries again after the thing in the
 * way (a tunnel that was down, a token without the scope) has been dealt with.
 */
export default function WebhookBlock() {
  const webhook = useWebhook();
  const retry = useRetryWebhook();
  const w = webhook.data;
  const live = !!w?.live;
  const failed = w?.state === 'failed';
  return (
    <Row
      label="Comment webhook"
      hint={
        <>
          Sloth points the repository's webhook at its own public address, so an <code>@sloth</code> comment is read the moment it is
          written instead of at the next poll. Polling never stops: it is the safety net under the webhook, at the comment poll above
          while deliveries arrive and at the fallback while they do not. Needs a public address (a tunnel, or <code>publicUrl</code>) and a{' '}
          <code>gh</code> token that may write webhooks.
        </>
      }
      wide
    >
      <div className="w-full space-y-1.5">
        <div className="flex items-center justify-end gap-2">
          <Chip tone={live ? 'emerald' : failed ? 'red' : 'zinc'} size="sm">
            {live ? 'Active' : failed ? 'Failed' : 'Off'}
          </Chip>
          <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending ? 'Configuring…' : 'Retry webhook setup'}
          </Button>
        </div>
        {w && (
          <p className="text-right text-[11px] break-words text-fg-muted">
            {live ? w.url : (w.reason ?? 'not configured yet')}
          </p>
        )}
        {w && (
          <p className="text-right text-[11px] text-fg-faint">
            Comments polled every {w.effectiveCommentSeconds}s{live ? '' : ' (fallback)'}
            {w.lastDelivery ? ` · last delivery ${clock(w.lastDelivery)}` : ''}
            {!w.lastDelivery && w.lastPing ? ` · pinged ${clock(w.lastPing)}` : ''}
          </p>
        )}
        {w?.rejected ? (
          <p className="text-right text-[11px] text-amber-400">
            {w.rejected} {w.rejected === 1 ? 'delivery' : 'deliveries'} rejected since the last verified one{w.lastRejected ? `, last ${clock(w.lastRejected)}` : ''} — a secret that does not match the one in Settings → Board, or someone else at the address
          </p>
        ) : null}
        <ErrorNote error={webhook.error ?? retry.error} className="block text-right" />
      </div>
    </Row>
  );
}
