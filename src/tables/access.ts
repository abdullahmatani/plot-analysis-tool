import type { CellValue, ContourDataset, Pt, SizeColumnStyle } from '@/core/types';
import { PALETTE } from '@/core/project';
import { METRES_PER } from '@/core/units';

import { compileFilter, type FilterResult } from './filter';
import { cellText, isBlank, isNotReachedMarker, normaliseKey, toNumber } from './values';

/**
 * Shared per-row readers for contour datasets (used by validation and contour computation, so both
 * agree on what a valid position, size and shape are).
 */

/** Normalised anchor name used as the key of the anchors map: trimmed, case-insensitive (NFC). */
export function normaliseAnchorName(name: string): string {
  return normaliseKey(name);
}

/** Column index by exact name, then by case-/space-insensitive name; -1 when absent or unmapped. */
export function findColumn(columns: string[], name: string | undefined): number {
  if (!name) return -1;
  const exact = columns.indexOf(name);
  if (exact >= 0) return exact;
  const k = normaliseKey(name);
  return columns.findIndex((c) => normaliseKey(c) === k);
}

export interface ResolvedColumns {
  x: number;
  y: number;
  anchor: number;
  sizes: number[];
  label: number;
  group: number;
  color: number;
  shape: number;
  width: number;
  height: number;
  rotation: number;
}

export function resolveColumns(ds: ContourDataset): ResolvedColumns {
  const { columns } = ds.table;
  const m = ds.mapping;
  return {
    x: findColumn(columns, m.position.x),
    y: findColumn(columns, m.position.y),
    anchor: findColumn(columns, m.position.anchor),
    sizes: m.sizeColumns.map((c) => findColumn(columns, c)),
    label: findColumn(columns, m.label),
    group: findColumn(columns, m.group),
    color: findColumn(columns, m.color),
    shape: findColumn(columns, m.shape),
    width: findColumn(columns, m.width),
    height: findColumn(columns, m.height),
    rotation: findColumn(columns, m.rotation),
  };
}

export type SizeRead =
  | { ok: true; value: number; metres: number }
  | { ok: false; reason: 'empty' | 'not-reached' | 'non-numeric' | 'negative' | 'zero'; value?: number };

/** Reads a size cell (in the dataset's size unit) → metres. Empty and "not reached" markers are not errors. */
export function readSize(v: CellValue | undefined, unitFactor: number): SizeRead {
  if (isBlank(v)) return { ok: false, reason: 'empty' };
  const n = toNumber(v);
  if (n === null)
    return {
      ok: false,
      reason: typeof v === 'string' && isNotReachedMarker(v) ? 'not-reached' : 'non-numeric',
    };
  if (n < 0) return { ok: false, reason: 'negative', value: n };
  if (n === 0) return { ok: false, reason: 'zero', value: 0 };
  return { ok: true, value: n, metres: n * unitFactor };
}

export type ShapeKind = 'circle' | 'square' | 'rect';

const SHAPES: Record<string, ShapeKind> = {
  circle: 'circle',
  c: 'circle',
  round: 'circle',
  circular: 'circle',
  square: 'square',
  sq: 'square',
  s: 'square',
  box: 'square',
  rect: 'rect',
  rectangle: 'rect',
  r: 'rect',
  rectangular: 'rect',
};

/** Shape from a shape cell: undefined for blank (→ circle), null when not recognised. */
export function parseShape(v: CellValue | undefined): ShapeKind | null | undefined {
  if (isBlank(v)) return undefined;
  return SHAPES[normaliseKey(cellText(v))] ?? null;
}

export type PositionRead =
  | { ok: true; p: Pt }
  | {
      ok: false;
      reason:
        'missing-x' | 'missing-y' | 'bad-x' | 'bad-y' | 'missing-anchor' | 'unknown-anchor' | 'unmapped';
      text?: string;
    };

/**
 * Reads a row position in world metres. 'xy' and 'plant' read the X/Y (E/N) columns (in
 * `coordUnit`, default metres; plant coordinates go through `plantToWorld` when given), 'anchor'
 * looks the anchor name up in `anchors` (keys normalised with `normaliseAnchorName`).
 */
export function readPosition(
  row: CellValue[],
  ds: ContourDataset,
  cols: ResolvedColumns,
  anchors: Map<string, Pt>,
  plantToWorld?: (p: Pt) => Pt,
): PositionRead {
  const pos = ds.mapping.position;
  if (pos.mode === 'anchor') {
    if (cols.anchor < 0) return { ok: false, reason: 'unmapped' };
    const v = row[cols.anchor];
    if (isBlank(v)) return { ok: false, reason: 'missing-anchor' };
    const name = cellText(v).trim();
    const p = anchors.get(normaliseAnchorName(name));
    return p ? { ok: true, p: { x: p.x, y: p.y } } : { ok: false, reason: 'unknown-anchor', text: name };
  }
  if (cols.x < 0 || cols.y < 0) return { ok: false, reason: 'unmapped' };
  const xv = row[cols.x];
  const yv = row[cols.y];
  if (isBlank(xv)) return { ok: false, reason: 'missing-x' };
  if (isBlank(yv)) return { ok: false, reason: 'missing-y' };
  const x = toNumber(xv);
  if (x === null) return { ok: false, reason: 'bad-x', text: cellText(xv) };
  const y = toNumber(yv);
  if (y === null) return { ok: false, reason: 'bad-y', text: cellText(yv) };
  const f = METRES_PER[pos.coordUnit ?? 'm'] ?? 1;
  const p = { x: x * f, y: y * f };
  return pos.mode === 'plant' && plantToWorld ? { ok: true, p: plantToWorld(p) } : { ok: true, p };
}

/** Style for a size column, defaulting to a palette colour when the dataset has none for it. */
export function sizeStyleFor(ds: ContourDataset, column: string, index: number): SizeColumnStyle {
  const s = ds.sizeStyles.find((st) => st.column === column);
  return (
    s ?? {
      column,
      visible: true,
      color: PALETTE[index % PALETTE.length],
      dash: 'solid',
      fillOpacity: 0.1,
      strokeWidth: 0.35,
    }
  );
}

/** Names usable in filters besides the column names: the mapping roles of the dataset. */
export function datasetFilterAliases(ds: ContourDataset): Record<string, string | undefined> {
  const m = ds.mapping;
  const first = m.sizeColumns[0];
  return {
    label: m.label,
    group: m.group,
    category: m.group,
    x: m.position.x,
    y: m.position.y,
    easting: m.position.mode === 'plant' ? m.position.x : undefined,
    northing: m.position.mode === 'plant' ? m.position.y : undefined,
    anchor: m.position.anchor,
    size: first,
    radius: first,
    diameter: m.sizeMode === 'diameter' ? first : undefined,
    color: m.color,
    colour: m.color,
    shape: m.shape,
    width: m.width,
    height: m.height,
    rotation: m.rotation,
  };
}

/** Compiles the dataset's filter expression with its mapping roles as aliases. */
export function compileDatasetFilter(ds: ContourDataset): FilterResult {
  return compileFilter(ds.filter ?? '', ds.table.columns, { aliases: datasetFilterAliases(ds) });
}
