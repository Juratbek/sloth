import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import UiButton from '../components/ui/Button';

type ButtonProps = ComponentProps<typeof UiButton>;

/**
 * The wizard's and the settings' button — the shared one at its form size, with only the two variants
 * those pages use. Re-exported rather than re-implemented so that a change to the button is one change;
 * the rest of the UI reaches for `components/ui/Button` and its other sizes directly.
 */
export function Button(props: Omit<ButtonProps, 'size'>) {
  return <UiButton {...props} size="form" />;
}

export function Choice({
  selected,
  onSelect,
  title,
  subtitle,
  right,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left ${
        selected ? 'border-ok-edge-strong bg-ok-tint/30' : 'border-edge hover:bg-surface-raised'
      }`}
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full border ${selected ? 'border-ok bg-ok' : 'border-edge-focus'}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fg-strong">{title}</span>
        {subtitle && <span className="block truncate text-xs text-fg-muted">{subtitle}</span>}
      </span>
      {right && <span className="shrink-0 text-xs text-fg-muted">{right}</span>}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-fg-faint">{hint}</span>}
    </label>
  );
}

export const inputStyle =
  'w-full rounded-md border border-edge bg-surface-raised/60 px-2 py-1.5 text-sm text-fg-strong outline-none focus:border-edge-focus';

export function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputStyle} spellCheck={false} />;
}

// Keeps its own text so the field can be emptied while typing; a controlled `type="number"`
// bound straight to a number snaps back to "0" the moment the text is cleared.
export function NumberInput({ value, onChange, min = 1 }: { value: number; onChange: (v: number) => void; min?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
  }, [value]);
  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (next.trim() !== '' && Number.isFinite(Number(next))) onChange(Number(next));
      }}
      onBlur={() => {
        if (text.trim() === '' || !Number.isFinite(Number(text))) setText(String(value));
      }}
      className={inputStyle}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  placeholder = 'not set',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
  placeholder?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputStyle}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

export const Error = ({ children }: { children: ReactNode }) => <p className="text-sm text-danger">{children}</p>;
export const Loading = ({ what }: { what: string }) => <p className="text-sm text-fg-muted">Loading {what}…</p>;
