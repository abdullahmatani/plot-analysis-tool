import earcut from 'earcut';
import Flatbush from 'flatbush';

import type { Bounds } from '@/core/types';
import { bulgeToArc } from '@/geometry/bulge';

import { FLAG, GK, readRings, type EntityStore } from './entity-store';

/**
 * GPU-ready render data built (in the parse worker) from an EntityStore.
 *
 * Large-coordinate handling (row 18): entities are bucketed into a spatial grid; each batch stores
 * float32 coordinates relative to its own origin (float64, in drawing units). The renderer computes
 * the batch → clip transform per frame in float64, so plant/UTM-sized coordinates render without
 * jitter and with sub-millimetre placement. float32 keeps about 7 significant digits of a vertex's
 * offset from its batch origin, which on a 10 km site or along a long entity is not enough at the
 * highest zooms; there the renderer draws a detail batch instead (`buildDetailData`), built from the
 * float64 entities around the view and clipped to it.
 *
 * Segment instance layout (SEG_STRIDE bytes):
 *   0  f32 x0, 4 f32 y0, 8 f32 x1, 12 f32 y1   (relative to batch origin)
 *   16 u8×4 rgba
 *   20 f32 width (CSS px; 0 = hairline)
 *   24 f32 dist0 (distance along the source polyline at x0,y0, drawing units — for linetypes)
 *   28 u16 layer, 30 u16 pattern (linetype index, 0 = continuous)
 *   32 f32 ltscale
 * Triangle vertex layout (TRI_STRIDE bytes): f32 x, f32 y, u8×4 rgba, u16 layer, u16 pad.
 */

export const SEG_STRIDE = 36;
export const TRI_STRIDE = 16;
export const MAX_SEGMENTS_PER_BATCH = 65536;
export const MAX_TRI_VERTS_PER_BATCH = 196608;
export const MAX_PATTERN_ELEMENTS = 14;

export interface SegmentBatch {
  ox: number;
  oy: number;
  count: number;
  data: ArrayBuffer;
  /** Bounds of the batch in drawing units (viewport culling). */
  bounds?: Bounds;
}

export interface TriangleBatch {
  ox: number;
  oy: number;
  count: number;
  data: ArrayBuffer;
  bounds?: Bounds;
}

export interface RenderData {
  segments: SegmentBatch[];
  triangles: TriangleBatch[];
  /** Linetype patterns: per pattern 16 floats: [n, total, e0 … e13]. */
  patterns: Float32Array;
  /** Flatbush index over all entities' bounding boxes (drawing units). */
  index: ArrayBuffer | null;
  /** Flatbush index over TEXT entities; `textIds` maps index ids → entity indices. */
  textIndex: ArrayBuffer | null;
  textIds: Uint32Array;
  extents: Bounds;
  segmentCount: number;
}

export interface RenderOptions {
  /** Max chord deviation for curve tessellation, as a fraction of the drawing diagonal. */
  relChordTol?: number;
  /** Grid cells per axis for spatial batching. */
  grid?: number;
  /** Only build spatial indices (e.g. PDF pages, which are drawn as raster tiles). */
  indexOnly?: boolean;
}

/** Converts a lineweight in 1/100 mm into a display width in CSS px (0 = hairline). */
export function lineweightPx(lw: number): number {
  if (lw <= 25) return 0; // default and thin lines draw as 1 px hairlines
  return Math.max(1, (lw / 100) * (96 / 25.4) * 0.75);
}

/**
 * Liang–Barsky: the parameter range [t0, t1] of segment (x0,y0)–(x1,y1) inside rectangle `r`, or
 * null when it misses it.
 */
export function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: Bounds,
): [number, number] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, x0 - r.minX],
    [dx, r.maxX - x0],
    [-dy, y0 - r.minY],
    [dy, r.maxY - y0],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [t0, t1];
}

