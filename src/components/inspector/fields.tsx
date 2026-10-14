import { useEffect, useState, type ReactNode } from 'react';

import { formatNumber, fromMetres, parseLength, UNIT_LABEL } from '@/core/units';
import type { Units } from '@/core/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Small form controls for the inspector that commit on Enter/blur (one undo step per edit). */

export function Field({
  label,
  children,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
      <Label htmlFor={htmlFor} className="text-muted-foreground text-xs font-normal">
        {label}
      </Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function CommitInput({
  value,
  onCommit,
  className,
  id,
  placeholder,
  disabled,
  ariaLabel,
}: {
  value: string;
  onCommit: (v: string) => boolean | void;
  className?: string;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(value);
    setInvalid(false);
  }, [value]);
  const commitNow = () => {
    if (draft === value) return;
    const ok = onCommit(draft);
    if (ok === false) setInvalid(true);
  };
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      placeholder={placeholder}
      className={cn('h-7 text-xs', className)}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        setInvalid(false);
      }}
      onBlur={commitNow}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitNow();
        } else if (e.key === 'Escape') {
          setDraft(value);
          setInvalid(false);
        }
        e.stopPropagation();
      }}
    />
  );
}

/** Length input in display units (accepts "15", "15 m", "1500mm"). Value in metres. */
export function LengthInput({
  metres,
  units,
  precision,
  onCommit,
  disabled,
  ariaLabel,
  allowNegative,
}: {
  metres: number;
  units: Units;
  precision: number;
  onCommit: (m: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
  allowNegative?: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <CommitInput
        ariaLabel={ariaLabel}
        disabled={disabled}
        value={formatNumber(fromMetres(metres, units), precision + 2).replace(/\u202F/g, '')}
        onCommit={(v) => {
          const m = parseLength(v.replace(/\u202F|\s(?=\d)/g, ''), units);
          if (m === null || (!allowNegative && m < 0)) return false;
          onCommit(m);
        }}
      />
      <span className="text-muted-foreground w-6 text-xs">{UNIT_LABEL[units]}</span>
    </div>
  );
}

export function NumberInput({
  value,
  onCommit,
  min,
  max,
  suffix,
  disabled,
  ariaLabel,
  decimals = 3,
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
  ariaLabel?: string;
  decimals?: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <CommitInput
        ariaLabel={ariaLabel}
        disabled={disabled}
        value={String(Number(value.toFixed(decimals)))}
        onCommit={(v) => {
          const n = Number(v.replace(',', '.'));
          if (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max))
            return false;
          onCommit(n);
        }}
      />
      {suffix && <span className="text-muted-foreground w-6 text-xs">{suffix}</span>}
    </div>
  );
}

const SWATCHES = [
  '#e11d48',
  '#f97316',
  '#eab308',
  '#16a34a',
  '#0891b2',
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#111827',
  '#6b7280',
  '#ffffff',
];

export function ColorInput({
  value,
  onCommit,
  disabled,
  ariaLabel,
}: {
  value: string;
  onCommit: (c: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="color"
        aria-label={ariaLabel}
        disabled={disabled}
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
        onChange={(e) => onCommit(e.target.value)}
        className="h-7 w-8 cursor-pointer rounded border bg-transparent p-0.5"
      />
      <div className="flex flex-wrap gap-0.5">
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            disabled={disabled}
            aria-label={`Colour ${c}`}
            className={cn(
              'size-3.5 rounded-sm border',
              c.toLowerCase() === value.toLowerCase() && 'ring-ring ring-2',
            )}
            style={{ background: c }}
            onClick={() => onCommit(c)}
          />
        ))}
      </div>
    </div>
  );
}
