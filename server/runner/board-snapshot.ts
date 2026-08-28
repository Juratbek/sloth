import type { BoardItem } from './board';

/**
 * The last board the loop read. Every board tick already fetches the whole board (`fetchBoard`), so
 * the home panel's board view mirrors *that* read instead of asking GitHub again: one board read per
 * tick, whatever the UI does. Nothing is persisted — a Sloth that has not ticked yet has no board to
 * show, and says so.
 */
let last: { at: number; items: BoardItem[] } | undefined;

export const setSnapshot = (items: BoardItem[]): void => {
  last = { at: Date.now(), items };
};

export const snapshot = (): { at: number; items: BoardItem[] } | undefined => last;

/** Dropped when the configuration is reloaded: a board Sloth was re-pointed at must not show the old one's cards. */
export const clearSnapshot = (): void => {
  last = undefined;
};
