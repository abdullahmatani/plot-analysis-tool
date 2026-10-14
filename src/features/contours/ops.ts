import type { Draft } from 'immer';

import { newId } from '@/core/ids';
import type {
  CellValue,
  ContourDataset,
  ContourLabelStyle,
  Project,
  SizeColumnStyle,
  StyleRule,
} from '@/core/types';
import { commit, getProject } from '@/store/project';
import { findColumn } from '@/tables/access';
import type { Mapping } from '@/tables/suggest';
import { assignCategoryColors } from '@/tables/style-rules';
import { parseNumber, trimCell } from '@/tables/values';

/**
 * Contour dataset commands (rows 62–74). Every user action is exactly one undoable commit: an import,
 * a re-binding (label/size column, mode, units, filter, style rule), a cell edit, a re-import.
 */

/** Ring-set colours for size columns (outer → inner reads blue, amber, red…). */
export const SIZE_COLORS = [
  '#2563eb',
  '#d97706',
  '#e11d48',
  '#16a34a',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
];

export function defaultSizeStyle(column: string, index: number): SizeColumnStyle {
  return {
    column,
    visible: true,
    color: SIZE_COLORS[index % SIZE_COLORS.length],
    dash: 'solid',
    fillOpacity: 0.08,
    strokeWidth: 0.35,
  };
}

/**
 * Ensures every size column has a style. Existing styles are kept (also for columns no longer
 * mapped, so re-adding a column restores its styling); new columns get the next unused colour.
 */
export function reconcileSizeStyles(sizeColumns: string[], existing: SizeColumnStyle[]): SizeColumnStyle[] {
  const out = existing.map((s) => ({ ...s }));
  const used = new Set(out.map((s) => s.color.toLowerCase()));
  sizeColumns.forEach((col, k) => {
    if (out.some((s) => s.column === col)) return;
    const st = defaultSizeStyle(col, k);
    const free = SIZE_COLORS.find((c) => !used.has(c));
    if (free) st.color = free;
    used.add(st.color);
    out.push(st);
  });
  return out;
}

/**
 * Adds category values that appeared in the data to every categorical rule, with the next free
 * palette colour (row 67: a new category value gets a colour and a legend entry automatically).
 * Mutates `ds` (a plain object or an Immer draft); returns true when something was added.
 */
export function syncCategories(ds: ContourDataset | Draft<ContourDataset>): boolean {
  let changed = false;
  for (const rule of ds.styleRules) {
    if (rule.kind !== 'categorical') continue;
    const idx = findColumn(ds.table.columns, rule.column);
    if (idx < 0) continue;
    const existing = (rule.categories ?? []) as NonNullable<StyleRule['categories']>;
    const next = assignCategoryColors(
      ds.table.rows.map((r) => r[idx]),
      existing,
    );
    if (next.length !== existing.length) {
      for (const c of next.slice(existing.length)) {
        if (!rule.categories) rule.categories = [];
        rule.categories.push(c);
      }
      changed = true;
    }
  }
  return changed;
}

export interface NewDatasetInput {
  name: string;
  table: { columns: string[]; rows: CellValue[][] };
  mapping: Mapping;
  sizeStyles?: SizeColumnStyle[];
  styleRules?: StyleRule[];
  labelTemplate?: string;
  labelPlacement?: ContourDataset['labelPlacement'];
  labelStyle?: ContourLabelStyle;
  envelope?: boolean;
  filter?: string;
  legendGroup?: string;
  source?: ContourDataset['source'];
}

/** Builds a new dataset (not yet committed); `order` puts it on top of the existing ones. */
export function buildDataset(project: Project, input: NewDatasetInput): ContourDataset {
  const order = project.datasets.reduce((m, d) => Math.max(m, d.order + 1), 0);
  const ds: ContourDataset = {
    id: newId('ds'),
    name: input.name,
    visible: true,
    table: input.table,
    mapping: structuredClone(input.mapping),
    sizeStyles: reconcileSizeStyles(input.mapping.sizeColumns, input.sizeStyles ?? []),
    styleRules: structuredClone(input.styleRules ?? []),
    labelTemplate: input.labelTemplate ?? '',
    labelPlacement: input.labelPlacement ?? 'top',
    envelope: input.envelope ?? false,
    order,
  };
  if (input.filter) ds.filter = input.filter;
  if (input.legendGroup) ds.legendGroup = input.legendGroup;
  if (input.labelStyle) ds.labelStyle = { ...input.labelStyle };
  if (input.source) ds.source = { ...input.source };
  syncCategories(ds);
  return ds;
}

/** Commits a new dataset (one undo step). */
export function addDataset(ds: ContourDataset): boolean {
  return commit(`Import dataset “${ds.name}”`, (d) => {
    d.datasets.push(ds);
  });
}

