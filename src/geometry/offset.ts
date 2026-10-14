import { ClipperOffset, EndType, JoinType, PolyTree64 } from '@countertype/clipper2-ts';

import type { Geometry, Pt, Vertex } from '@/core/types';

import {
  countRings,
  createFrame,
  normalizePaths,
  polyTreeToPolygons,
  polygonsToGeometry,
  toPaths64,
  type ClipFillRule,
  type ClipperFrame,
} from './clipper';
import { cloneGeometry, tessellateEllipse, toRings } from './convert';

/**
 * Offsets (FDR rows 55–61). Positive distances expand, negative distances contract.
 *
 * - Circles and arcs are offset analytically (concentric r ± d, arcs keep a0/a1).
 * - Rectangles (rotated too) are offset analytically: round join = exact Minkowski sum with a disc
 *   (4 straight edges + 4 quarter-circle bulges, bulge = tan(π/8)); miter = rectangle grown by d (falls back
 *   to square when miterLimit ≤ √2, as Clipper does); bevel = Clipper bevel (octagon whose corner cuts join
 *   the ends of the offset edges, i.e. the points at distance d from the source corner along the edge
 *   normals); square = Clipper square join (cut perpendicular to the corner bisector at distance d from the
 *   source corner). Contraction shrinks each side by |d| for any join.
 * - Everything else goes through Clipper2 (`ClipperOffset`) in a local integer frame (see clipper.ts) with
 *   arcTolerance = chordTol; bulges and ellipses are tessellated within chordTol first.
 */

export type OffsetJoin = 'round' | 'miter' | 'square' | 'bevel';
export type OffsetCap = 'round' | 'butt' | 'square';

export interface OffsetOptions {
  join: OffsetJoin;
  /** End caps for open polylines (default round). */
  cap?: OffsetCap;
  /** Miter limit in multiples of |d| (default 2, Clipper semantics). */
  miterLimit?: number;
  /** Arc tessellation chord tolerance and Clipper arcTolerance, metres (FDR default 5 mm). */
  chordTol: number;
}

export interface OffsetResult {
  geometry: Geometry | null;
  warning?: string;
}

export const OFFSET_MESSAGES = {
  circleCollapse: 'Contraction removes the circle (r ≤ 0)',
  arcCollapse: 'Contraction removes the arc (r ≤ 0)',
  rectCollapse: 'Contraction removes the rectangle (width or height ≤ 0)',
  collapse: 'Contraction collapses the shape',
  openNegative: 'An open polyline cannot be contracted; use a positive distance for a corridor',
  pointNegative: 'A point cannot be contracted',
  noArea: 'The shape has no area to offset',
  partialCollapse: (kept: number, total: number): string =>
    `Contraction partially collapses the shape (${kept} of ${total} rings remain)`,
} as const;

const JOIN: Record<OffsetJoin, JoinType> = {
  round: JoinType.Round,
  miter: JoinType.Miter,
  square: JoinType.Square,
  bevel: JoinType.Bevel,
};

const CAP: Record<OffsetCap, EndType> = {
  round: EndType.Round,
  butt: EndType.Butt,
  square: EndType.Square,
};

const DEFAULT_MITER_LIMIT = 2;
const TAN_PI_8 = Math.tan(Math.PI / 8);

/** Offsets any geometry by d (see module notes). Never throws for valid input; failures carry a warning. */
export function offsetGeometry(g: Geometry, d: number, opts: OffsetOptions): OffsetResult {
  if (!Number.isFinite(d)) throw new Error('Offset distance must be finite');
  if (!(opts.chordTol > 0)) throw new Error('Chord tolerance must be positive');
  if (d === 0) return { geometry: cloneGeometry(g) };
  switch (g.type) {
    case 'point':
      if (d < 0) return { geometry: null, warning: OFFSET_MESSAGES.pointNegative };
      return { geometry: { type: 'circle', c: { x: g.p.x, y: g.p.y }, r: d } };
    case 'circle': {
      const r = Math.abs(g.r) + d;
      if (r <= 0) return { geometry: null, warning: OFFSET_MESSAGES.circleCollapse };
      return { geometry: { type: 'circle', c: { x: g.c.x, y: g.c.y }, r } };
    }
    case 'arc': {
      const r = Math.abs(g.r) + d;
      if (r <= 0) return { geometry: null, warning: OFFSET_MESSAGES.arcCollapse };
      return { geometry: { type: 'arc', c: { x: g.c.x, y: g.c.y }, r, a0: g.a0, a1: g.a1 } };
    }
    case 'rect':
      return offsetRect(g, d, opts);
    case 'ellipse':
      return offsetClosedRings(
        [tessellateEllipse(g.c, g.rx, g.ry, g.rot, opts.chordTol)],
        'nonzero',
        d,
        opts,
      );
    case 'polyline':
      if (!g.closed) {
        if (d < 0) return { geometry: null, warning: OFFSET_MESSAGES.openNegative };
        return offsetOpenPaths(toRings(g, opts.chordTol), d, opts);
      }
      return offsetClosedRings(toRings(g, opts.chordTol), 'nonzero', d, opts);
    case 'multipolygon':
      return offsetClosedRings(toRings(g, opts.chordTol), 'evenodd', d, opts);
  }
}

