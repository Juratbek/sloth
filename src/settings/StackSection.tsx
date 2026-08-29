import StackPanel from '../components/StackPanel';
import type { SectionProps } from './ui';

/** The stack the sessions' app needs on this machine, and the button that installs what is missing. */
export default function StackSection({ draft, patch }: SectionProps) {
  return (
    <div className="py-4">
      <p className="text-sm text-zinc-100">Stack</p>
      <p className="mt-0.5 mb-4 text-xs leading-relaxed text-zinc-500">
        What the app needs on this machine so a session can boot it, verify the change and leave a preview. Sloth can install
        PostgreSQL, Redis, Node.js, Python and Java — with Homebrew here, apt-get on Debian / Ubuntu / WSL. <em>Detect</em> reads
        the checkout at every start; <em>choose by hand</em> pins the list. Whatever is missing is installed when Sloth starts,
        or now, with the button.
      </p>
      <StackPanel value={draft.stack} onChange={(stack) => patch({ stack })} />
    </div>
  );
}