/** Sutherland–Hodgman: polygon (flat x,y) clipped to rectangle `r` (flat x,y; empty if outside). */
export function clipPolygon(pts: number[], r: Bounds): number[] {
  let out = pts;
  const edges: [
    (x: number, y: number) => boolean,
    (ax: number, ay: number, bx: number, by: number) => number,
  ][] = [
    [(x) => x >= r.minX, (ax, _ay, bx) => (r.minX - ax) / (bx - ax)],
    [(x) => x <= r.maxX, (ax, _ay, bx) => (r.maxX - ax) / (bx - ax)],
    [(_x, y) => y >= r.minY, (_ax, ay, _bx, by) => (r.minY - ay) / (by - ay)],
    [(_x, y) => y <= r.maxY, (_ax, ay, _bx, by) => (r.maxY - ay) / (by - ay)],
  ];
  for (const [inside, at] of edges) {
    const src = out;
    const n = src.length / 2;
    if (!n) break;
    out = [];
    for (let i = 0; i < n; i++) {
      const ax = src[((i + n - 1) % n) * 2];
      const ay = src[((i + n - 1) % n) * 2 + 1];
      const bx = src[i * 2];
      const by = src[i * 2 + 1];
      const ain = inside(ax, ay);
      const bin = inside(bx, by);
      if (ain !== bin) {
        const t = at(ax, ay, bx, by);
        out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
      if (bin) out.push(bx, by);
    }
  }
  return out;
}

class SegWriter {
  batches: SegmentBatch[] = [];
  private buf = new ArrayBuffer(SEG_STRIDE * 4096);
  private f32 = new Float32Array(this.buf);
  private u8 = new Uint8Array(this.buf);
  private u16 = new Uint16Array(this.buf);
  private n = 0;
  private b = [Infinity, Infinity, -Infinity, -Infinity];
  /**
   * @param clip when set, segments are cut to this rectangle (detail batches): no vertex lies far
   *   from the origin, so float32 keeps them exact enough at any zoom.
   */
  constructor(
    public ox: number,
    public oy: number,
    private clip?: Bounds,
  ) {}

  private grow() {
    const nb = new ArrayBuffer(this.buf.byteLength * 2);
    new Uint8Array(nb).set(this.u8);
    this.buf = nb;
    this.f32 = new Float32Array(nb);
    this.u8 = new Uint8Array(nb);
    this.u16 = new Uint16Array(nb);
  }

  push(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    rgba: number,
    width: number,
    dist0: number,
    layer: number,
    pattern: number,
    ltscale: number,
  ) {
    if (this.clip) {
      const t = clipSegment(x0, y0, x1, y1, this.clip);
      if (!t) return;
      const [t0, t1] = t;
      if (t0 > 0 || t1 < 1) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        dist0 += t0 * Math.hypot(dx, dy);
        x1 = x0 + dx * t1;
        y1 = y0 + dy * t1;
        x0 += dx * t0;
        y0 += dy * t0;
      }
    }
    if (this.n >= MAX_SEGMENTS_PER_BATCH) this.flush();
    if ((this.n + 1) * SEG_STRIDE > this.buf.byteLength) this.grow();
    if (x0 < this.b[0]) this.b[0] = x0;
    if (x1 < this.b[0]) this.b[0] = x1;
    if (y0 < this.b[1]) this.b[1] = y0;
    if (y1 < this.b[1]) this.b[1] = y1;
    if (x0 > this.b[2]) this.b[2] = x0;
    if (x1 > this.b[2]) this.b[2] = x1;
    if (y0 > this.b[3]) this.b[3] = y0;
    if (y1 > this.b[3]) this.b[3] = y1;
    const o = (this.n * SEG_STRIDE) >> 2;
    this.f32[o] = x0 - this.ox;
    this.f32[o + 1] = y0 - this.oy;
    this.f32[o + 2] = x1 - this.ox;
    this.f32[o + 3] = y1 - this.oy;
    const b = this.n * SEG_STRIDE + 16;
    this.u8[b] = (rgba >>> 24) & 255;
    this.u8[b + 1] = (rgba >>> 16) & 255;
    this.u8[b + 2] = (rgba >>> 8) & 255;
    this.u8[b + 3] = rgba & 255;
    this.f32[o + 5] = width;
    this.f32[o + 6] = dist0;
    const h = (this.n * SEG_STRIDE + 28) >> 1;
    this.u16[h] = layer;
    this.u16[h + 1] = pattern;
    this.f32[o + 8] = ltscale;
    this.n++;
  }

  flush() {
    if (this.n === 0) return;
    this.batches.push({
      ox: this.ox,
      oy: this.oy,
      count: this.n,
      data: this.buf.slice(0, this.n * SEG_STRIDE),
      bounds: { minX: this.b[0], minY: this.b[1], maxX: this.b[2], maxY: this.b[3] },
    });
    this.n = 0;
    this.b = [Infinity, Infinity, -Infinity, -Infinity];
  }
}

