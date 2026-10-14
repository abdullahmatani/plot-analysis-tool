import type { Bounds } from '@/core/types';

/**
 * Compact, transferable representation of an underlay drawing's entities.
 *
 * Parsers (DXF, DWG, PDF vector extraction) run in Web Workers and emit an EntityStore built from
 * typed arrays so it can be transferred to the main thread with zero copy (NFR-2: no long
 * main-thread blocks). Block references (INSERT) and dimensions are flattened: every child entity
 * is stored with its final transform applied, in drawing units.
 *
 * Geometry layouts in `geom` (Float64Array), starting at `geomStart[i]`:
 *   GK.LINE     x1, y1, x2, y2
 *   GK.CIRCLE   cx, cy, r
 *   GK.ARC      cx, cy, r, a0, a1                  (radians, counter-clockwise from a0 to a1)
 *   GK.ELLIPSE  cx, cy, mx, my, ratio, t0, t1      (major-axis vector (mx,my), minor/major ratio, params)
 *   GK.POLY     n, then n × (x, y, bulge)          (closed when FLAG.CLOSED is set)
 *   GK.POINT    x, y
 *   GK.TEXT     x, y, height, rotation, widthFactor, hAlign, vAlign, oblique, boxWidth, lineSpacing,
 *               font (index into `fonts`, -1 = unknown; row 24)
 *   GK.FILL     nRings, then per ring: n, n × (x, y, bulge)   (even-odd fill)
 *
 * TEXT alignment: hAlign 0 left, 1 centre, 2 right; vAlign 0 baseline, 1 bottom, 2 middle, 3 top.
 */

export const ET = {
  LINE: 1,
  CIRCLE: 2,
  ARC: 3,
  ELLIPSE: 4,
  LWPOLYLINE: 5,
  POLYLINE: 6,
  SPLINE: 7,
  POINT: 8,
  SOLID: 9,
  HATCH: 10,
  TEXT: 11,
  MTEXT: 12,
  DIMENSION: 13,
  ATTRIB: 14,
  LEADER: 15,
  TRACE: 16,
  FACE3D: 17,
  RAY: 18,
  XLINE: 19,
  PDF_PATH: 20,
  PDF_FILL: 21,
  PDF_TEXT: 22,
  WIPEOUT: 23,
  MLINE: 24,
  OTHER: 31,
} as const;

export type EntityTypeCode = (typeof ET)[keyof typeof ET];

export const ET_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(ET).map(([k, v]) => [v, k === 'FACE3D' ? '3DFACE' : k]),
);

export const GK = {
  LINE: 1,
  CIRCLE: 2,
  ARC: 3,
  ELLIPSE: 4,
  POLY: 5,
  POINT: 6,
  TEXT: 7,
  FILL: 8,
} as const;

export type GeomKind = (typeof GK)[keyof typeof GK];

export const FLAG = {
  CLOSED: 1,
  IN_BLOCK: 2,
  /** FILL entity that is a pattern hatch boundary (render outline + pattern, not solid). */
  PATTERN: 4,
  /** Entity should not be rendered (e.g. invisible attribute) but remains available for inspection. */
  HIDDEN: 8,
  /** Pattern lines generated for a hatch (not snappable / pickable). */
  DERIVED: 16,
} as const;

export interface SourceLayer {
  name: string;
  /** 0xRRGGBB */
  color: number;
  linetype: string;
  /** 1/100 mm, negative = default. */
  lineweight: number;
  off: boolean;
  frozen: boolean;
  plot: boolean;
  /** For PDF optional content groups: the OCG id. */
  ocgId?: string;
}

export interface LinetypeDef {
  name: string;
  /** Dash/gap lengths in drawing units: positive = dash, negative = gap, 0 = dot. Empty = continuous. */
  pattern: number[];
}

export interface ImportReport {
  /** Entities imported, by DXF type name. */
  counts: Record<string, number>;
  /** Entities skipped (unsupported or invalid), by type name. */
  skipped: Record<string, number>;
  warnings: string[];
  /** Fatal or partial-parse errors (DWG fallback, row 23). */
  errors: string[];
}

