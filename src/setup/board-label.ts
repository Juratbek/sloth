import type { BoardProvider } from '../../server/config-types';

/** One line naming a board: the owner and number of a Projects board, the member of a Trello one. */
export const boardLabel = (p: { provider?: BoardProvider; owner: string; number: number }): string =>
  p.provider === 'trello' ? `Trello${p.owner ? ` · ${p.owner}` : ''}` : `${p.owner} · #${p.number}`;
