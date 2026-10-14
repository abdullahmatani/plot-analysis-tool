import Flatbush from 'flatbush';

import { transformBounds } from '@/core/affine';
import type {
  Anchor,
  Bounds,
  ContourDataset,
  ContourLabelStyle,
  DashStyle,
  Geometry,
  Project,
  Pt,
  Vertex,
} from '@/core/types';
import { unionPolygons } from '@/geometry/boolean';
import { polygonsArea, polygonsToGeometry } from '@/geometry/clipper';
import { distanceToGeometry, pointInGeometry } from '@/geometry/hit';
import { bounds as geometryBounds } from '@/geometry/measure';
import { compileDatasetFilter, findColumn, normaliseAnchorName, sizeStyleFor } from '@/tables/access';
import { computeContours, type ContourItem } from '@/tables/contours';
import type { CompiledFilter } from '@/tables/filter';
import { categoryLegendKey, legendEntriesForRule } from '@/tables/style-rules';
import { validateDataset, type ValidationResult } from '@/tables/validate';
import { templateFields } from '@/tables/template';
import { cellText } from '@/tables/values';
import { getModel } from '@/underlay/models';
import { drawingPlacement } from '@/underlay/pick';

/**
 * Derived contours of a dataset (rows 63–71, 74; NFR-5). Contours are never stored as objects: they
 * are computed from the dataset and memoised per dataset object identity (Immer structural sharing
 * gives every edited dataset a new identity and keeps untouched ones), so every re-binding — label or
 * size column, radius/diameter, units, filter, style rule, a cell edit — recomputes only the dataset
 * that changed. `datasetContours` is the single source for the canvas overlay, hit-testing, the data
 * panel and (after merge) the export scene builder and legend builder.
 */

export interface ContourStyle {
  stroke: string;
  /** Paper millimetres. */
  strokeWidth: number;
  dash: DashStyle;
  fill: string;
  fillOpacity: number;
}

export interface ContourRing {
  /** 0-based row index into `dataset.table.rows`. */
  row: number;
  sizeColumn: string;
  item: ContourItem;
  /** World metres: circle, rect (square) or closed polyline with bulges (W×H rectangle + radius). */
  geometry: Geometry;
  bounds: Bounds;
  style: ContourStyle;
  /** Resolved label text ('' when labels are off). */
  label: string;
  legendKey: string;
}

export interface ContourEnvelope {
  sizeColumn: string;
  /** Union of the column's visible rings (closed polyline or multipolygon); null when empty. */
  geometry: Geometry | null;
  /** Area of the union in m² (identical to the boolean union area of the rings). */
  area: number;
  style: ContourStyle;
  legendKey: string;
  legendLabel: string;
}

export interface DatasetContours {
  datasetId: string;
  rings: ContourRing[];
  validation: ValidationResult;
  /** Per row: 1 when the row passes the dataset filter (or there is no filter). */
  passesFilter: Uint8Array;
  /** Filter compile error (the filter is then ignored). */
  filterError: string | null;
  unmatchedAnchors: string[];
  /** Rows that produced no ring (filtered, invalid, hidden category or nothing drawable). */
  skipped: number;
  bounds: Bounds | null;
  /** Legend keys of the rings actually drawn (filters reflect in the legend, row 71). */
  usedLegendKeys: Set<string>;
  labelStyle: ContourLabelStyle;
}

export const DEFAULT_LABEL_STYLE: ContourLabelStyle = { visible: true, size: 2.5, halo: true };

const QUARTER_BULGE = Math.tan(Math.PI / 8);

/**
 * Exact geometry of a contour item: circle, square (rect with w = h = 2r) or the W×H rectangle grown
 * by r with round corners (Minkowski sum with a disk, D-4) as a closed polyline with bulges.
 */
export function contourGeometry(it: ContourItem): Geometry {
  const rot = it.rot ?? 0;
  if (it.shape === 'circle') return { type: 'circle', c: { x: it.centre.x, y: it.centre.y }, r: it.r };
  if (it.shape === 'square' || it.w === undefined || it.h === undefined)
    return { type: 'rect', c: { x: it.centre.x, y: it.centre.y }, w: 2 * it.r, h: 2 * it.r, rot };
  const a = it.w / 2;
  const b = it.h / 2;
  const r = it.r;
  const local: Vertex[] = [
    { x: -a, y: -b - r },
    { x: a, y: -b - r, bulge: QUARTER_BULGE },
    { x: a + r, y: -b },
    { x: a + r, y: b, bulge: QUARTER_BULGE },
    { x: a, y: b + r },
    { x: -a, y: b + r, bulge: QUARTER_BULGE },
    { x: -a - r, y: b },
    { x: -a - r, y: -b, bulge: QUARTER_BULGE },
  ];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const pts = local.map((v) => {
    const p: Vertex = { x: it.centre.x + v.x * c - v.y * s, y: it.centre.y + v.x * s + v.y * c };
    if (v.bulge) p.bulge = v.bulge;
    return p;
  });
  return { type: 'polyline', pts, closed: true };
}