export interface EntityStore {
  count: number;
  type: Uint8Array;
  geomKind: Uint8Array;
  layer: Uint16Array;
  /** Resolved true colour 0xRRGGBB. */
  color: Uint32Array;
  /** Resolved lineweight in 1/100 mm (negative = default thin line). */
  lineweight: Int16Array;
  /** Index into `linetypes` (0 = continuous). */
  linetype: Uint16Array;
  /** Effective linetype scale (global × entity). */
  ltscale: Float32Array;
  flags: Uint8Array;
  geomStart: Uint32Array;
  geomLen: Uint32Array;
  /** minX, minY, maxX, maxY per entity. */
  bbox: Float64Array;
  /** Index into `texts`, or -1. */
  textIndex: Int32Array;
  /** Index into `inserts` of the top-level INSERT/DIMENSION this entity came from, or -1. */
  insertIndex: Int32Array;
  geom: Float64Array;
  texts: string[];
  /** Font file of each text style used (e.g. "txt.shx", "arial.ttf"); see cad-fonts.ts. */
  fonts?: string[];
  handles: string[];
  layers: SourceLayer[];
  linetypes: LinetypeDef[];
  inserts: { name: string; handle: string; type: string }[];
}

export interface DrawingParseResult {
  store: EntityStore;
  extents: Bounds;
  /** $INSUNITS code (CAD) or -1 for PDF points. */
  insunits: number;
  layouts: string[];
  layout: string;
  report: ImportReport;
  /** CAD format version (e.g. "AC1032") when known. */
  version?: string;
  /** PDF only: page size in points and whether the page is raster-only. */
  page?: {
    width: number;
    height: number;
    rotation: number;
    raster: boolean;
    ocgs: { id: string; name: string; visible: boolean }[];
  };
}

export interface EntityMeta {
  type: EntityTypeCode;
  layer: number;
  color: number;
  lineweight?: number;
  linetype?: number;
  ltscale?: number;
  flags?: number;
  handle?: string;
  insertIndex?: number;
}

/** Growable typed-array builder used by parsers inside workers. */
export class EntityStoreBuilder {
  count = 0;
  private cap = 0;
  private type = new Uint8Array(0);
  private geomKind = new Uint8Array(0);
  private layer = new Uint16Array(0);
  private color = new Uint32Array(0);
  private lineweight = new Int16Array(0);
  private linetype = new Uint16Array(0);
  private ltscale = new Float32Array(0);
  private flags = new Uint8Array(0);
  private geomStart = new Uint32Array(0);
  private geomLen = new Uint32Array(0);
  private bbox = new Float64Array(0);
  private textIndex = new Int32Array(0);
  private insertIndex = new Int32Array(0);
  private geom = new Float64Array(1024);
  private geomUsed = 0;
  texts: string[] = [];
  fonts: string[] = [];
  handles: string[] = [];
  layers: SourceLayer[] = [];
  linetypes: LinetypeDef[] = [{ name: 'CONTINUOUS', pattern: [] }];
  inserts: { name: string; handle: string; type: string }[] = [];

  private ensure(n: number) {
    if (this.count + n <= this.cap) return;
    const cap = Math.max(1024, (this.count + n) * 2);
    const grow = <T extends ArrayBufferView & { set(a: ArrayLike<number>): void }>(
      a: T,
      C: new (len: number) => T,
      per = 1,
    ): T => {
      const b = new C(cap * per);
      b.set(a as unknown as ArrayLike<number>);
      return b;
    };
    this.type = grow(this.type, Uint8Array);
    this.geomKind = grow(this.geomKind, Uint8Array);
    this.layer = grow(this.layer, Uint16Array);
    this.color = grow(this.color, Uint32Array);
    this.lineweight = grow(this.lineweight, Int16Array);
    this.linetype = grow(this.linetype, Uint16Array);
    this.ltscale = grow(this.ltscale, Float32Array);
    this.flags = grow(this.flags, Uint8Array);
    this.geomStart = grow(this.geomStart, Uint32Array);
    this.geomLen = grow(this.geomLen, Uint32Array);
    this.bbox = grow(this.bbox, Float64Array, 4);
    this.textIndex = grow(this.textIndex, Int32Array);
    this.insertIndex = grow(this.insertIndex, Int32Array);
    this.cap = cap;
  }

  private reserveGeom(n: number): number {
    if (this.geomUsed + n > this.geom.length) {
      const g = new Float64Array(Math.max(this.geom.length * 2, this.geomUsed + n));
      g.set(this.geom.subarray(0, this.geomUsed));
      this.geom = g;
    }
    const start = this.geomUsed;
    this.geomUsed += n;
    return start;
  }

