import type Flatbush from 'flatbush';

import { apply, invert } from '@/core/affine';
import type { Affine2D, Drawing, Geometry, Project, Pt, Vertex } from '@/core/types';
import { arcSegments } from '@/geometry/bulge';
import { transformGeometry } from '@/geometry/convert';
import { nearestOnPrim } from '@/geometry/nearest';
import { ellipsePoint, ellipseSweep, primsFromStoreEntity, type Prim } from '@/geometry/prims';
import { ChainTracer } from '@/tracing/chain';
import { FLAG, GK, type EntityStore } from '@/underlay/entity-store';
import { entityToGeometry } from '@/underlay/entity-geometry';
import { getModel } from '@/underlay/models';
import { drawingPlacement, pickUnderlay, visibleLayerFlags } from '@/underlay/pick';

/**
 * Access to vector underlay geometry for the trace tools (rows 50–52). Entity geometry is read in
 * drawing units (exact stored numbers) and mapped to world metres with the drawing's placement;
 * similarity placements map circles, arcs and bulges exactly (`transformGeometry`).
 */

export interface VectorSource {
  drawing: Drawing;
  store: EntityStore;
  index: Flatbush;
  placement: Affine2D;
  inverse: Affine2D;
  /** Metres per drawing unit (√|det| of the placement). */
  unit: number;
  layerVisible: Uint8Array;
}

/** Visible drawings with parsed vector entities, top-most first. */
export function vectorSources(project: Project): VectorSource[] {
  const out: VectorSource[] = [];
  for (const d of [...project.drawings].filter((x) => x.visible).sort((a, b) => b.order - a.order)) {
    const m = getModel(d.id);
    const store = m?.result?.store;
    if (!m || m.status !== 'ready' || !store || !m.index) continue;
    const placement = drawingPlacement(d);
    let inverse: Affine2D;
    try {
      inverse = invert(placement);
    } catch {
      continue;
    }
    const unit = Math.sqrt(Math.abs(placement[0] * placement[3] - placement[1] * placement[2]));
    out.push({
      drawing: d,
      store,
      index: m.index,
      placement,
      inverse,
      unit,
      layerVisible: visibleLayerFlags(d),
    });
  }
  return out;
}

export function sourceOf(project: Project, drawingId: string): VectorSource | null {
  return vectorSources(project).find((s) => s.drawing.id === drawingId) ?? null;
}

/** Entities that take part in tracing: visible, not derived hatch lines, not text or points. */
export function entityTraceable(s: VectorSource, i: number): boolean {
  const st = s.store;
  if (st.flags[i] & (FLAG.HIDDEN | FLAG.DERIVED)) return false;
  if (!s.layerVisible[st.layer[i]]) return false;
  const k = st.geomKind[i];
  return k !== GK.TEXT && k !== GK.POINT;
}

/** The traceable entity under a world point (nearest, top-most drawing first). */
export function pickTraceable(
  project: Project,
  world: Pt,
  scale: number,
  tolPx = 7,
): { source: VectorSource; index: number } | null {
  const sources = vectorSources(project);
  for (const h of pickUnderlay(project.drawings, world, scale, tolPx)) {
    const source = sources.find((s) => s.drawing.id === h.drawingId);
    if (source && entityTraceable(source, h.index)) return { source, index: h.index };
  }
  return null;
}

/**
 * Exact analysis geometry of an underlay entity in world metres. Partial ellipses (the only curves
 * without an exact analytic form here) are tessellated within `chordTol` (world metres).
 */
export function entityWorldGeometry(s: VectorSource, i: number, chordTol: number): Geometry | null {
  const st = s.store;
  let g: Geometry | null;
  if (st.geomKind[i] === GK.ELLIPSE) g = ellipseGeometry(st, i, chordTol / (s.unit || 1));
  else g = entityToGeometry(st, i);
  if (!g) return null;
  return transformGeometry(g, s.placement, chordTol);
}

