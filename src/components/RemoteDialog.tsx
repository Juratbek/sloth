import type { UseMutationResult } from '@tanstack/react-query';
import { useInstall, useRemote, useRotate, type Remote } from '../hooks/use-remote';

const button = 'rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-600';
const primary = 'rounded-md border border-sky-800 bg-sky-950/60 px-3 py-1.5 text-xs text-sky-200 hover:bg-sky-900/60 disabled:cursor-not-allowed disabled:text-zinc-600';

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
        {tool.installable ? (
          <button onClick={() => install.mutate()} disabled={install.isPending} className={primary}>
            {run.error ? 'Try again' : `Install ${tool.command}`}
          </button>
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
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Open on your phone"
        className="w-full max-w-sm space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <h2 className="text-sm font-semibold text-zinc-100">Open on your phone</h2>
          <button onClick={onClose} aria-label="Close" className="ml-auto text-zinc-400 hover:text-zinc-200">
            ✕
          </button>
        </div>
        <div className="min-h-24 space-y-3">
          <Body data={data} error={error} install={install} />
        </div>
        <div className="flex gap-2">
          {data?.link && (
            <button onClick={() => rotate.mutate()} disabled={rotate.isPending} className={button}>
              New link
            </button>
          )}
          <button onClick={onClose} className={`${button} ml-auto`}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
