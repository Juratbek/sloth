import type { BoardColumn } from '../../../server/types';
import Card from './Card';

/**
 * One column: a sticky `name · count` header over its cards. It scrolls on its own, so a long column
 * never pushes the others — a share of the row on a desktop, the whole page under the switcher on a phone.
 */
export default function Column({ column, several = false, onSelect }: { column: BoardColumn; several?: boolean; onSelect: (id: string) => void }) {
  return (
    <section className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto md:min-w-[16rem]">
      <h4 className="sticky top-0 z-10 bg-zinc-950 pb-1 text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">
        {column.name} · {column.cards.length}
      </h4>
      <div className="flex flex-col gap-1">
        {column.cards.map((c) => (
          <Card key={`${c.repo}#${c.issue}`} card={c} role={column.role} several={several} onSelect={onSelect} />
        ))}
        {!column.cards.length && <p className="px-2 py-1 text-[11px] text-zinc-500">empty</p>}
      </div>
    </section>
  );
}
