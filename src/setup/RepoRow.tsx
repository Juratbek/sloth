import type { ReactNode } from 'react';
import type { ListRow } from './pick-order';

/**
 * One repository on the picker's list: the tick, what the repository is, and — for a picked one — the
 * options the page hangs under it. The options open with the row and fold away behind the chevron, which
 * sits outside the label so that reaching for it never ticks the repository off by accident; folded, the
 * header still says where the checkout goes, which is the one thing a row is asked at a glance.
 */

const Badge = ({ children }: { children: string }) => <span className="shrink-0 rounded border border-edge px-1 text-[10px] text-fg-faint">{children}</span>;

/** Why a row cannot be ticked, or why it is on the list at all when GitHub did not name it. */
function hintFor(row: ListRow, locked: boolean): string {
  if (!row.writable) return 'read access only — Sloth pushes branches and opens PRs';
  if (locked) return 'the first repository this Sloth watched — its files on disk carry no repository name, so it cannot be removed';
  return row.missing ? 'not in your list' : '';
}

export default function RepoRow({
  row,
  picked,
  linked,
  locked,
  onToggle,
  details,
  open,
  onOpen,
  checkout,
}: {
  row: ListRow;
  picked: boolean;
  linked: boolean;
  locked: boolean;
  onToggle: () => void;
  /** What the page hangs under a picked row; a row without it has nothing to fold and gets no chevron. */
  details?: ReactNode;
  open?: boolean;
  onOpen?: () => void;
  /** Where this repository's checkout goes — shown in the header while the options are folded away. */
  checkout?: string;
}) {
  const disabled = locked || (!row.writable && !picked);
  const hint = hintFor(row, locked);
  return (
    <div className={`rounded-md border ${picked ? 'border-ok-edge-strong bg-ok-tint/30' : 'border-edge hover:bg-surface-raised'} ${!row.writable && !picked ? 'opacity-60' : ''}`}>
      <div className="flex items-start">
        <label className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2">
          <input
            type="checkbox"
            checked={picked}
            disabled={disabled}
            aria-label={row.slug}
            onChange={onToggle}
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent disabled:opacity-40"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm text-fg-strong">{row.slug}</span>
              {linked && <Badge>linked to the board</Badge>}
              {row.private && <Badge>private</Badge>}
              {row.archived && <Badge>archived</Badge>}
            </span>
            {details && !open && checkout && <span className="block truncate text-xs text-fg-muted">{checkout}</span>}
            {row.description && <span className="block truncate text-xs text-fg-muted">{row.description}</span>}
            {hint && <span className="block text-[11px] text-fg-faint">{hint}</span>}
          </span>
        </label>
        {details && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${row.slug}`}
            aria-expanded={!!open}
            className="m-1.5 shrink-0 rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg-strong"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className={`h-5 w-5 transition-transform ${open ? '' : '-rotate-90'}`}>
              <path d="M5.5 8L10 12.5 14.5 8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      {details && open && <div className="border-t border-edge px-3 pt-3 pb-3">{details}</div>}
    </div>
  );
}