  /** Adds an entity with raw geometry values; returns the entity index. */
  add(meta: EntityMeta, kind: GeomKind, values: ArrayLike<number>, bounds: Bounds, text?: string): number {
    this.ensure(1);
    const i = this.count++;
    this.type[i] = meta.type;
    this.geomKind[i] = kind;
    this.layer[i] = meta.layer;
    this.color[i] = meta.color >>> 0;
    this.lineweight[i] = meta.lineweight ?? -3;
    this.linetype[i] = meta.linetype ?? 0;
    this.ltscale[i] = meta.ltscale ?? 1;
    this.flags[i] = meta.flags ?? 0;
    const start = this.reserveGeom(values.length);
    this.geom.set(values, start);
    this.geomStart[i] = start;
    this.geomLen[i] = values.length;
    this.bbox[i * 4] = bounds.minX;
    this.bbox[i * 4 + 1] = bounds.minY;
    this.bbox[i * 4 + 2] = bounds.maxX;
    this.bbox[i * 4 + 3] = bounds.maxY;
    if (text !== undefined) {
      this.textIndex[i] = this.texts.length;
      this.texts.push(text);
    } else {
      this.textIndex[i] = -1;
    }
    this.insertIndex[i] = meta.insertIndex ?? -1;
    this.handles.push(meta.handle ?? '');
    return i;
  }

  finish(): EntityStore {
    const n = this.count;
    return {
      count: n,
      type: this.type.slice(0, n),
      geomKind: this.geomKind.slice(0, n),
      layer: this.layer.slice(0, n),
      color: this.color.slice(0, n),
      lineweight: this.lineweight.slice(0, n),
      linetype: this.linetype.slice(0, n),
      ltscale: this.ltscale.slice(0, n),
      flags: this.flags.slice(0, n),
      geomStart: this.geomStart.slice(0, n),
      geomLen: this.geomLen.slice(0, n),
      bbox: this.bbox.slice(0, n * 4),
      textIndex: this.textIndex.slice(0, n),
      insertIndex: this.insertIndex.slice(0, n),
      geom: this.geom.slice(0, this.geomUsed),
      texts: this.texts,
      fonts: this.fonts,
      handles: this.handles,
      layers: this.layers,
      linetypes: this.linetypes,
      inserts: this.inserts,
    };
  }
}

/** Index of a font file in the builder's font table (deduplicated, case-insensitive). */
export function fontIndex(b: { fonts: string[] }, font: string): number {
  const f = font.trim();
  if (!f) return -1;
  const key = f.toLowerCase();
  const i = b.fonts.findIndex((x) => x.toLowerCase() === key);
  if (i >= 0) return i;
  b.fonts.push(f);
  return b.fonts.length - 1;
}

/** Typed arrays of a store, for postMessage transfer lists. */
export function storeTransferables(s: EntityStore): ArrayBuffer[] {
  return [
    s.type,
    s.geomKind,
    s.layer,
    s.color,
    s.lineweight,
    s.linetype,
    s.ltscale,
    s.flags,
    s.geomStart,
    s.geomLen,
    s.bbox,
    s.textIndex,
    s.insertIndex,
    s.geom,
  ].map((a) => a.buffer as ArrayBuffer);
}

export function emptyReport(): ImportReport {
  return { counts: {}, skipped: {}, warnings: [], errors: [] };
}

export function storeExtents(s: EntityStore): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < s.count; i++) {
    if (s.flags[i] & FLAG.HIDDEN) continue;
    const o = i * 4;
    if (!Number.isFinite(s.bbox[o])) continue;
    if (s.bbox[o] < b.minX) b.minX = s.bbox[o];
    if (s.bbox[o + 1] < b.minY) b.minY = s.bbox[o + 1];
    if (s.bbox[o + 2] > b.maxX) b.maxX = s.bbox[o + 2];
    if (s.bbox[o + 3] > b.maxY) b.maxY = s.bbox[o + 3];
  }
  if (!Number.isFinite(b.minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return b;
}

/** Reads polyline vertices of a GK.POLY entity. */
export function readPoly(s: EntityStore, i: number): { x: number; y: number; bulge: number }[] {
  const o = s.geomStart[i];
  const n = s.geom[o];
  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    const p = o + 1 + k * 3;
    out[k] = { x: s.geom[p], y: s.geom[p + 1], bulge: s.geom[p + 2] };
  }
  return out;
}

/** Reads rings of a GK.FILL entity. */
export function readRings(s: EntityStore, i: number): { x: number; y: number; bulge: number }[][] {
  let o = s.geomStart[i];
  const nRings = s.geom[o++];
  const rings: { x: number; y: number; bulge: number }[][] = [];
  for (let r = 0; r < nRings; r++) {
    const n = s.geom[o++];
    const ring = new Array(n);
    for (let k = 0; k < n; k++, o += 3) ring[k] = { x: s.geom[o], y: s.geom[o + 1], bulge: s.geom[o + 2] };
    rings.push(ring);
  }
  return rings;
}
