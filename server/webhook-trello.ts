import crypto from 'node:crypto';
import { createWebhook, updateWebhook, webhooks } from './trello';
import { trelloCredentials } from './trello-credentials';

/**
 * The Trello side of the comment webhook: the board's webhook, pointed at this Sloth, and the check on
 * what it delivers. Trello signs a delivery with the key's OAuth secret — base64 of an HMAC-SHA1 over
 * the body followed by the callback URL — so without `SLOTH_TRELLO_SECRET` nothing can be verified and
 * no webhook is set up: the comments poll at `fallbackCommentSeconds` carries the mentions instead.
 */

export const TRELLO_HOOK_PATH = '/api/hooks/trello';

export const trelloSecret = (): string | undefined => trelloCredentials().secret || undefined;

/** The board's webhook Sloth owns — the one delivering to `/api/hooks/trello` — repointed at today's address, or created. */
export async function ensureTrelloHook(boardId: string, url: string): Promise<string> {
  if (!trelloSecret()) throw new Error('no Trello secret is set — deliveries could not be verified, so the board is polled instead (Settings → Board)');
  const mine = (await webhooks()).find((h) => h.callbackURL.endsWith(TRELLO_HOOK_PATH));
  if (mine) {
    if (mine.callbackURL !== url || mine.idModel !== boardId || !mine.active) await updateWebhook(mine.id, boardId, url);
    return mine.id;
  }
  return (await createWebhook(boardId, url)).id;
}

/** Whether a delivery really came from Trello for `url` — constant-time, length-checked first. */
export function verifyTrelloSignature(body: Buffer, header: string | undefined, url: string): boolean {
  const secret = trelloSecret();
  if (!secret || !header) return false;
  const expected = crypto.createHmac('sha1', secret).update(Buffer.concat([body, Buffer.from(url)])).digest('base64');
  const given = Buffer.from(header);
  const mine = Buffer.from(expected);
  return given.length === mine.length && crypto.timingSafeEqual(given, mine);
}

/** What a delivery carries that Sloth looks at: a comment written on a card, with its text. */
export interface TrelloDelivery {
  action?: { type?: string; data?: { text?: string; card?: { id?: string; name?: string } } };
}