function ringBounds(g: Geometry): Bounds {
  if (g.type === 'circle')
    return { minX: g.c.x - g.r, minY: g.c.y - g.r, maxX: g.c.x + g.r, maxY: g.c.y + g.r };
  return geometryBounds(g);
}

// --- context (anchors, drawing extent) ------------------------------------------------------------

const anchorMaps = new WeakMap<Anchor[], Map<string, Pt>>();

/** Anchors keyed by normalised name (memoised per `project.anchors` identity). */
export function anchorMap(anchors: Anchor[]): Map<string, Pt> {
  let m = anchorMaps.get(anchors);
  if (!m) {
    m = new Map();
    for (const a of anchors) {
      const k = normaliseAnchorName(a.name);
      if (!m.has(k)) m.set(k, a.p);
    }
    anchorMaps.set(anchors, m);
  }
  return m;
}

/** World extent of the project's visible, loaded drawings (row 69); undefined when there is none. */
export function projectExtent(project: Project): Bounds | undefined {
  let out: Bounds | undefined;
  for (const d of project.drawings) {
    if (!d.visible) continue;
    const ext = getModel(d.id)?.result?.extents;
    if (!ext || !Number.isFinite(ext.minX) || ext.minX > ext.maxX) continue;
    const b = transformBounds(drawingPlacement(d), ext);
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          minY: Math.min(out.minY, b.minY),
          maxX: Math.max(out.maxX, b.maxX),
          maxY: Math.max(out.maxY, b.maxY),
        }
      : b;
  }
  return out;
}

function extentKey(b: Bounds | undefined): string {
  return b ? `${b.minX},${b.minY},${b.maxX},${b.maxY}` : '';
}

// --- dataset contours ----------------------------------------------------------------------------------

interface Cached {
  anchors: Anchor[];
  extent: string;
  precision: number;
  result: DatasetContours;
}

const cache = new WeakMap<ContourDataset, Cached>();

/** Options for callers outside the app (tests, export): override the drawing extent. */
export interface ContourOptions {
  extent?: Bounds | null;
}

/**
 * Contours of one dataset: validated, filtered rings with resolved styles and labels. Memoised per
 * dataset identity, anchors identity, drawing extent and display precision.
 */
export function datasetContours(
  project: Project,
  ds: ContourDataset,
  opts: ContourOptions = {},
): DatasetContours {
  const extent = opts.extent === undefined ? projectExtent(project) : (opts.extent ?? undefined);
  const ek = extentKey(extent);
  const precision = project.display.precision;
  const hit = cache.get(ds);
  if (hit && hit.anchors === project.anchors && hit.extent === ek && hit.precision === precision)
    return hit.result;
  const result = computeDatasetContours(ds, anchorMap(project.anchors), extent, precision);
  cache.set(ds, { anchors: project.anchors, extent: ek, precision, result });
  return result;
}

// Validation depends only on the table, the position/size/shape roles, anchors and the extent, so
// re-binding labels, styles, rules, filters or radius/diameter reuses it (NFR-5).
const validationCache = new WeakMap<
  ContourDataset['table']['rows'],
  { key: string; anchors: Map<string, Pt>; result: ValidationResult }
>();

function validationKey(ds: ContourDataset, extent: string): string {
  const m = ds.mapping;
  return JSON.stringify([
    ds.table.columns,
    m.position,
    m.sizeColumns,
    m.sizeUnit,
    m.shape,
    m.width,
    m.height,
    m.rotation,
    m.color,
    extent,
  ]);
}

function cachedValidation(
  ds: ContourDataset,
  anchors: Map<string, Pt>,
  extent: Bounds | undefined,
): ValidationResult {
  const key = validationKey(ds, extentKey(extent));
  const hit = validationCache.get(ds.table.rows);
  if (hit && hit.key === key && hit.anchors === anchors) return hit.result;
  const result = validateDataset(ds, { anchors, extent });
  validationCache.set(ds.table.rows, { key, anchors, result });
  return result;
}

interface CachedGeometry {
  it: ContourItem;
  g: Geometry;
  b: Bounds;
}

