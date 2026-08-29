import { STACK, type StackChoice, type StackId } from '../../server/config-types';
import type { StackTool } from '../../server/types';
import { useInstallStack, useStack } from '../hooks/use-stack';
import { Button, Error } from '../setup/ui';

/** The stack the sessions' app needs, in the wizard and in Settings: what the checkout needs, what is missing, one button to install it. */
export default function StackPanel({ root, value, onChange }: { root?: string; value: StackChoice; onChange: (v: StackChoice) => void }) {
  const { data, error, isFetching, refetch } = useStack(root);
  const install = useInstallStack(root);
  const auto = value === 'auto';
  const detected = data?.tools.filter((t) => t.detected).map((t) => t.id) ?? [];
  const required = auto ? detected : value;
  const missing = data ? data.tools.filter((t) => required.includes(t.id) && !t.installed) : [];
  const running = data?.install.running ?? false;
  const toggle = (id: StackId) => onChange(required.includes(id) ? required.filter((x) => x !== id) : [...required, id]);
  const problem = data?.installError ?? install.error?.message ?? data?.install.error;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <Mode selected={auto} onClick={() => onChange('auto')}>
          Detect from the checkout
        </Mode>
        <Mode selected={!auto} onClick={() => onChange(required)}>
          Choose by hand
        </Mode>
      </div>
      {error && <Error>{String(error)}</Error>}
      {data && (
        <div className="space-y-1.5">
          {data.tools.map((t) => (
            <Row key={t.id} tool={t} required={required.includes(t.id)} auto={auto} onToggle={() => toggle(t.id)} />
          ))}
        </div>
      )}
      {data && !data.installer && missing.length > 0 && <p className="text-xs text-amber-400">{data.installerError}</p>}
      {problem && <Error>{problem}</Error>}
      {running && (
        <pre className="max-h-40 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 text-[11px] leading-snug text-zinc-400">
          {`Installing ${data?.install.what ?? ''} with ${data?.installer ?? ''}…\n${data?.install.output ?? ''}`}
        </pre>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={() => void refetch()} disabled={isFetching || running}>
          {isFetching ? 'Checking…' : 'Re-check'}
        </Button>
        {missing.length > 0 && data?.installer && (
          <Button variant="primary" disabled={running || install.isPending} onClick={() => install.mutate(missing.map((t) => t.id))}>
            {running ? 'Installing…' : `Install ${missing.map((t) => t.label).join(', ')}`}
          </Button>
        )}
        <span className="text-xs text-zinc-400">
          {!data
            ? ''
            : required.length === 0
              ? 'Nothing required.'
              : missing.length === 0
                ? 'Everything required is installed.'
                : `${missing.length} of ${required.length} missing.`}
        </span>
      </div>
    </div>
  );
}

function Mode({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 ${selected ? 'border-indigo-500 text-zinc-100' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
    >
      {children}
    </button>
  );
}

function Row({ tool, required, auto, onToggle }: { tool: StackTool; required: boolean; auto: boolean; onToggle: () => void }) {
  const mark = !required ? '·' : tool.installed ? '✓' : '✗';
  const color = !required ? 'text-zinc-500' : tool.installed ? 'text-emerald-400' : 'text-red-400';
  return (
    <label className={`flex items-center gap-3 rounded-md border border-zinc-800 px-3 py-2 ${auto ? '' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={required} disabled={auto} onChange={onToggle} className="accent-indigo-500" />
      <span className={`w-3 text-sm ${color}`}>{mark}</span>
      <span className="min-w-0 flex-1">
        <span className="text-sm text-zinc-100">{tool.label}</span>
        <span className="ml-2 truncate text-xs text-zinc-400">{tool.installed ? (tool.version ?? tool.command) : `${tool.command} not found`}</span>
      </span>
      {tool.detected && <span className="text-[10px] uppercase tracking-wide text-zinc-400">in the checkout</span>}
    </label>
  );
}

export const stackLabel = (value: StackChoice, ids: readonly StackId[] = STACK) =>
  value === 'auto' ? 'detected from the checkout' : value.length ? ids.filter((id) => value.includes(id)).join(', ') : 'nothing';