class TriWriter {
  batches: TriangleBatch[] = [];
  private buf = new ArrayBuffer(TRI_STRIDE * 4096);
  private f32 = new Float32Array(this.buf);
  private u8 = new Uint8Array(this.buf);
  private u16 = new Uint16Array(this.buf);
  private n = 0;
  private b = [Infinity, Infinity, -Infinity, -Infinity];
  /** @param clip as for SegWriter: triangles are cut to this rectangle. */
  constructor(
    public ox: number,
    public oy: number,
    private clip?: Bounds,
  ) {}

  private grow() {
    const nb = new ArrayBuffer(this.buf.byteLength * 2);
    new Uint8Array(nb).set(this.u8);
    this.buf = nb;
    this.f32 = new Float32Array(nb);
    this.u8 = new Uint8Array(nb);
    this.u16 = new Uint16Array(nb);
  }

  /** Adds whole triangles (3 vertices each). */
  pushTriangles(coords: ArrayLike<number>, idx: ArrayLike<number>, rgba: number, layer: number) {
    if (this.clip) {
      const r = this.clip;
      const kept: number[] = [];
      const keptIdx: number[] = [];
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const tri = [0, 1, 2].flatMap((j) => [coords[idx[i + j] * 2], coords[idx[i + j] * 2 + 1]]);
        const xs = [tri[0], tri[2], tri[4]];
        const ys = [tri[1], tri[3], tri[5]];
        if (Math.max(...xs) < r.minX || Math.min(...xs) > r.maxX) continue;
        if (Math.max(...ys) < r.minY || Math.min(...ys) > r.maxY) continue;
        const inside =
          Math.min(...xs) >= r.minX &&
          Math.max(...xs) <= r.maxX &&
          Math.min(...ys) >= r.minY &&
          Math.max(...ys) <= r.maxY;
        const poly = inside ? tri : clipPolygon(tri, r);
        const base = kept.length / 2;
        kept.push(...poly);
        for (let j = 1; j + 1 < poly.length / 2; j++) keptIdx.push(base, base + j, base + j + 1);
      }
      this.write(kept, keptIdx, rgba, layer);
    } else {
      this.write(coords, idx, rgba, layer);
    }
  }

  private write(coords: ArrayLike<number>, idx: ArrayLike<number>, rgba: number, layer: number) {
    if (this.n + idx.length > MAX_TRI_VERTS_PER_BATCH) this.flush();
    for (let i = 0; i < idx.length; i++) {
      if ((this.n + 1) * TRI_STRIDE > this.buf.byteLength) this.grow();
      const k = idx[i];
      const vx = coords[k * 2];
      const vy = coords[k * 2 + 1];
      if (vx < this.b[0]) this.b[0] = vx;
      if (vy < this.b[1]) this.b[1] = vy;
      if (vx > this.b[2]) this.b[2] = vx;
      if (vy > this.b[3]) this.b[3] = vy;
      const o = (this.n * TRI_STRIDE) >> 2;
      this.f32[o] = vx - this.ox;
      this.f32[o + 1] = vy - this.oy;
      const b = this.n * TRI_STRIDE + 8;
      this.u8[b] = (rgba >>> 24) & 255;
      this.u8[b + 1] = (rgba >>> 16) & 255;
      this.u8[b + 2] = (rgba >>> 8) & 255;
      this.u8[b + 3] = rgba & 255;
      this.u16[(this.n * TRI_STRIDE + 12) >> 1] = layer;
      this.n++;
    }
  }

  flush() {
    if (this.n === 0) return;
    this.batches.push({
      ox: this.ox,
      oy: this.oy,
      count: this.n,
      data: this.buf.slice(0, this.n * TRI_STRIDE),
      bounds: { minX: this.b[0], minY: this.b[1], maxX: this.b[2], maxY: this.b[3] },
    });
    this.n = 0;
    this.b = [Infinity, Infinity, -Infinity, -Infinity];
  }
}

function arcSegs(r: number, sweep: number, tol: number): number {
  if (r <= 0) return 1;
  const step = tol >= r ? Math.PI / 2 : 2 * Math.acos(1 - tol / r);
  return Math.max(2, Math.min(512, Math.ceil(Math.abs(sweep) / step)));
}