// Ring geometry is reused across re-bindings when the item's shape parameters are unchanged
// (per size column, indexed by row).
const geometryCache = new WeakMap<ContourDataset['table']['rows'], Map<string, CachedGeometry[]>>();

function sameShape(a: ContourItem, b: ContourItem): boolean {
  return (
    a.shape === b.shape &&
    a.r === b.r &&
    a.centre.x === b.centre.x &&
    a.centre.y === b.centre.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.rot === b.rot
  );
}

function computeDatasetContours(
  ds: ContourDataset,
  anchors: Map<string, Pt>,
  extent: Bounds | undefined,
  precision: number,
): DatasetContours {
  const validation = cachedValidation(ds, anchors, extent);
  let filter: CompiledFilter | null = null;
  let filterError: string | null = null;
  if (ds.filter && ds.filter.trim() !== '') {
    const f = compileDatasetFilter(ds);
    if (f.ok) filter = f;
    else filterError = f.error;
  }
  const rows = ds.table.rows;
  const passesFilter = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) passesFilter[i] = !filter || filter.test(rows[i]) ? 1 : 0;
  const labelStyle = { ...DEFAULT_LABEL_STYLE, ...(ds.labelStyle ?? {}) };
  const res = computeContours(ds, {
    anchors,
    // The filter is folded into validRows (evaluated once above), so no filter is passed here.
    filter: null,
    validRows: combine(validation.validRows, passesFilter),
    precision,
  });
  const prevGeoms = geometryCache.get(rows);
  const geoms = new Map<string, CachedGeometry[]>();
  const styles: ContourStyle[] = [];
  const rings: ContourRing[] = new Array(res.items.length);
  const used = new Set<string>();
  let b: Bounds | null = null;
  for (let k = 0; k < res.items.length; k++) {
    const it = res.items[k];
    let ge = prevGeoms?.get(it.sizeColumn)?.[it.row];
    if (!ge || !sameShape(ge.it, it)) {
      const g = contourGeometry(it);
      ge = { it, g, b: ringBounds(g) };
    }
    let col = geoms.get(it.sizeColumn);
    if (!col) geoms.set(it.sizeColumn, (col = []));
    col[it.row] = ge;
    const rb = ge.b;
    const legendKey = it.legendKey ?? `size:${it.sizeColumn}`;
    used.add(legendKey);
    // Few distinct styles per dataset: share the objects (cheap linear search).
    let style = styles.find(
      (st) =>
        st.stroke === it.color &&
        st.dash === it.dash &&
        st.fillOpacity === it.fillOpacity &&
        st.strokeWidth === it.strokeWidth,
    );
    if (!style) {
      style = {
        stroke: it.color,
        strokeWidth: it.strokeWidth,
        dash: it.dash,
        fill: it.color,
        fillOpacity: it.fillOpacity,
      };
      if (styles.length < 64) styles.push(style);
    }
    rings[k] = {
      row: it.row,
      sizeColumn: it.sizeColumn,
      item: it,
      geometry: ge.g,
      bounds: rb,
      style,
      label: labelStyle.visible ? it.label : '',
      legendKey,
    };
    if (!b) b = { ...rb };
    else {
      if (rb.minX < b.minX) b.minX = rb.minX;
      if (rb.minY < b.minY) b.minY = rb.minY;
      if (rb.maxX > b.maxX) b.maxX = rb.maxX;
      if (rb.maxY > b.maxY) b.maxY = rb.maxY;
    }
  }
  geometryCache.set(rows, geoms);
  if (labelStyle.visible && !labelPerRing(ds)) keepOuterLabels(rings);
  return {
    datasetId: ds.id,
    rings,
    validation,
    passesFilter,
    filterError,
    unmatchedAnchors: unmatchedAnchors(ds, anchors),
    skipped: res.skipped,
    bounds: b,
    usedLegendKeys: used,
    labelStyle,
  };
}

const SIZE_FIELDS = new Set(['radius', 'diameter', 'size', 'sizecolumn']);

/**
 * Labels that differ per ring (the template uses {radius}, {diameter}, {size} or {sizeColumn}) go on
 * every ring; otherwise a row's label is shown once, on its outermost ring (row 70).
 */
export function labelPerRing(ds: ContourDataset): boolean {
  const template = ds.labelTemplate || (ds.mapping.label ? '{label}' : '');
  return templateFields(template).some((f) => SIZE_FIELDS.has(f.trim().toLowerCase()));
}

