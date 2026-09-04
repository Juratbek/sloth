import type { IncomingMessage, ServerResponse } from 'node:http';
import { cfg } from './config';
import { tick } from './runner/loop';
import { log } from './runner/log';
import { HOOK_PATH } from './webhook-gh';
import { deliveryUrl, recordDelivery, recordPing, verifySignature } from './webhook';
import { TRELLO_HOOK_PATH, verifyTrelloSignature, type TrelloDelivery } from './webhook-trello';

/**
 * Where GitHub's deliveries land. This is the one route that is *not* behind `remote.ts`'s guard:
 * GitHub arrives with no cookie and no sign-in code, and it is authenticated instead by the HMAC over
 * the raw body — which is why the middleware is mounted in front of the guard rather than inside the
 * API, and why it answers nothing at all until the signature checks out.
 *
 * A delivery has ten seconds to be answered before GitHub calls it failed, and a comments tick can wait
 * minutes behind the tick in flight. So the tick is started after the response and never awaited: this
 * route decides only whether there is something worth looking at, and `runner/comments.ts` — which
 * de-dupes, checks roles and holds orders back while paused — does all the deciding, exactly as it does
 * on the poll. Nothing here trusts the payload beyond "a mention was written somewhere".
 */

/** A comment payload is a few KB; a body larger than this is not one Sloth is going to act on. */
const MAX_BODY = 1 << 20;

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const end = (res: ServerResponse, status: number): void => {
  res.statusCode = status;
  res.end();
};

/** The delivery as bytes: the signature is over exactly what was sent, so nothing may re-encode it first. */
function rawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('delivery body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new Error('delivery body error')));
  });
}

/** `issue_comment` names its thread `issue` (a PR too); `pull_request_review_comment` names it `pull_request`. */
interface CommentEvent {
  action?: string;
  issue?: { number?: number };
  pull_request?: { number?: number };
  comment?: { body?: string; id?: number };
}

/** The two comment events Sloth subscribes to (`webhook-gh.ts`); everything else GitHub might send is answered and dropped. */
const COMMENT_EVENTS = new Set(['issue_comment', 'pull_request_review_comment']);

const mentions = (body: string): boolean => new RegExp(cfg().mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(body);

async function deliver(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return end(res, 405);
  const body = await rawBody(req);
  if (!verifySignature(body, header(req, 'x-hub-signature-256'))) {
    log('webhook: a delivery arrived unsigned or signed with the wrong secret — rejected');
    return end(res, 401);
  }
  const event = header(req, 'x-github-event');
  if (event === 'ping') {
    recordPing();
    log('webhook: GitHub pinged — deliveries are wired up');
    return end(res, 204);
  }
  if (!event || !COMMENT_EVENTS.has(event)) return end(res, 204);
  let payload: CommentEvent;
  try {
    payload = JSON.parse(body.toString('utf8')) as CommentEvent;
  } catch {
    return end(res, 204);
  }
  // An edit or a deletion is not a new mention, and trigger 3 acts on comments it has not seen.
  if (payload.action !== 'created' || !mentions(payload.comment?.body ?? '')) return end(res, 204);
  recordDelivery();
  // Answered before anything is done about it: GitHub is timing us, and the tick is not ours to wait on.
  end(res, 202);
  const thread = payload.issue?.number ?? payload.pull_request?.number ?? '?';
  const kind = event === 'issue_comment' ? 'comment' : 'review comment';
  log(`webhook: @sloth on #${thread} (${kind} ${payload.comment?.id ?? '?'}) — reading comments now`);
  void tick({ comments: true });
}

/**
 * Trello's deliveries. A `HEAD` is Trello checking the address before it creates the hook, and is
 * answered yes; a `POST` is signed over the body and the callback URL, and says which card was
 * commented on and what was written. The comments tick it starts copies the comment onto the card's
 * issue and reads it there (`runner/trello-mirror.ts`), so every comment on a card counts — a mention
 * is an order or a question, anything else may be the answer a parked card waits for.
 */
async function deliverTrello(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'HEAD' || method === 'GET') return end(res, 200);
  if (method !== 'POST') return end(res, 405);
  const body = await rawBody(req);
  if (!verifyTrelloSignature(body, header(req, 'x-trello-webhook'), deliveryUrl())) {
    log('webhook: a Trello delivery arrived unsigned or signed with the wrong secret — rejected');
    return end(res, 401);
  }
  let payload: TrelloDelivery;
  try {
    payload = JSON.parse(body.toString('utf8')) as TrelloDelivery;
  } catch {
    return end(res, 204);
  }
  if (payload.action?.type !== 'commentCard') return end(res, 204);
  recordDelivery();
  end(res, 200);
  log(`webhook: a comment on Trello card "${payload.action.data?.card?.name ?? '?'}" — reading comments now`);
  void tick({ comments: true });
}

/**
 * The delivery routes as one connect middleware, mounted ahead of the guard (`server/api.ts`). Anything
 * that is not a delivery falls through untouched; a body that never arrives answers 400 here rather than
 * going unhandled, which would end the process.
 */
export function webhookMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const path = (req.url ?? '/').split('?')[0];
  if (path === TRELLO_HOOK_PATH) {
    void deliverTrello(req, res).catch((e) => {
      log(`webhook: Trello delivery not read — ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
      if (!res.writableEnded && !res.headersSent) end(res, 400);
    });
    return;
  }
  if (path !== HOOK_PATH) {
    next();
    return;
  }
  void deliver(req, res).catch((e) => {
    log(`webhook: delivery not read — ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
    if (!res.writableEnded && !res.headersSent) end(res, 400);
  });
}