/** Appends tessellated points of a bulge polyline ring/path into `out` (flat x,y). */
function flattenBulges(
  pts: { x: number; y: number; bulge: number }[],
  closed: boolean,
  tol: number,
  out: number[],
) {
  const n = pts.length;
  if (!n) return;
  out.push(pts[0].x, pts[0].y);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const arc = a.bulge ? bulgeToArc(a, b, a.bulge) : null;
    if (arc) {
      const k = arcSegs(arc.r, arc.sweep, tol);
      for (let j = 1; j < k; j++) {
        const t = arc.a0 + (arc.sweep * j) / k;
        out.push(arc.c.x + arc.r * Math.cos(t), arc.c.y + arc.r * Math.sin(t));
      }
    }
    if (!(closed && i === segs - 1)) out.push(b.x, b.y);
  }
}

export function packRgba(rgb: number, alpha = 255): number {
  return ((rgb & 0xffffff) * 256 + alpha) >>> 0;
}

/** Tessellated fills by entity index, kept between detail builds (large fills cost the most). */
export type FillCache = Map<number, { coords: number[]; idx: number[] }>;

const scratch: number[] = [];

/** Tessellates one entity into the writers; returns the number of line segments it produced. */
function emitEntity(
  store: EntityStore,
  i: number,
  tol: number,
  diag: number,
  sw: SegWriter,
  tw: TriWriter,
  fills?: FillCache,
): number {
  const g = store.geom;
  const flat = scratch;
  let segs = 0;
  const flags = store.flags[i];
  if (flags & FLAG.HIDDEN) return 0;
  const rgba = packRgba(store.color[i]);
  const layer = store.layer[i];
  const width = lineweightPx(store.lineweight[i]);
  const pattern = store.linetype[i];
  const lts = store.ltscale[i] || 1;
  const o = store.geomStart[i];
  const polyline = (pts: number[], closed: boolean) => {
    let dist = 0;
    const n = pts.length / 2;
    for (let p = 0; p < n - 1; p++) {
      const x0 = pts[p * 2];
      const y0 = pts[p * 2 + 1];
      const x1 = pts[p * 2 + 2];
      const y1 = pts[p * 2 + 3];
      sw.push(x0, y0, x1, y1, rgba, width, dist, layer, pattern, lts);
      dist += Math.hypot(x1 - x0, y1 - y0);
      segs++;
    }
    if (closed && n > 2) {
      sw.push(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1], pts[0], pts[1], rgba, width, dist, layer, pattern, lts);
      segs++;
    }
  };
  switch (store.geomKind[i]) {
    case GK.LINE:
      sw.push(g[o], g[o + 1], g[o + 2], g[o + 3], rgba, width, 0, layer, pattern, lts);
      segs++;
      break;
    case GK.CIRCLE:
    case GK.ARC: {
      const cx = g[o];
      const cy = g[o + 1];
      const r = g[o + 2];
      const a0 = store.geomKind[i] === GK.ARC ? g[o + 3] : 0;
      let sweep = store.geomKind[i] === GK.ARC ? g[o + 4] - a0 : Math.PI * 2;
      if (sweep <= 0) sweep += Math.PI * 2;
      const n = arcSegs(r, sweep, tol);
      flat.length = 0;
      for (let j = 0; j <= n; j++) {
        const t = a0 + (sweep * j) / n;
        flat.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
      }
      polyline(flat, false);
      break;
    }
    case GK.ELLIPSE: {
      const cx = g[o];
      const cy = g[o + 1];
      const mx = g[o + 2];
      const my = g[o + 3];
      const ratio = g[o + 4];
      const t0 = g[o + 5];
      let sweep = g[o + 6] - t0;
      if (sweep <= 0) sweep += Math.PI * 2;
      const major = Math.hypot(mx, my);
      const n = arcSegs(major, sweep, tol) * 2;
      const vx = -my * ratio;
      const vy = mx * ratio;
      flat.length = 0;
      for (let j = 0; j <= n; j++) {
        const t = t0 + (sweep * j) / n;
        flat.push(cx + mx * Math.cos(t) + vx * Math.sin(t), cy + my * Math.cos(t) + vy * Math.sin(t));
      }
      polyline(flat, false);
      break;
    }
    case GK.POLY: {
      const n = g[o];
      const pts = new Array(n);
      for (let p = 0; p < n; p++)
        pts[p] = { x: g[o + 1 + p * 3], y: g[o + 2 + p * 3], bulge: g[o + 3 + p * 3] };
      flat.length = 0;
      const closed = (flags & FLAG.CLOSED) !== 0;
      flattenBulges(pts, closed, tol, flat);
      polyline(flat, closed);
      break;
    }
    case GK.POINT: {
      // Small cross so points are visible (4 px is applied as a width-less mark in drawing units).
      const x = g[o];
      const y = g[o + 1];
      const d = diag * 1e-4;
      sw.push(x - d, y, x + d, y, rgba, 0, 0, layer, 0, 1);
      sw.push(x, y - d, x, y + d, rgba, 0, 0, layer, 0, 1);
      segs += 2;
      break;
    }
    case GK.FILL: {
      const rings = readRings(store, i);
      if (flags & FLAG.PATTERN) {
        // Pattern hatch: draw the boundary; the pattern lines are separate DERIVED entities.
        for (const ring of rings) {
          flat.length = 0;
          flattenBulges(ring, true, tol, flat);
          polyline(flat, true);
        }
      } else {
        let t = fills?.get(i);
        if (!t) {
          const coords: number[] = [];
          const holes: number[] = [];
          for (let r = 0; r < rings.length; r++) {
            if (r > 0) holes.push(coords.length / 2);
            flattenBulges(rings[r], true, tol, coords);
          }
          t = { coords, idx: coords.length >= 6 ? earcut(coords, holes.length ? holes : undefined, 2) : [] };
          fills?.set(i, t);
        }
        if (t.idx.length) tw.pushTriangles(t.coords, t.idx, rgba, layer);
      }
      break;
    }
    case GK.TEXT:
      // Text is drawn by the 2D overlay (see textIndex).
      break;
  }
  return segs;
}

