import { useEffect, useState, type ReactNode } from 'react';
import type { SlothConfig } from '../../server/config-types';
import { useModels } from '../hooks/use-models';
import { TextInput, inputStyle } from '../setup/ui';

/** What every settings section gets: the config being edited and a way to change part of it. */
export interface SectionProps {
  draft: SlothConfig;
  patch: (p: Partial<SlothConfig>) => void;
}

/** One setting: its name and what it does on the left, the control on the right. */
export function Row({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex items-start gap-6 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-100">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{hint}</p>}
      </div>
      <div className={`flex shrink-0 justify-end ${wide ? 'w-80' : 'w-56'}`}>{children}</div>
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-indigo-500' : 'bg-zinc-700'}`}
    >
      <span className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
    </button>
  );
}

/** A select with exactly the given options — plus a placeholder while nothing is chosen. */
export function Choose({
  value,
  onChange,
  options,
  placeholder = 'choose…',
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
  placeholder?: string;
  label?: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={inputStyle}>
      {!options.some((o) => o.id === value) && <option value={value}>{placeholder}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

/**
 * A list edited as one line of text — logins separated by commas, a command's words by spaces. The text
 * is kept as typed (a trailing comma survives) and only re-rendered from the value when that changes
 * underneath it: a discard, a restore, a save.
 */
export function ListInput({
  value,
  onChange,
  split,
  join,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  split: RegExp;
  join: string;
  placeholder?: string;
}) {
  const parse = (t: string) => t.split(split).filter(Boolean);
  const [text, setText] = useState(value.join(join));
  useEffect(() => {
    setText((t) => (parse(t).join('\0') === value.join('\0') ? t : value.join(join)));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <TextInput
      value={text}
      onChange={(t) => {
        setText(t);
        onChange(parse(t));
      }}
      placeholder={placeholder}
    />
  );
}

/**
 * One agent's model, grouped by the provider that serves it. A provider whose key this machine does not
 * have is still listed — greyed out and naming the variable that would turn it on — so a model can be
 * seen before it can be picked. Anything not on the list is typed in as a custom id, which still routes:
 * `server/models.ts` recognises a versioned id by its family.
 */
export function ModelPicker({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const choices = useModels();
  const listed = choices.some((c) => c.id === value);
  const [custom, setCustom] = useState(!listed);
  // A restore or a discard that lands on a listed model closes the custom field.
  useEffect(() => {
    if (listed) setCustom(false);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const providers = [...new Map(choices.map((c) => [c.provider, c.providerLabel])).entries()];
  return (
    <div className="w-full space-y-1.5">
      <select
        aria-label={label}
        value={custom ? 'custom' : value}
        onChange={(e) => {
          if (e.target.value === 'custom') setCustom(true);
          else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
        className={inputStyle}
      >
        {providers.map(([id, providerLabel]) => (
          <optgroup key={id} label={providerLabel}>
            {choices
              .filter((c) => c.provider === id)
              // The configured model stays selectable even where its key has gone missing, so opening
              // the page cannot silently rewrite a saved choice.
              .map((c) => (
                <option key={c.id} value={c.id} disabled={!c.available && c.id !== value}>
                  {c.name}
                  {c.hint ? ` — ${c.hint}` : ''}
                  {c.available ? '' : ` — set ${c.tokenEnv}`}
                </option>
              ))}
          </optgroup>
        ))}
        <option value="custom">Custom model id…</option>
      </select>
      {custom && <TextInput value={value} onChange={onChange} placeholder="claude-opus-5" />}
    </div>
  );
}
