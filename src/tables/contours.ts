import type { CellValue, ContourDataset, DashStyle, Pt } from '@/core/types';
import { METRES_PER } from '@/core/units';

import {
  compileDatasetFilter,
  findColumn,
  normaliseAnchorName,
  parseShape,
  readPosition,
  readSize,
  resolveColumns,
  sizeStyleFor,
} from './access';
import type { CompiledFilter } from './filter';
import { compileStyleRules, parseColor } from './style-rules';
import { formatTemplateValue, parseTemplate } from './template';
import { cellText, isBlank, toNumber } from './values';

export { normaliseAnchorName };

/**
 * Derived contour computation for the renderer (rows 63–66, 70, 74; NFR-5). Pure and fast: a
 * 5 000-row × 3-size-column dataset with a label template and a categorical rule computes in a
 * few milliseconds, so every re-binding (label/size column, mode, units, filter, style rule) can
 * simply recompute.
 */

export interface ContourItem {
  /** 0-based index into `ds.table.rows`. */
  row: number;
  sizeColumn: string;
  /** World metres. */
  centre: Pt;
  shape: 'circle' | 'square' | 'rect';
  /**
   * Metres. Circle: radius. Square: half side. Rect: offset distance around the W×H rectangle
   * (round corners, D-4). In diameter mode r = value / 2 for every shape.
   */
  r: number;
  /** Rect only: base rectangle width/height in metres. */
  w?: number;
  h?: number;
  /** Radians, counter-clockwise (rotation column in degrees). */
  rot?: number;
  color: string;
  dash: DashStyle;
  fillOpacity: number;
  strokeWidth: number;
  label: string;
  group?: string;
  /** Legend entry that styled the item: a style-rule key, or `size:<column>`. */
  legendKey?: string;
}

export interface ContourContext {
  /** Anchors keyed by `normaliseAnchorName(name)`. */
  anchors: Map<string, Pt>;
  /** Row filter. undefined: compile `ds.filter` (an invalid expression filters nothing); null: no filter. */
  filter?: CompiledFilter | null;
  /** From `validateDataset`: rows with 0 are skipped. */
  validRows?: Uint8Array;
  /** Plant (E/N) → world transform for position mode 'plant' (row 31). */
  plantToWorld?: (p: Pt) => Pt;
  /** Decimals for numbers in labels without an explicit format (default 2). */
  precision?: number;
}

export interface ContourResult {
  items: ContourItem[];
  /** Anchor names referenced by rows but not found (unique, as written). */
  unmatchedAnchors: string[];
  /** Rows that produced no item (filtered out, invalid, hidden category or nothing drawable). */
  skipped: number;
}

/** Label template field resolved against the dataset. */
type LabelPart =
  | string
  | { kind: 'col'; idx: number; decimals?: number }
  | { kind: 'radius' | 'diameter' | 'size' | 'sizeColumn' | 'row'; decimals?: number };

const VIRTUAL: Record<string, 'radius' | 'diameter' | 'size' | 'sizeColumn' | 'row'> = {
  radius: 'radius',
  diameter: 'diameter',
  size: 'size',
  sizecolumn: 'sizeColumn',
  row: 'row',
};

function compileLabel(ds: ContourDataset): LabelPart[] {
  const m = ds.mapping;
  const template = ds.labelTemplate || (m.label ? '{label}' : '');
  const columns = ds.table.columns;
  const parts: LabelPart[] = [];
  for (const p of parseTemplate(template)) {
    if (typeof p === 'string') {
      parts.push(p);
      continue;
    }
    const dec = p.decimals === undefined ? {} : { decimals: p.decimals };
    const virtual = VIRTUAL[p.key];
    if (virtual) {
      parts.push({ kind: virtual, ...dec });
      continue;
    }
    let idx = -1;
    if (p.key === 'label' && m.label) idx = findColumn(columns, m.label);
    else if ((p.key === 'group' || p.key === 'category') && m.group) idx = findColumn(columns, m.group);
    if (idx < 0) idx = findColumn(columns, p.field);
    if (idx >= 0) parts.push({ kind: 'col', idx, ...dec });
    // Unknown fields render as ''.
  }
  return parts;
}

const DEG = Math.PI / 180;

