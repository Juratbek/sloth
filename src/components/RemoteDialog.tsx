import type { UseMutationResult } from '@tanstack/react-query';
import { useInstall, useRemote, useRotate, type Remote } from '../hooks/use-remote';
import Button from './ui/Button';
import ErrorNote from './ui/ErrorNote';
import Modal from './ui/Modal';

/** Signing every phone out is not undoable, so it is asked about — the same window.confirm the session's Stop uses. */
const ROTATE_ASK = 'Make a new link? The code changes and every phone that scanned the old one is signed out.';

function Spinner({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-300">
      <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-200" />
      {text}
    </div>
  );
}

const Note = ({ tone, text }: { tone: 'red' | 'amber'; text: string }) => (
  <p className={`text-xs break-words ${tone === 'red' ? 'text-red-400' : 'text-amber-300'}`}>{text}</p>
);

/** What stands between the user and the QR right now — the tool, the install, the tunnel — or the QR itself. */
function Body({ data, error, install }: { data?: Remote; error: unknown; install: UseMutationResult<unknown, Error, void> }) {
  if (error) return <Note tone="red" text={String(error)} />;
  if (!data) return <Spinner text="Checking…" />;
  if (data.qr)
    return (
      <>
        <img src={data.qr} alt="QR code that opens this Sloth" className="mx-auto w-64 rounded-md bg-white p-2" />
        <p className="text-center font-mono text-[11px] break-all text-zinc-400">{data.url}</p>
        <p className="text-xs text-zinc-400">
          Scanning signs the phone in: whoever has this code can read every session and press Tick and Pause.
          <b className="text-zinc-400"> New link</b> replaces the code and signs every phone out.
        </p>
      </>
    );
  const { tool, install: run } = data;
  if (run.running)
    return (
      <>
        <Spinner text={`Installing ${tool?.command} with Homebrew — usually a minute or two.`} />
        <pre className="max-h-40 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-[10px] break-words whitespace-pre-wrap text-zinc-400">
          {run.output || '…'}
        </pre>
      </>
    );
  if (tool && !tool.installed)
    return (
      <>
        <p className="text-xs text-zinc-400">
          Sloth reaches your phone through a Cloudflare tunnel, which needs <b className="text-zinc-200">{tool.command}</b>. It
          is not installed on this machine.
        </p>
        {run.error && <Note tone="red" text={run.error} />}
        {/* The server's record of the last install, and this page's own failed POST — a refused request never reached it. */}
        <ErrorNote error={install.error} className="block" />
        {tool.installable ? (
          <Button variant="accent" size="wide" onClick={() => install.mutate()} disabled={install.isPending}>
            {run.error ? 'Try again' : `Install ${tool.command}`}
          </Button>
        ) : (
          <p className="text-xs text-zinc-400">
            Install it by hand (developers.cloudflare.com) or set <code>publicUrl</code> in the config, then restart Sloth.
          </p>
        )}
      </>
    );
  return (
    <>
      <Spinner text={data.error ? 'Retrying the tunnel…' : 'Starting the tunnel…'} />
      {data.error && <Note tone="amber" text={data.error} />}
    </>
  );
}

/** The QR code that opens this Sloth on a phone. Only the machine Sloth runs on can show it. */
export default function RemoteDialog({ onClose }: { onClose: () => void }) {
  const { data, error } = useRemote(true);
  const rotate = useRotate();
  const install = useInstall();
  return (
    <Modal
      title="Open on your phone"
      onClose={onClose}
      footer={
        <>
          {data?.link && (
            <Button
              size="dialog"
              onClick={() => {
                if (window.confirm(ROTATE_ASK)) rotate.mutate();
              }}
              disabled={rotate.isPending}
            >
              New link
            </Button>
          )}
          <ErrorNote error={rotate.error} className="self-center" />
          <Button size="dialog" className="ml-auto" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="min-h-24 space-y-3">
        <Body data={data} error={error} install={install} />
      </div>
    </Modal>
  );
}
