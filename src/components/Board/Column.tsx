import type { BoardColumn } from '../../../server/types';
import Card from './Card';

/** One column: a sticky `name · count` header over its cards, ~18rem wide on a desktop, full width on a phone. */
export default function Column({ column, onSelect }: { column: BoardColumn; onSelect: (id: string) => void }) {
  return (
    <section className="flex w-full shrink-0 flex-col md:w-72">
      <h4 className="sticky top-0 z-10 bg-zinc-950 pb-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
        {column.name} · {column.cards.length}
      </h4>
      <div className="flex flex-col gap-1">
        {column.cards.map((c) => (
          <Card key={c.issue} card={c} role={column.role} onSelect={onSelect} />
        ))}
        {!column.cards.length && <p className="px-2 py-1 text-[11px] text-zinc-700">empty</p>}
      </div>
    </section>
  );
}