/** Offsets one source at several distances (multi-ring, row 58); results keep the order of `distances`. */
export function multiRingOffsets(
  g: Geometry,
  distances: readonly number[],
  opts: OffsetOptions,
): OffsetResult[] {
  return distances.map((d) => offsetGeometry(g, d, opts));
}

/** Distances for a fixed interval: start, start + interval, … (count values). */
export function intervalDistances(interval: number, count: number, start = interval): number[] {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => start + i * interval);
}

type Rect = Extract<Geometry, { type: 'rect' }>;

function offsetRect(g: Rect, d: number, opts: OffsetOptions): OffsetResult {
  const w = Math.abs(g.w);
  const h = Math.abs(g.h);
  if (d < 0) {
    const w2 = w + 2 * d;
    const h2 = h + 2 * d;
    if (w2 <= 0 || h2 <= 0) return { geometry: null, warning: OFFSET_MESSAGES.rectCollapse };
    return { geometry: { type: 'rect', c: { x: g.c.x, y: g.c.y }, w: w2, h: h2, rot: g.rot } };
  }
  const miterLimit = opts.miterLimit ?? DEFAULT_MITER_LIMIT;
  let join = opts.join;
  if (join === 'miter') {
    if (miterLimit > Math.SQRT2) {
      return {
        geometry: { type: 'rect', c: { x: g.c.x, y: g.c.y }, w: w + 2 * d, h: h + 2 * d, rot: g.rot },
      };
    }
    join = 'square'; // Clipper squares corners whose miter would exceed the limit (90° needs > √2)
  }
  const hw = w / 2;
  const hh = h / 2;
  // Square join: corner cut at distance d along the bisector → the cut meets the grown sides d·tan(π/8)
  // beyond the source corner. Round and bevel joins start/end at the offset edge ends (e = 0).
  const e = join === 'square' ? d * TAN_PI_8 : 0;
  const b = join === 'round' ? TAN_PI_8 : 0;
  const local: [number, number, number][] = [
    [hw + d, -hh - e, 0],
    [hw + d, hh + e, b],
    [hw + e, hh + d, 0],
    [-hw - e, hh + d, b],
    [-hw - d, hh + e, 0],
    [-hw - d, -hh - e, b],
    [-hw - e, -hh - d, 0],
    [hw + e, -hh - d, b],
  ];
  const c = Math.cos(g.rot);
  const s = Math.sin(g.rot);
  const pts: Vertex[] = [];
  for (const [x, y, bulge] of local) {
    const v: Vertex = { x: g.c.x + x * c - y * s, y: g.c.y + x * s + y * c };
    if (bulge) v.bulge = bulge;
    pts.push(v);
  }
  // Degenerate rectangles (w or h = 0) produce zero-length straight edges: drop their start vertices.
  const tol = 1e-12 * Math.max(1, w, h, d);
  const clean = pts.filter((v, i) => {
    const nx = pts[(i + 1) % pts.length];
    return v.bulge || Math.hypot(nx.x - v.x, nx.y - v.y) > tol;
  });
  return { geometry: { type: 'polyline', pts: clean, closed: true } };
}

function arcTolerance(frame: ClipperFrame, d: number, chordTol: number): number {
  // Clipper's step formula needs arcTol ≤ |delta| (acos(1 − tol/|δ|) is undefined beyond 2|δ|).
  return Math.max(0.02, Math.min(chordTol, Math.abs(d)) * frame.scale);
}

function offsetClosedRings(rings: Pt[][], rule: ClipFillRule, d: number, opts: OffsetOptions): OffsetResult {
  const miterLimit = opts.miterLimit ?? DEFAULT_MITER_LIMIT;
  const reach = d > 0 ? d * Math.max(miterLimit, 2) + opts.chordTol : 0;
  const frame = createFrame(rings, reach);
  const src = normalizePaths(toPaths64(rings, frame), rule);
  if (src.length === 0) return { geometry: null, warning: OFFSET_MESSAGES.noArea };
  const co = new ClipperOffset(miterLimit, arcTolerance(frame, d, opts.chordTol));
  co.addPaths(src, JOIN[opts.join], EndType.Polygon);
  const tree = new PolyTree64();
  co.execute(d * frame.scale, tree);
  const polys = polyTreeToPolygons(tree, frame);
  if (polys.length === 0) return { geometry: null, warning: OFFSET_MESSAGES.collapse };
  const result: OffsetResult = { geometry: polygonsToGeometry(polys) };
  const kept = countRings(polys);
  if (d < 0 && kept < src.length) result.warning = OFFSET_MESSAGES.partialCollapse(kept, src.length);
  return result;
}

function offsetOpenPaths(paths: Pt[][], d: number, opts: OffsetOptions): OffsetResult {
  const miterLimit = opts.miterLimit ?? DEFAULT_MITER_LIMIT;
  const frame = createFrame(paths, d * Math.max(miterLimit, 2) + opts.chordTol);
  const co = new ClipperOffset(miterLimit, arcTolerance(frame, d, opts.chordTol));
  co.addPaths(toPaths64(paths, frame), JOIN[opts.join], CAP[opts.cap ?? 'round']);
  const tree = new PolyTree64();
  co.execute(d * frame.scale, tree);
  const polys = polyTreeToPolygons(tree, frame);
  if (polys.length === 0) return { geometry: null, warning: OFFSET_MESSAGES.noArea };
  return { geometry: polygonsToGeometry(polys) };
}
