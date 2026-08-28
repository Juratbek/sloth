import type { ReactNode } from 'react';

export function Button({
  children,
  onClick,
  disabled,
  variant = 'ghost',
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'ghost' | 'primary';
  type?: 'button' | 'submit';
}) {
  const style =
    variant === 'primary'
      ? 'bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500'
      : 'border border-zinc-800 text-zinc-300 hover:bg-zinc-900 disabled:text-zinc-600';
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`rounded-md px-3 py-1.5 text-sm disabled:cursor-not-allowed ${style}`}>
      {children}
    </button>
  );
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
        selected ? 'border-emerald-700 bg-emerald-950/30' : 'border-zinc-800 hover:bg-zinc-900'
      }`}
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full border ${selected ? 'border-emerald-400 bg-emerald-400' : 'border-zinc-600'}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-zinc-100">{title}</span>
        {subtitle && <span className="block truncate text-xs text-zinc-500">{subtitle}</span>}
      </span>
      {right && <span className="shrink-0 text-xs text-zinc-500">{right}</span>}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-zinc-600">{hint}</span>}
    </label>
  );
}

const inputStyle =
  'w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-600';

export function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputStyle} spellCheck={false} />;
}

export function NumberInput({ value, onChange, min = 1 }: { value: number; onChange: (v: number) => void; min?: number }) {
  return <input type="number" min={min} value={value} onChange={(e) => onChange(Number(e.target.value))} className={inputStyle} />;
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

export const Error = ({ children }: { children: ReactNode }) => <p className="text-sm text-red-400">{children}</p>;
export const Loading = ({ what }: { what: string }) => <p className="text-sm text-zinc-500">Loading {what}…</p>;