/** Applies one change to a dataset as one undoable command. */
export function updateDataset(
  id: string,
  label: string,
  fn: (ds: Draft<ContourDataset>, project: Draft<Project>) => void,
  opts: { coalesceKey?: string } = {},
): boolean {
  return commit(
    label,
    (d) => {
      const ds = d.datasets.find((x) => x.id === id);
      if (!ds) return;
      fn(ds, d);
      syncCategories(ds);
    },
    opts.coalesceKey ? { coalesceKey: opts.coalesceKey } : undefined,
  );
}

/** Typed cell text → cell value: trimmed, '' → empty, numbers (incl. separators) → numbers. */
export function parseCellInput(raw: string): CellValue {
  const s = trimCell(raw.replace(/\r\n?/g, '\n'));
  if (s === '') return null;
  const n = parseNumber(s);
  return n === null ? s : n;
}

/** Edits one cell (row 68); the contour updates immediately. */
export function setCell(id: string, row: number, col: number, raw: string): boolean {
  const ds = getProject()?.datasets.find((x) => x.id === id);
  if (!ds) return false;
  const value = parseCellInput(raw);
  if (ds.table.rows[row]?.[col] === value) return true;
  const name = ds.table.columns[col] ?? `column ${col + 1}`;
  return updateDataset(id, `Edit cell ${name} (row ${row + 1})`, (d) => {
    const r = d.table.rows[row];
    if (!r) return;
    while (r.length < d.table.columns.length) r.push(null);
    r[col] = value;
  });
}

/** Appends an empty row (or a copy of `copyOf`); returns its index, or -1 when nothing was added. */
export function addRow(id: string, copyOf?: number): number {
  const ds = getProject()?.datasets.find((x) => x.id === id);
  if (!ds) return -1;
  const index = ds.table.rows.length;
  const src = copyOf !== undefined ? ds.table.rows[copyOf] : undefined;
  const row: CellValue[] = src ? [...src] : ds.table.columns.map(() => null);
  const ok = updateDataset(id, src ? `Duplicate row ${copyOf! + 1}` : 'Add row', (d) => {
    d.table.rows.push(row);
  });
  return ok ? index : -1;
}

export function deleteRows(id: string, rows: number[]): boolean {
  if (!rows.length) return false;
  const set = new Set(rows);
  return updateDataset(
    id,
    rows.length === 1 ? `Delete row ${rows[0] + 1}` : `Delete ${rows.length} rows`,
    (d) => {
      d.table.rows = d.table.rows.filter((_, i) => !set.has(i));
    },
  );
}

/**
 * Re-import (row 72): replaces the table, keeping mapping, styles, rules, filter and labels. When a
 * new mapping is given (headers changed) it replaces the old one; size styles of kept columns stay.
 */
export function replaceData(
  id: string,
  table: { columns: string[]; rows: CellValue[][] },
  opts: { mapping?: Mapping; source?: ContourDataset['source'] } = {},
): boolean {
  const ds = getProject()?.datasets.find((x) => x.id === id);
  if (!ds) return false;
  return updateDataset(id, `Re-import dataset “${ds.name}”`, (d) => {
    d.table = table;
    if (opts.mapping) {
      d.mapping = structuredClone(opts.mapping);
      d.sizeStyles = reconcileSizeStyles(opts.mapping.sizeColumns, d.sizeStyles as SizeColumnStyle[]);
    }
    if (opts.source) d.source = { ...opts.source };
  });
}

export function deleteDataset(id: string): boolean {
  const ds = getProject()?.datasets.find((x) => x.id === id);
  if (!ds) return false;
  return commit(`Delete dataset “${ds.name}”`, (d) => {
    d.datasets = d.datasets.filter((x) => x.id !== id);
  });
}

/** Moves a dataset one step up (drawn later, on top) or down in the draw order (row 71). */
export function moveDataset(id: string, dir: 1 | -1): boolean {
  const p = getProject();
  if (!p) return false;
  const sorted = [...p.datasets].sort((a, b) => a.order - b.order);
  const i = sorted.findIndex((d) => d.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sorted.length) return false;
  [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  const orders = new Map(sorted.map((d, k) => [d.id, k]));
  return commit('Reorder datasets', (d) => {
    for (const ds of d.datasets) ds.order = orders.get(ds.id) ?? ds.order;
  });
}

/** Mapping with every column name resolved to the table's own spelling (case/space-insensitive). */
export function resolveMappingColumns(mapping: Mapping, columns: string[]): Mapping {
  const fix = (c: string | undefined) => {
    if (c === undefined) return undefined;
    const i = findColumn(columns, c);
    return i >= 0 ? columns[i] : c;
  };
  const out: Mapping = {
    ...mapping,
    position: { ...mapping.position },
    sizeColumns: mapping.sizeColumns.map((c) => fix(c)!),
  };
  for (const k of ['x', 'y', 'anchor'] as const) if (out.position[k]) out.position[k] = fix(out.position[k]);
  for (const k of ['label', 'group', 'color', 'shape', 'width', 'height', 'rotation'] as const)
    if (out[k]) out[k] = fix(out[k]);
  return out;
}

export function nextDatasetName(project: Project, base: string): string {
  const used = new Set(project.datasets.map((d) => d.name));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} (${n})`)) return `${base} (${n})`;
}