/** Clears the label of every ring but the largest of each row (rings of a row are consecutive). */
function keepOuterLabels(rings: ContourRing[]) {
  let i = 0;
  while (i < rings.length) {
    let j = i;
    let best = i;
    while (j < rings.length && rings[j].row === rings[i].row) {
      if (rings[j].item.r > rings[best].item.r) best = j;
      j++;
    }
    for (let k = i; k < j; k++) if (k !== best) rings[k].label = '';
    i = j;
  }
}

/** Anchor names referenced by rows (anchor mode) that have no anchor; unique, as first written. */
function unmatchedAnchors(ds: ContourDataset, anchors: Map<string, Pt>): string[] {
  if (ds.mapping.position.mode !== 'anchor') return [];
  const col = findColumn(ds.table.columns, ds.mapping.position.anchor);
  if (col < 0) return [];
  const out = new Map<string, string>();
  for (const r of ds.table.rows) {
    const text = cellText(r[col]).trim();
    if (!text) continue;
    const k = normaliseAnchorName(text);
    if (!anchors.has(k) && !out.has(k)) out.set(k, text);
  }
  return [...out.values()];
}

function combine(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & b[i];
  return out;
}

// --- envelopes (row 74) ----------------------------------------------------------------------------------

const envelopeCache = new WeakMap<DatasetContours, { tol: number; envelopes: ContourEnvelope[] }>();

/**
 * Envelope per size column: the boolean union of the column's drawn rings. Computed lazily (only
 * when the dataset's envelope option is on) and memoised with its contours.
 */
export function datasetEnvelopes(
  project: Project,
  ds: ContourDataset,
  opts: ContourOptions = {},
): ContourEnvelope[] {
  if (!ds.envelope) return [];
  const dc = datasetContours(project, ds, opts);
  const tol = project.chordTolerance > 0 ? project.chordTolerance : 0.005;
  const hit = envelopeCache.get(dc);
  if (hit && hit.tol === tol) return hit.envelopes;
  const groups = new Map<string, Geometry[]>();
  for (const r of dc.rings) {
    let g = groups.get(r.sizeColumn);
    if (!g) groups.set(r.sizeColumn, (g = []));
    g.push(r.geometry);
  }
  const envelopes: ContourEnvelope[] = [];
  ds.mapping.sizeColumns.forEach((col, k) => {
    const gs = groups.get(col);
    if (!gs?.length) return;
    const polys = unionPolygons(gs, tol);
    const st = sizeStyleFor(ds, col, k);
    const es = ds.envelopeStyle ?? {};
    envelopes.push({
      sizeColumn: col,
      geometry: polygonsToGeometry(polys),
      area: polygonsArea(polys),
      style: {
        stroke: st.color,
        strokeWidth: es.strokeWidth ?? Math.max(0.5, st.strokeWidth * 2),
        dash: es.dash ?? 'solid',
        fill: st.color,
        fillOpacity: es.fillOpacity ?? 0,
      },
      legendKey: `envelope:${col}`,
      legendLabel: `${es.legendLabel || 'Envelope'} – ${st.legendLabel || col}`,
    });
  });
  envelopeCache.set(dc, { tol, envelopes });
  return envelopes;
}

/** True when the envelope replaces the individual rings on screen and in exports. */
export function ringsHiddenByEnvelope(ds: ContourDataset): boolean {
  return ds.envelope && ds.envelopeStyle?.hideRings === true;
}

// --- datasets, legend ----------------------------------------------------------------------------------

/** Visible datasets in draw order (lower `order` first). */
export function visibleDatasets(project: Project): ContourDataset[] {
  return project.datasets.filter((d) => d.visible).sort((a, b) => a.order - b.order);
}

export interface DatasetLegendEntry {
  key: string;
  label: string;
  kind: 'size' | 'rule' | 'envelope';
  color: string;
  dash: DashStyle;
  fillOpacity: number;
  strokeWidth: number;
}

export interface DatasetLegend {
  datasetId: string;
  /** Group title: the dataset's legend group, else its name. */
  title: string;
  entries: DatasetLegendEntry[];
}

/**
 * Legend entries for a dataset (rows 65, 67, 71, 74 → row 75): one per size column and per style-rule
 * class actually drawn (so filters and hidden size columns are reflected), plus envelope entries.
 */
