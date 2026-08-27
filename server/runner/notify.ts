import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import type { BoardItem } from './board';
import { isDry, log, remove, write } from './log';

/**
 * The `@a @b` line appended to a parking comment, so GitHub notifies the configured people. Empty
 * when nobody is configured. GitHub does not notify an account of its own mention, so the login
 * `gh` writes with never sees one — the wizard says so.
 */
export const helpMentions = (): string => cfg().helpLogins.map((l) => `@${l}`).join(' ');

const notifiedDir = () => path.join(cfg().stateDir, 'notified');

async function postWebhook(item: BoardItem): Promise<boolean> {
  const c = cfg();
  const url = `https://github.com/${c.repo}/issues/${item.number}`;
  const text = `Sloth needs help with #${item.number} ${item.title} — ${url}`;
  if (isDry()) {
    log(`dry-run: would notify webhook: ${text}`);
    return true;
  }
  try {
    // `text` is what Slack reads, `content` what Discord reads; the rest is for anything custom.
    const res = await fetch(c.helpWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text, repo: c.repo, issue: item.number, title: item.title, url, column: item.status }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    log(`#${item.number} needs help — webhook notified`);
    return true;
  } catch (e) {
    log(`#${item.number} webhook failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Trigger 7 — every card newly seen in the needs-help column is announced on the webhook once.
 * Reading the column instead of hooking the moves catches a session's own park, the server's, and
 * a card put there by hand. `state/notified/<issue>` remembers the announcement and is dropped
 * once the card leaves the column, so the next park of the same issue is announced again. A
 * failed POST leaves no marker and is retried next tick. Assigned cards are a human's, as always.
 */
export async function notifyParked(board: BoardItem[]): Promise<void> {
  const c = cfg();
  const column = c.statusField.columns.needsHelp.name;
  if (!c.helpWebhook || !column) return;
  const parked = board.filter((i) => i.status === column);
  const still = new Set(parked.map((i) => String(i.number)));
  let seen: string[] = [];
  try {
    seen = fs.readdirSync(notifiedDir());
  } catch {
    /* nothing announced yet */
  }
  for (const f of seen) if (!still.has(f)) remove(path.join(notifiedDir(), f));
  for (const item of parked) {
    const marker = path.join(notifiedDir(), String(item.number));
    if (item.assignees.length || seen.includes(String(item.number))) continue;
    if ((await postWebhook(item)) && !isDry()) write(marker, '');
  }
}