/** Computes the contour items for a dataset. See `ContourItem` for shapes and units. */
export function computeContours(ds: ContourDataset, ctx: ContourContext): ContourResult {
  const { rows, columns } = ds.table;
  const m = ds.mapping;
  const cols = resolveColumns(ds);
  const unit = METRES_PER[m.sizeUnit] ?? 1;
  const half = m.sizeMode === 'diameter' ? 0.5 : 1;
  const precision = ctx.precision ?? 2;

  const sizes = m.sizeColumns
    .map((name, k) => ({ name, idx: cols.sizes[k], style: sizeStyleFor(ds, name, k) }))
    .filter((s) => s.idx >= 0 && s.style.visible)
    .map((s) => ({ ...s, legendKey: `size:${s.name}`, display: s.style.legendLabel || s.name }));

  let filter: CompiledFilter | null = null;
  if (ctx.filter !== undefined) filter = ctx.filter;
  else if (ds.filter && ds.filter.trim() !== '') {
    const f = compileDatasetFilter(ds);
    filter = f.ok ? f : null;
  }
  const rules = ds.styleRules.length > 0 ? compileStyleRules(ds.styleRules, columns) : null;
  const label = compileLabel(ds);
  const hasLabel = label.length > 0;
  const groupIdx = cols.group;
  const colorIdx = cols.color;
  const shapeIdx = cols.shape;
  const rotIdx = cols.rotation;

  const items: ContourItem[] = [];
  const unmatched = new Map<string, string>();
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (ctx.validRows && !ctx.validRows[i]) {
      skipped++;
      continue;
    }
    if (filter && !filter.test(row)) {
      skipped++;
      continue;
    }
    const pos = readPosition(row, ds, cols, ctx.anchors, ctx.plantToWorld);
    if (!pos.ok) {
      if (pos.reason === 'unknown-anchor' && pos.text) {
        const key = normaliseAnchorName(pos.text);
        if (!unmatched.has(key)) unmatched.set(key, pos.text);
      }
      skipped++;
      continue;
    }
    const rule = rules ? rules(row) : null;
    if (rule?.hidden) {
      skipped++;
      continue;
    }
    const rowColor = colorIdx >= 0 ? parseColor(row[colorIdx]) : null;
    let shape: ContourItem['shape'] = (shapeIdx >= 0 ? parseShape(row[shapeIdx]) : undefined) ?? 'circle';
    let w: number | undefined;
    let h: number | undefined;
    if (shape === 'rect') {
      const wv = cols.width >= 0 ? toNumber(row[cols.width]) : null;
      const hv = cols.height >= 0 ? toNumber(row[cols.height]) : null;
      if (wv !== null && hv !== null && wv > 0 && hv > 0) {
        w = wv * unit;
        h = hv * unit;
      } else {
        shape = 'square';
      }
    }
    const rotDeg = rotIdx >= 0 && shape !== 'circle' ? toNumber(row[rotIdx]) : null;
    const rot = rotDeg !== null && rotDeg !== 0 ? rotDeg * DEG : undefined;
    const group = groupIdx >= 0 && !isBlank(row[groupIdx]) ? cellText(row[groupIdx]) : undefined;

    let drawn = 0;
    for (const s of sizes) {
      const size = readSize(row[s.idx], unit);
      if (!size.ok) continue;
      const r = size.metres * half;
      const st = s.style;
      const item: ContourItem = {
        row: i,
        sizeColumn: s.name,
        centre: pos.p,
        shape,
        r,
        color: rule?.color ?? rowColor ?? st.color,
        dash: rule?.dash ?? st.dash,
        fillOpacity: rule?.fillOpacity ?? st.fillOpacity,
        strokeWidth: st.strokeWidth,
        label: hasLabel ? renderLabel(label, row, i, r, size.value, s.display, precision) : '',
        legendKey: rule?.legendKey ?? s.legendKey,
      };
      if (w !== undefined) {
        item.w = w;
        item.h = h;
      }
      if (rot !== undefined) item.rot = rot;
      if (group !== undefined) item.group = group;
      items.push(item);
      drawn++;
    }
    if (drawn === 0) skipped++;
  }
  return { items, unmatchedAnchors: [...unmatched.values()], skipped };
}

function renderLabel(
  parts: LabelPart[],
  row: CellValue[],
  i: number,
  r: number,
  size: number,
  sizeColumn: string,
  precision: number,
): string {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') {
      out += p;
      continue;
    }
    switch (p.kind) {
      case 'col':
        out += formatTemplateValue(row[p.idx], p.decimals, precision);
        break;
      case 'radius':
        out += formatTemplateValue(r, p.decimals, precision);
        break;
      case 'diameter':
        out += formatTemplateValue(2 * r, p.decimals, precision);
        break;
      case 'size':
        out += formatTemplateValue(size, p.decimals, precision);
        break;
      case 'sizeColumn':
        out += sizeColumn;
        break;
      case 'row':
        out += String(i + 1);
        break;
    }
  }
  return out;
}

export interface EnvelopeInput {
  sizeColumn: string;
  /** All items of the size column, in row order. */
  items: ContourItem[];
  /** The circle items as centre/radius pairs (squares and rectangles are in `items`). */
  circles: { c: Pt; r: number }[];
}

/** Groups items per size column for the envelope (union) option (row 74); order follows first appearance. */
export function envelopeInputs(items: ContourItem[]): EnvelopeInput[] {
  const groups = new Map<string, EnvelopeInput>();
  for (const it of items) {
    let g = groups.get(it.sizeColumn);
    if (!g) {
      g = { sizeColumn: it.sizeColumn, items: [], circles: [] };
      groups.set(it.sizeColumn, g);
    }
    g.items.push(it);
    if (it.shape === 'circle') g.circles.push({ c: it.centre, r: it.r });
  }
  return [...groups.values()];
}