export function datasetLegend(
  project: Project,
  ds: ContourDataset,
  opts: ContourOptions = {},
): DatasetLegend {
  const dc = datasetContours(project, ds, opts);
  const entries: DatasetLegendEntry[] = [];
  const sizeStyles = ds.mapping.sizeColumns.map((c, k) => sizeStyleFor(ds, c, k));
  const sw = sizeStyles[0]?.strokeWidth ?? 0.35;
  const hideRings = ringsHiddenByEnvelope(ds);
  if (!hideRings) {
    for (const rule of ds.styleRules) {
      for (const e of legendEntriesForRule(rule)) {
        if (!dc.usedLegendKeys.has(e.key)) continue;
        const cat =
          rule.kind === 'categorical'
            ? rule.categories?.find((c) => categoryLegendKey(rule.id, c.value) === e.key)
            : undefined;
        entries.push({
          key: e.key,
          label: e.label,
          kind: 'rule',
          color: e.color,
          dash: cat?.dash ?? rule.dash ?? 'solid',
          fillOpacity: cat?.fillOpacity ?? rule.fillOpacity ?? sizeStyles[0]?.fillOpacity ?? 0.1,
          strokeWidth: sw,
        });
      }
    }
    sizeStyles.forEach((st) => {
      const key = `size:${st.column}`;
      if (!st.visible || !dc.usedLegendKeys.has(key)) return;
      entries.push({
        key,
        label: st.legendLabel || st.column,
        kind: 'size',
        color: st.color,
        dash: st.dash,
        fillOpacity: st.fillOpacity,
        strokeWidth: st.strokeWidth,
      });
    });
  }
  for (const env of datasetEnvelopes(project, ds, opts)) {
    entries.push({
      key: env.legendKey,
      label: env.legendLabel,
      kind: 'envelope',
      color: env.style.stroke,
      dash: env.style.dash,
      fillOpacity: env.style.fillOpacity,
      strokeWidth: env.style.strokeWidth,
    });
  }
  return { datasetId: ds.id, title: ds.legendGroup || ds.name, entries };
}

// --- hit testing ---------------------------------------------------------------------------------------

const indexCache = new WeakMap<DatasetContours, Flatbush | null>();

function ringIndex(dc: DatasetContours): Flatbush | null {
  if (indexCache.has(dc)) return indexCache.get(dc) ?? null;
  let idx: Flatbush | null = null;
  if (dc.rings.length) {
    idx = new Flatbush(dc.rings.length);
    for (const r of dc.rings) idx.add(r.bounds.minX, r.bounds.minY, r.bounds.maxX, r.bounds.maxY);
    idx.finish();
  }
  indexCache.set(dc, idx);
  return idx;
}

export interface ContourHit {
  datasetId: string;
  row: number;
  sizeColumn: string;
}

/**
 * The contour under a world point: a ring outline within `tol` metres (closest first), else the
 * smallest ring containing the point. Top-most dataset first.
 */
export function hitContour(project: Project, world: Pt, tol: number): ContourHit | null {
  const sets = visibleDatasets(project).reverse();
  for (const ds of sets) {
    if (ringsHiddenByEnvelope(ds)) continue;
    const dc = datasetContours(project, ds);
    const idx = ringIndex(dc);
    if (!idx) continue;
    const ids = idx.search(world.x - tol, world.y - tol, world.x + tol, world.y + tol);
    let best: { k: number; d: number } | null = null;
    let inside: { k: number; size: number } | null = null;
    for (const k of ids) {
      const r = dc.rings[k];
      const d = distanceToGeometry(world, r.geometry);
      if (d <= tol && (!best || d < best.d)) best = { k, d };
      else if (!best && pointInGeometry(world, r.geometry)) {
        const size = (r.bounds.maxX - r.bounds.minX) * (r.bounds.maxY - r.bounds.minY);
        if (!inside || size < inside.size) inside = { k, size };
      }
    }
    const k = best?.k ?? inside?.k;
    if (k !== undefined)
      return { datasetId: ds.id, row: dc.rings[k].row, sizeColumn: dc.rings[k].sizeColumn };
  }
  return null;
}

/** Bounds of every visible dataset's rings (zoom extents). */
export function contourExtents(project: Project): Bounds[] {
  const out: Bounds[] = [];
  for (const ds of visibleDatasets(project)) {
    const b = datasetContours(project, ds).bounds;
    if (b) out.push(b);
  }
  return out;
}

/** Bounds of the rings of the given rows (zoom to selection). */
export function rowsBounds(project: Project, ds: ContourDataset, rows: Iterable<number>): Bounds | null {
  const set = new Set(rows);
  let b: Bounds | null = null;
  for (const r of datasetContours(project, ds).rings) {
    if (!set.has(r.row)) continue;
    b = b
      ? {
          minX: Math.min(b.minX, r.bounds.minX),
          minY: Math.min(b.minY, r.bounds.minY),
          maxX: Math.max(b.maxX, r.bounds.maxX),
          maxY: Math.max(b.maxY, r.bounds.maxY),
        }
      : { ...r.bounds };
  }
  return b;
}