/** Drawing diagonal and curve chord tolerance, shared by full and detail builds so curves match. */
function tessellation(extents: Bounds, opts: RenderOptions) {
  const diag = Math.hypot(extents.maxX - extents.minX, extents.maxY - extents.minY) || 1;
  return { diag, tol: diag * (opts.relChordTol ?? 2e-6) };
}

/** Builds render data for every visible entity of the store. Pure; safe to run in a worker. */
export function buildRenderData(store: EntityStore, extents: Bounds, opts: RenderOptions = {}): RenderData {
  const { diag, tol } = tessellation(extents, opts);
  const grid = opts.grid ?? 16;
  const gw = (extents.maxX - extents.minX) / grid || 1;
  const gh = (extents.maxY - extents.minY) / grid || 1;
  const cellOf = (i: number) => {
    const cx = (store.bbox[i * 4] + store.bbox[i * 4 + 2]) / 2;
    const cy = (store.bbox[i * 4 + 1] + store.bbox[i * 4 + 3]) / 2;
    const gx = Math.min(grid - 1, Math.max(0, Math.floor((cx - extents.minX) / gw)));
    const gy = Math.min(grid - 1, Math.max(0, Math.floor((cy - extents.minY) / gh)));
    return gy * grid + gx;
  };
  // Bucket entity indices by grid cell, preserving entity order within a cell.
  const counts = new Uint32Array(grid * grid);
  const cells = new Uint32Array(store.count);
  for (let i = 0; i < store.count; i++) {
    const c = cellOf(i);
    cells[i] = c;
    counts[c]++;
  }
  const starts = new Uint32Array(grid * grid + 1);
  for (let c = 0; c < grid * grid; c++) starts[c + 1] = starts[c] + counts[c];
  const order = new Uint32Array(store.count);
  const fill = starts.slice(0, grid * grid);
  for (let i = 0; i < store.count; i++) order[fill[cells[i]]++] = i;

  const segments: SegmentBatch[] = [];
  const triangles: TriangleBatch[] = [];
  let segmentCount = 0;

  for (let c = 0; c < grid * grid; c++) {
    if (opts.indexOnly) break;
    if (starts[c] === starts[c + 1]) continue;
    const ox = extents.minX + ((c % grid) + 0.5) * gw;
    const oy = extents.minY + (Math.floor(c / grid) + 0.5) * gh;
    const sw = new SegWriter(ox, oy);
    const tw = new TriWriter(ox, oy);
    for (let k = starts[c]; k < starts[c + 1]; k++)
      segmentCount += emitEntity(store, order[k], tol, diag, sw, tw);
    sw.flush();
    tw.flush();
    segments.push(...sw.batches);
    triangles.push(...tw.batches);
  }

  // Linetype patterns.
  const patterns = new Float32Array(Math.max(1, store.linetypes.length) * 16);
  store.linetypes.forEach((lt, p) => {
    const els = lt.pattern.slice(0, MAX_PATTERN_ELEMENTS);
    patterns[p * 16] = els.length;
    patterns[p * 16 + 1] = els.reduce((s, e) => s + Math.abs(e), 0);
    els.forEach((e, k) => (patterns[p * 16 + 2 + k] = e));
  });

  // Spatial indices.
  let index: ArrayBuffer | null = null;
  let textIndex: ArrayBuffer | null = null;
  const textList: number[] = [];
  if (store.count > 0) {
    const fb = new Flatbush(store.count);
    for (let i = 0; i < store.count; i++) {
      fb.add(store.bbox[i * 4], store.bbox[i * 4 + 1], store.bbox[i * 4 + 2], store.bbox[i * 4 + 3]);
      if (store.geomKind[i] === GK.TEXT && !(store.flags[i] & FLAG.HIDDEN)) textList.push(i);
    }
    fb.finish();
    index = fb.data as ArrayBuffer;
  }
  if (textList.length > 0) {
    const tb = new Flatbush(textList.length);
    for (const i of textList)
      tb.add(store.bbox[i * 4], store.bbox[i * 4 + 1], store.bbox[i * 4 + 2], store.bbox[i * 4 + 3]);
    tb.finish();
    textIndex = tb.data as ArrayBuffer;
  }
  return {
    segments,
    triangles,
    patterns,
    index,
    textIndex,
    textIds: Uint32Array.from(textList),
    extents,
    segmentCount,
  };
}

