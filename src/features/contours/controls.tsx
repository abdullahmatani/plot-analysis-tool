import type { ReactNode } from 'react';

import type { DashStyle, Units } from '@/core/types';
import { ALL_UNITS, UNIT_LABEL } from '@/core/units';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

import { DASHES } from './constants';

/** Small shared controls for the contour dialogs and the Data panel. */

export const NONE = '__none__';

export function Row({
  label,
  children,
  htmlFor,
  required,
  className,
}: {
  label: string;
  children: ReactNode;
  htmlFor?: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-[7.5rem_1fr] items-center gap-2', className)}>
      <Label htmlFor={htmlFor} className="text-muted-foreground text-xs font-normal">
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function ColumnSelect({
  value,
  onChange,
  columns,
  allowNone = true,
  label,
  testId,
  invalid,
  disabled,
  noneLabel = '— None —',
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  columns: string[];
  allowNone?: boolean;
  label: string;
  testId?: string;
  invalid?: boolean;
  disabled?: boolean;
  noneLabel?: string;
}) {
  const v = value && columns.includes(value) ? value : NONE;
  return (
    <Select value={v} onValueChange={(x) => onChange(x === NONE ? undefined : x)} disabled={disabled}>
      <SelectTrigger
        size="sm"
        className="w-full min-w-0 text-xs"
        aria-label={label}
        aria-invalid={invalid || undefined}
        data-testid={testId}
      >
        <SelectValue placeholder={allowNone ? noneLabel : 'Choose a column'} />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {!allowNone && v === NONE && (
          <SelectItem value={NONE} disabled>
            Choose a column
          </SelectItem>
        )}
        {columns.map((c) => (
          <SelectItem key={c} value={c}>
            {c}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function UnitSelect({
  value,
  onChange,
  label,
  testId,
  disabled,
}: {
  value: Units;
  onChange: (u: Units) => void;
  label: string;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(u) => onChange(u as Units)} disabled={disabled}>
      <SelectTrigger size="sm" className="w-24 text-xs" aria-label={label} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ALL_UNITS.map((u) => (
          <SelectItem key={u} value={u}>
            {UNIT_LABEL[u]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function DashSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: DashStyle;
  onChange: (d: DashStyle) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(d) => onChange(d as DashStyle)} disabled={disabled}>
      <SelectTrigger size="sm" className="w-28 text-xs" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {DASHES.map((d) => (
          <SelectItem key={d.v} value={d.v}>
            {d.l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Line sample used in lists and legends-in-panels. */
export function Swatch({
  color,
  dash,
  fillOpacity,
  className,
}: {
  color: string;
  dash?: DashStyle;
  fillOpacity?: number;
  className?: string;
}) {
  const style = dash === 'dash' || dash === 'long-dash' ? 'dashed' : dash === 'dot' ? 'dotted' : 'solid';
  const fill = /^#[0-9a-f]{6}$/i.test(color)
    ? `${color}${Math.round(Math.min(1, Math.max(0, fillOpacity ?? 0)) * 255)
        .toString(16)
        .padStart(2, '0')}`
    : 'transparent';
  return (
    <span
      aria-hidden
      className={cn('inline-block size-3.5 shrink-0 rounded-full border-2', className)}
      style={{ borderColor: color, borderStyle: style, background: fill }}
    />
  );
}
