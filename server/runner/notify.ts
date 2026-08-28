import { cfg } from '../config';
import type { WebhookEvent } from '../config-types';
import { isDry, log } from './log';

/**
 * The one webhook Sloth calls. It started as "a card needs help" and is now every moment worth telling
 * someone about — which ones is the user's choice (`webhookEvents`), so a setup that only ever wanted
 * the needs-help ping keeps getting exactly that. `text` and `content` carry the same sentence, because
 * that is what Slack and Discord each read out of an incoming webhook; everything else is for whoever
 * writes their own endpoint.
 */

/**
 * The `@a @b` line appended to a parking comment, so GitHub notifies the configured people. Empty
 * when nobody is configured. GitHub does not notify an account of its own mention, so the login
 * `gh` writes with never sees one — the wizard says so.
 */
export const helpMentions = (): string => cfg().helpLogins.map((l) => `@${l}`).join(' ');

export interface Notice {
  /** The issue it is about; absent for something that happened to a review run. */
  issue?: number;
  title?: string;
  /** The one line Slack and Discord show — the URL is appended to it. */
  text: string;
  column?: string;
  pr?: number;
}

/** Whether this event would go anywhere: a URL is configured and the user asked for it. */
export const notifies = (event: WebhookEvent): boolean => !!cfg().helpWebhook && cfg().webhookEvents.includes(event);

/** POSTs one event. False when it did not go out, so a caller writing a "told them" marker keeps none. */
export async function notify(event: WebhookEvent, n: Notice): Promise<boolean> {
  const c = cfg();
  if (!notifies(event)) return false;
  const url = n.issue ? `https://github.com/${c.repo}/issues/${n.issue}` : `https://github.com/${c.repo}`;
  const text = `${n.text} — ${url}`;
  if (isDry()) {
    log(`dry-run: would notify webhook: ${text}`);
    return true;
  }
  try {
    const res = await fetch(c.helpWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event,
        text,
        content: text,
        repo: c.repo,
        issue: n.issue ?? null,
        title: n.title ?? '',
        url,
        column: n.column ?? '',
        ...(n.pr ? { pr: n.pr } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    log(`#${n.issue ?? '?'} ${event} — webhook notified`);
    return true;
  } catch (e) {
    log(`#${n.issue ?? '?'} webhook failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