function ellipseGeometry(st: EntityStore, i: number, chordTol: number): Geometry {
  const o = st.geomStart[i];
  const v = st.geom;
  const e = {
    k: 'ellipse' as const,
    c: { x: v[o], y: v[o + 1] },
    major: { x: v[o + 2], y: v[o + 3] },
    ratio: v[o + 4],
    t0: v[o + 5],
    t1: v[o + 6],
  };
  const sweep = ellipseSweep(e);
  const rx = Math.hypot(e.major.x, e.major.y);
  if (sweep >= Math.PI * 2 - 1e-12)
    return { type: 'ellipse', c: e.c, rx, ry: rx * e.ratio, rot: Math.atan2(e.major.y, e.major.x) };
  // Parameter steps sized for a circle of the major radius keep every chord within chordTol.
  const n = Math.max(4, arcSegments(rx * Math.max(1, e.ratio), sweep, chordTol, 8192));
  const pts: Vertex[] = [];
  for (let k = 0; k <= n; k++) pts.push(ellipsePoint(e, e.t0 + (sweep * k) / n));
  return { type: 'polyline', pts, closed: false };
}

// ------------------------------------------------------------------------------- chain tracing

export interface ChainModel {
  key: string;
  source: VectorSource;
  prims: Prim[];
  /** First primitive of each entity (−1 when it has none) and the number of primitives. */
  first: Int32Array;
  count: Int32Array;
  tracer: ChainTracer;
}

const chainCache = new Map<string, ChainModel>();

/**
 * Chain tracer over the traceable entities of one drawing (optionally a subset, e.g. one block
 * reference), in drawing units. Cached per drawing version, hidden layers and tolerances.
 */
export function chainModel(
  s: VectorSource,
  gapTol: number,
  chordTol: number,
  subset?: { key: string; filter: (i: number) => boolean },
): ChainModel {
  const m = getModel(s.drawing.id);
  const key = [
    s.drawing.id,
    m?.version ?? 0,
    s.drawing.hiddenSourceLayers.join('\u0000'),
    gapTol,
    chordTol,
    s.unit,
    subset?.key ?? '',
  ].join('|');
  const hit = chainCache.get(key);
  if (hit) return hit;
  const st = s.store;
  const prims: Prim[] = [];
  const first = new Int32Array(st.count).fill(-1);
  const count = new Int32Array(st.count);
  for (let i = 0; i < st.count; i++) {
    if (!entityTraceable(s, i) || (subset && !subset.filter(i))) continue;
    const ps = primsFromStoreEntity(st, i).filter((p) => p.k !== 'point');
    if (!ps.length) continue;
    first[i] = prims.length;
    count[i] = ps.length;
    for (const p of ps) prims.push(p);
  }
  const unit = s.unit || 1;
  const tracer = new ChainTracer(prims, { gapTol: gapTol / unit, chordTol: chordTol / unit });
  const model: ChainModel = { key, source: s, prims, first, count, tracer };
  if (chainCache.size > 3) chainCache.delete(chainCache.keys().next().value!);
  chainCache.set(key, model);
  return model;
}

/** Primitive of entity `i` nearest to a world point (null when the entity has none). */
export function nearestPrimOf(model: ChainModel, i: number, world: Pt): { prim: number; local: Pt } | null {
  const f = model.first[i];
  if (f < 0) return null;
  const local = apply(model.source.inverse, world);
  let best = f;
  let bestD = Infinity;
  for (let k = f; k < f + model.count[i]; k++) {
    const d = nearestOnPrim(local, model.prims[k]).dist;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return { prim: best, local };
}

/** A traced chain (drawing units) as world geometry. */
export function chainWorldGeometry(
  s: VectorSource,
  pts: Vertex[],
  closed: boolean,
  chordTol: number,
): Geometry | null {
  if (pts.length < 2) return null;
  return transformGeometry({ type: 'polyline', pts, closed }, s.placement, chordTol);
}