/**
 * Detail batches for the entities `ids`, cut to `rect` and stored relative to its centre (row 18).
 * Drawn instead of the full batches when the view is zoomed in so far that their float32 offsets
 * would show (see `precisionRadius`); tessellated exactly as `buildRenderData` with the same
 * `extents` and options, so curves look the same in both. `fills` keeps fill triangulations between
 * builds.
 */
export function buildDetailData(
  store: EntityStore,
  extents: Bounds,
  ids: ArrayLike<number>,
  rect: Bounds,
  opts: RenderOptions = {},
  fills?: FillCache,
): Pick<RenderData, 'segments' | 'triangles' | 'segmentCount'> {
  const { diag, tol } = tessellation(extents, opts);
  const ox = (rect.minX + rect.maxX) / 2;
  const oy = (rect.minY + rect.maxY) / 2;
  const sw = new SegWriter(ox, oy, rect);
  const tw = new TriWriter(ox, oy, rect);
  let segmentCount = 0;
  // In file order, as within the cells of the full build.
  for (const i of Uint32Array.from(ids).sort())
    segmentCount += emitEntity(store, i, tol, diag, sw, tw, fills);
  sw.flush();
  tw.flush();
  return { segments: sw.batches, triangles: tw.batches, segmentCount };
}

/**
 * The farthest any vertex of the full batches lies from its batch origin (drawing units). float32
 * keeps 24 bits, so a vertex can be off by up to this × 2⁻²⁴, and the GPU's sums with the same
 * magnitudes add similar errors: the renderer switches to detail batches before that shows.
 */
export function precisionRadius(r: Pick<RenderData, 'segments' | 'triangles'>): number {
  let radius = 0;
  for (const b of [...r.segments, ...r.triangles]) {
    if (!b.bounds || !Number.isFinite(b.bounds.minX)) continue;
    const dx = Math.max(Math.abs(b.bounds.minX - b.ox), Math.abs(b.bounds.maxX - b.ox));
    const dy = Math.max(Math.abs(b.bounds.minY - b.oy), Math.abs(b.bounds.maxY - b.oy));
    radius = Math.max(radius, Math.hypot(dx, dy));
  }
  return radius;
}

export function renderDataTransferables(r: RenderData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const b of r.segments) out.push(b.data);
  for (const b of r.triangles) out.push(b.data);
  out.push(r.patterns.buffer as ArrayBuffer, r.textIds.buffer as ArrayBuffer);
  if (r.index) out.push(r.index);
  if (r.textIndex) out.push(r.textIndex);
  return out;
}
