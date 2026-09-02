import type { ReactNode } from 'react';
import { APPROVED_LABEL, SKIP_LABEL, skipped } from '../../../server/board-types';
import type { ColumnRole } from '../../../server/config-types';
import type { BoardCard } from '../../../server/types';
import { STATUS_COLOR, duration, safeUrl, stepLabel, usd } from '../../lib/format';

/** A link out of a card: the card itself is the click target, so the link keeps its click to itself. */
function Out({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={`${className} hover:underline`}>
      {children}
    </a>
  );
}

/**
 * One card, two dense lines: the issue and what Sloth's newest run on it is doing, then only what
 * applies — cost, PR, preview, retries, the give-up that blocked it, the assignee, the skip label that
 * keeps Sloth off it, the review pass, how long a parked card has been waiting. Clicking selects the
 * run; the links open GitHub or the preview. The badges only read state: unblocking is the home
 * panel's, because this view writes nothing.
 *
 * Under them, when there is one, the hold: the one sentence saying why nothing is happening on this
 * card (`BoardCard.hold`). One muted line, truncated so a card stays two or three lines tall, with the
 * whole sentence in the `title` — the answer to "why is nothing happening?" is worth a hover, not a
 * card that grows to three times the height of its neighbours.
 */
export default function Card({ card, role, onSelect }: { card: BoardCard; role: ColumnRole; onSelect: (id: string) => void }) {
  const step = card.kind && stepLabel(card.kind, card.step);
  const pr = safeUrl(card.pr);
  const preview = safeUrl(card.preview?.url);
  const previewLink = preview && card.preview?.key ? `${preview}/?sloth_key=${card.preview.key}` : preview;
  const cost = card.sessionId ? (card.cost === null ? '—' : usd(card.cost)) : undefined;
  const approved = role === 'approved' && card.labels.includes(APPROVED_LABEL);
  const owner = card.assignees[0];
  const held = skipped(card);
  const waited = role === 'needsHelp' && card.since ? duration(Date.now() / 1000 - card.since) : undefined;
  const second = cost || pr || previewLink || card.retries > 0 || owner || held || approved || waited || card.blocked;
  const pick = card.sessionId ? () => onSelect(card.sessionId!) : undefined;

  return (
    <div
      role={pick ? 'button' : undefined}
      tabIndex={pick ? 0 : undefined}
      onClick={pick}
      onKeyDown={(e) => {
        // A key pressed on a link inside the card is the link's: Enter must open it, not select the run.
        if (!pick || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        pick();
      }}
      className={`rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1.5 ${pick ? 'cursor-pointer hover:bg-zinc-900' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">#{card.issue}</span>
        <span className="truncate text-xs text-zinc-200">{card.title}</span>
        {card.status && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {step && <span className="text-[10px] text-zinc-400">{step}</span>}
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_COLOR[card.status]} ${card.status === 'running' ? 'animate-pulse' : ''}`} />
          </span>
        )}
      </div>
      {card.hold && (
        <div className="mt-0.5 truncate text-[10px] text-fg-faint" title={card.hold}>
          {card.hold}
        </div>
      )}
      {second && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-zinc-400">
          {cost && <span className="tabular-nums text-zinc-400">{cost}</span>}
          {pr && (
            <Out href={pr} className="text-sky-400">
              {card.pr!.replace(/.*\//, 'PR #')}
            </Out>
          )}
          {previewLink && (
            <Out href={previewLink} className="text-emerald-400">
              preview
            </Out>
          )}
          {card.retries > 0 && <span className="text-amber-400">retries {card.retries}</span>}
          {card.blocked && (
            <span title={card.blocked} className="rounded bg-red-950 px-1 text-red-400">
              blocked
            </span>
          )}
          {waited && <span className="tabular-nums">waiting {waited}</span>}
          {approved && <span className="rounded bg-zinc-800 px-1 text-zinc-400">{APPROVED_LABEL}</span>}
          {held && <span className="rounded bg-zinc-800 px-1 text-orange-400">{SKIP_LABEL}</span>}
          {owner && <span className="text-zinc-500">{owner}</span>}
        </div>
      )}
    </div>
  );
}
