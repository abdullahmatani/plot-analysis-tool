import { apply, applyVec, isSimilarity } from '@/core/affine';
import type { Affine2D, Geometry, Pt, Vertex } from '@/core/types';
import { arcSegments } from '@/geometry/bulge';
import {
  arcEnd,
  arcStart,
  arcSweep,
  ellipsePoint,
  ellipseSweep,
  isFullEllipse,
  primsFromStoreEntity,
  type Prim,
} from '@/geometry/prims';
import { findBoundary, type BoundaryOptions, type BoundaryResult } from '@/tracing/boundary';
import { GK, type EntityStore } from '@/underlay/entity-store';

/**
 * Boundary pick (row 52), the part shared by the main thread and `workers/boundary.worker.ts`.
 *
 * The main thread packs the geometry of the traceable entities of every visible vector drawing
 * (visible layers only; derived hatch lines, text and points excluded) into compact typed arrays
 * that are transferred to the worker. The worker rebuilds primitives, maps them to world metres
 * with each drawing's placement (exactly for similarity placements; under a general affine
 * placement curves are tessellated within the chord tolerance) and runs `findBoundary`.
 */

export interface PackedDrawing {
  placement: Affine2D;
  kinds: Uint8Array;
  flags: Uint8Array;
  starts: Uint32Array;
  geom: Float64Array;
}

export interface BoundaryRequest {
  id: number;
  pick: Pt;
  drawings: PackedDrawing[];
  opts: BoundaryOptions;
}

export type BoundaryResponse =
  | { id: number; ok: true; result: BoundaryResult | null; prims: number }
  | { id: number; ok: false; error: string };

/** Copies the geometry of the given entities of a store (the worker needs nothing else). */
export function packEntities(
  store: EntityStore,
  indices: ArrayLike<number>,
  placement: Affine2D,
): PackedDrawing {
  const n = indices.length;
  let total = 0;
  for (let k = 0; k < n; k++) total += store.geomLen[indices[k]];
  const kinds = new Uint8Array(n);
  const flags = new Uint8Array(n);
  const starts = new Uint32Array(n);
  const geom = new Float64Array(total);
  let o = 0;
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    kinds[k] = store.geomKind[i];
    flags[k] = store.flags[i];
    starts[k] = o;
    const s = store.geomStart[i];
    const len = store.geomLen[i];
    geom.set(store.geom.subarray(s, s + len), o);
    o += len;
  }
  return { placement: [...placement] as Affine2D, kinds, flags, starts, geom };
}

export function packedTransferables(d: PackedDrawing): ArrayBuffer[] {
  return [d.kinds.buffer, d.flags.buffer, d.starts.buffer, d.geom.buffer] as ArrayBuffer[];
}

const isIdentity = (m: Affine2D) =>
  m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

/** Maps a primitive with an affine transform: exact for similarities (incl. mirror), else curves are tessellated. */
export function transformPrim(p: Prim, m: Affine2D, chordTol: number, out: Prim[]): void {
  const f = (q: Pt) => apply(m, q);
  if (p.k === 'seg') {
    out.push({ k: 'seg', a: f(p.a), b: f(p.b) });
    return;
  }
  if (p.k === 'point') {
    out.push({ k: 'point', p: f(p.p) });
    return;
  }
  const det = m[0] * m[3] - m[1] * m[2];
  const k = Math.sqrt(Math.abs(det));
  const mirrored = det < 0;
  const dirAngle = (a: number) => {
    const v = applyVec(m, { x: Math.cos(a), y: Math.sin(a) });
    return Math.atan2(v.y, v.x);
  };
  if (isSimilarity(m)) {
    if (p.k === 'circle') {
      out.push({ k: 'circle', c: f(p.c), r: p.r * k });
      return;
    }
    if (p.k === 'arc') {
      const sweep = arcSweep(p);
      const a0 = dirAngle(mirrored ? p.a1 : p.a0);
      const arc: Prim = { k: 'arc', c: f(p.c), r: p.r * k, a0, a1: a0 + sweep };
      const s0 = p.p0 ? f(p.p0) : undefined;
      const s1 = p.p1 ? f(p.p1) : undefined;
      if (s0 && s1) {
        arc.p0 = mirrored ? s1 : s0;
        arc.p1 = mirrored ? s0 : s1;
      }
      if (p.rev !== undefined || mirrored) {
        const rev = !!p.rev !== mirrored;
        if (rev) arc.rev = true;
      }
      out.push(arc);
      return;
    }
    // Ellipse: E'(t) = c' + M·major cos t + M·minor sin t; a mirror reverses the parameter.
    const major = applyVec(m, p.major);
    if (!mirrored) out.push({ k: 'ellipse', c: f(p.c), major, ratio: p.ratio, t0: p.t0, t1: p.t1 });
    else out.push({ k: 'ellipse', c: f(p.c), major, ratio: p.ratio, t0: -p.t1, t1: -p.t0 });
    return;
  }
  // General affine placement: tessellate curves in drawing units within chordTol / σmax.
  const sigma = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]), 1e-300) * Math.SQRT2;
  const tol = chordTol / sigma;
  const pts: Pt[] = [];
  if (p.k === 'circle' || p.k === 'arc') {
    const a0 = p.k === 'arc' ? p.a0 : 0;
    const sweep = p.k === 'arc' ? arcSweep(p) : Math.PI * 2;
    const n = Math.max(p.k === 'circle' ? 8 : 1, arcSegments(p.r, sweep, tol, 8192));
    for (let i = 0; i <= n; i++) {
      if (p.k === 'arc' && i === 0) pts.push(arcStart(p));
      else if (p.k === 'arc' && i === n) pts.push(arcEnd(p));
      else {
        const a = a0 + (sweep * i) / n;
        pts.push({ x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) });
      }
    }
    if (p.k === 'circle') pts[n] = pts[0];
  } else {
    const sweep = ellipseSweep(p);
    const rMax = Math.hypot(p.major.x, p.major.y) * Math.max(1, p.ratio);
    const n = Math.max(isFullEllipse(p) ? 8 : 1, arcSegments(rMax, sweep, tol, 8192));
    for (let i = 0; i <= n; i++) pts.push(ellipsePoint(p, p.t0 + (sweep * i) / n));
    if (isFullEllipse(p)) pts[n] = pts[0];
  }
  for (let i = 0; i + 1 < pts.length; i++) out.push({ k: 'seg', a: f(pts[i]), b: f(pts[i + 1]) });
}

/** World primitives of a packed drawing. */
export function primsOfPacked(d: PackedDrawing, chordTol: number): Prim[] {
  const n = d.kinds.length;
  const store = {
    geom: d.geom,
    geomStart: d.starts,
    geomKind: d.kinds,
    flags: d.flags,
  } as unknown as EntityStore;
  const ident = isIdentity(d.placement);
  const out: Prim[] = [];
  for (let k = 0; k < n; k++) {
    const kind = d.kinds[k];
    if (kind === GK.TEXT || kind === GK.POINT) continue;
    for (const p of primsFromStoreEntity(store, k)) {
      if (p.k === 'point') continue;
      if (ident) out.push(p);
      else transformPrim(p, d.placement, chordTol, out);
    }
  }
  return out;
}

/** Worker entry: world primitives of every packed drawing → boundary around the pick. */
export function solveBoundary(req: Omit<BoundaryRequest, 'id'>): {
  result: BoundaryResult | null;
  prims: number;
} {
  const prims: Prim[] = [];
  for (const d of req.drawings) for (const p of primsOfPacked(d, req.opts.chordTol)) prims.push(p);
  return { result: findBoundary(prims, req.pick, req.opts), prims: prims.length };
}

/** Boundary result as analysis geometry: closed polyline, or multipolygon with the islands as holes. */
export function boundaryGeometry(r: BoundaryResult): Geometry {
  const copy = (v: Vertex): Vertex => (v.bulge ? { x: v.x, y: v.y, bulge: v.bulge } : { x: v.x, y: v.y });
  if (!r.holes.length) return { type: 'polyline', pts: r.outer.map(copy), closed: true };
  return { type: 'multipolygon', rings: [r.outer.map(copy), ...r.holes.map((h) => h.map(copy))] };
}
