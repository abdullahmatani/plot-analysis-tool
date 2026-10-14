import type { Bounds, Geometry, Pt, Vertex } from '@/core/types';
import { FLAG, GK, type EntityStore } from '@/underlay/entity-store';
import { bulgeToArc } from './bulge';
import { TAU, ccwSweep, normAngle } from './vec';

/**
 * Geometric primitives used by snapping, picking, chain tracing and boundary detection.
 *
 * Every primitive keeps the source numbers untouched: segment endpoints, centres and (for arcs
 * that came from polyline bulges) the arc endpoints are the exact stored coordinates, so snaps to
 * them reproduce source coordinates exactly (FDR row 27).
 *
 * Arcs always run counter-clockwise from `a0` to `a1`. An arc built from a clockwise bulge has its
 * endpoints swapped and `rev: true`, so the original traversal direction can be recovered.
 *
 * Ellipses use the DXF parametrisation E(t) = c + major·cos t + minor·sin t with
 * minor = ratio · perp(major) (major rotated +90°), running counter-clockwise from t0 to t1.
 */
export type Prim =
  | { k: 'seg'; a: Pt; b: Pt }
  | {
      k: 'arc';
      c: Pt;
      r: number;
      /** CCW from a0 to a1 (radians). */
      a0: number;
      a1: number;
      /** Exact stored start point (at a0) when the arc came from a polyline bulge. */
      p0?: Pt;
      /** Exact stored end point (at a1) when the arc came from a polyline bulge. */
      p1?: Pt;
      /** True when the source traversed this arc clockwise (from p1 to p0). */
      rev?: boolean;
    }
  | { k: 'circle'; c: Pt; r: number }
  | { k: 'ellipse'; c: Pt; major: Pt; ratio: number; t0: number; t1: number }
  | { k: 'point'; p: Pt };

export type PrimKind = Prim['k'];
export type SegPrim = Extract<Prim, { k: 'seg' }>;
export type ArcPrim = Extract<Prim, { k: 'arc' }>;
export type CirclePrim = Extract<Prim, { k: 'circle' }>;
export type EllipsePrim = Extract<Prim, { k: 'ellipse' }>;
export type PointPrim = Extract<Prim, { k: 'point' }>;

const copy = (p: Pt): Pt => ({ x: p.x, y: p.y });

/** CCW sweep of an arc in (0, 2π]. */
export function arcSweep(p: { a0: number; a1: number }): number {
  return ccwSweep(p.a0, p.a1);
}

/** CCW parameter sweep of an ellipse (2π for a full ellipse). */
export function ellipseSweep(p: EllipsePrim): number {
  const raw = p.t1 - p.t0;
  if (Math.abs(raw - TAU) < 1e-12 || Math.abs(raw + TAU) < 1e-12) return TAU;
  return ccwSweep(p.t0, p.t1);
}

export function isFullEllipse(p: EllipsePrim): boolean {
  return ellipseSweep(p) >= TAU - 1e-12;
}

/** Minor semi-axis vector (major rotated +90° and scaled by ratio). */
export function ellipseMinor(p: EllipsePrim): Pt {
  return { x: -p.major.y * p.ratio, y: p.major.x * p.ratio };
}

/** Point on the ellipse at parameter t (absolute parameter, not normalised). */
export function ellipsePoint(p: EllipsePrim, t: number): Pt {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const nx = -p.major.y * p.ratio;
  const ny = p.major.x * p.ratio;
  return { x: p.c.x + p.major.x * c + nx * s, y: p.c.y + p.major.y * c + ny * s };
}

/** Derivative dE/dt at absolute parameter t. */
export function ellipseDeriv(p: EllipsePrim, t: number): Pt {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const nx = -p.major.y * p.ratio;
  const ny = p.major.x * p.ratio;
  return { x: -p.major.x * s + nx * c, y: -p.major.y * s + ny * c };
}

/** Exact (stored) start point of an arc, or the computed one. */
export function arcStart(p: ArcPrim): Pt {
  return p.p0 ? copy(p.p0) : { x: p.c.x + p.r * Math.cos(p.a0), y: p.c.y + p.r * Math.sin(p.a0) };
}

/** Exact (stored) end point of an arc, or the computed one. */
export function arcEnd(p: ArcPrim): Pt {
  return p.p1 ? copy(p.p1) : { x: p.c.x + p.r * Math.cos(p.a1), y: p.c.y + p.r * Math.sin(p.a1) };
}

/**
 * Arc primitive for a polyline bulge segment p0 → p1. Clockwise bulges become CCW arcs with the
 * endpoints swapped and `rev: true`. Returns null for a straight (or degenerate) segment.
 */
export function arcFromBulge(p0: Pt, p1: Pt, bulge: number): ArcPrim | null {
  const arc = bulgeToArc(p0, p1, bulge);
  if (!arc) return null;
  const c = arc.c;
  if (arc.ccw) return { k: 'arc', c, r: arc.r, a0: arc.a0, a1: arc.a1, p0: copy(p0), p1: copy(p1) };
  return { k: 'arc', c, r: arc.r, a0: arc.a1, a1: arc.a0, p0: copy(p1), p1: copy(p0), rev: true };
}

/** Converts a polyline (with bulges) into seg/arc primitives. Zero-length segments are skipped. */
export function primsFromPolyline(pts: readonly Vertex[], closed: boolean, out: Prim[] = []): Prim[] {
  const n = pts.length;
  if (n === 0) return out;
  if (n === 1) {
    out.push({ k: 'point', p: copy(pts[0]) });
    return out;
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (a.x === b.x && a.y === b.y) continue;
    const bulge = a.bulge ?? 0;
    const arc = bulge ? arcFromBulge(a, b, bulge) : null;
    out.push(arc ?? { k: 'seg', a: copy(a), b: copy(b) });
  }
  return out;
}

function rectCorners(c: Pt, w: number, h: number, rot: number): Pt[] {
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const hw = w / 2;
  const hh = h / 2;
  const local: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return local.map(([x, y]) => ({ x: c.x + x * cs - y * sn, y: c.y + x * sn + y * cs }));
}

/** Primitives of an analysis geometry. */
export function primsFromGeometry(g: Geometry): Prim[] {
  switch (g.type) {
    case 'circle':
      return [{ k: 'circle', c: copy(g.c), r: g.r }];
    case 'arc':
      return [{ k: 'arc', c: copy(g.c), r: g.r, a0: g.a0, a1: g.a1 }];
    case 'rect':
      return primsFromPolyline(rectCorners(g.c, g.w, g.h, g.rot), true);
    case 'ellipse': {
      if (!(g.rx > 0) || !(g.ry > 0)) return [{ k: 'point', p: copy(g.c) }];
      const major = { x: g.rx * Math.cos(g.rot), y: g.rx * Math.sin(g.rot) };
      return [{ k: 'ellipse', c: copy(g.c), major, ratio: g.ry / g.rx, t0: 0, t1: TAU }];
    }
    case 'polyline':
      return primsFromPolyline(g.pts, g.closed);
    case 'multipolygon': {
      const out: Prim[] = [];
      for (const ring of g.rings) primsFromPolyline(ring, true, out);
      return out;
    }
    case 'point':
      return [{ k: 'point', p: copy(g.p) }];
  }
}

function readVertices(geom: Float64Array, o: number, n: number): Vertex[] {
  const pts: Vertex[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const p = o + k * 3;
    const bulge = geom[p + 2];
    pts[k] = bulge ? { x: geom[p], y: geom[p + 1], bulge } : { x: geom[p], y: geom[p + 1] };
  }
  return pts;
}

/**
 * Primitives of underlay entity `i` (drawing units, exact stored numbers). TEXT becomes a point at
 * its insertion point; FILL rings become closed seg/arc chains.
 */
export function primsFromStoreEntity(store: EntityStore, i: number): Prim[] {
  const g = store.geom;
  const o = store.geomStart[i];
  switch (store.geomKind[i]) {
    case GK.LINE: {
      const a = { x: g[o], y: g[o + 1] };
      const b = { x: g[o + 2], y: g[o + 3] };
      if (a.x === b.x && a.y === b.y) return [{ k: 'point', p: a }];
      return [{ k: 'seg', a, b }];
    }
    case GK.CIRCLE:
      return [{ k: 'circle', c: { x: g[o], y: g[o + 1] }, r: g[o + 2] }];
    case GK.ARC:
      return [{ k: 'arc', c: { x: g[o], y: g[o + 1] }, r: g[o + 2], a0: g[o + 3], a1: g[o + 4] }];
    case GK.ELLIPSE:
      return [
        {
          k: 'ellipse',
          c: { x: g[o], y: g[o + 1] },
          major: { x: g[o + 2], y: g[o + 3] },
          ratio: g[o + 4],
          t0: g[o + 5],
          t1: g[o + 6],
        },
      ];
    case GK.POLY: {
      const n = g[o];
      return primsFromPolyline(readVertices(g, o + 1, n), (store.flags[i] & FLAG.CLOSED) !== 0);
    }
    case GK.POINT:
    case GK.TEXT:
      return [{ k: 'point', p: { x: g[o], y: g[o + 1] } }];
    case GK.FILL: {
      const out: Prim[] = [];
      let q = o;
      const nRings = g[q++];
      for (let r = 0; r < nRings; r++) {
        const n = g[q++];
        primsFromPolyline(readVertices(g, q, n), true, out);
        q += n * 3;
      }
      return out;
    }
    default:
      return [];
  }
}

function extend(b: Bounds, x: number, y: number) {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
}

/** True if absolute angle `a` lies on the CCW span starting at `start` with `sweep` (radians). */
export function inSpan(a: number, start: number, sweep: number, tol = 1e-12): boolean {
  if (sweep >= TAU - tol) return true;
  const rel = normAngle(a - start);
  return rel <= sweep + tol || rel >= TAU - tol;
}

/** Axis-aligned bounds of a primitive. */
export function primBounds(p: Prim): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  switch (p.k) {
    case 'seg':
      extend(b, p.a.x, p.a.y);
      extend(b, p.b.x, p.b.y);
      return b;
    case 'point':
      extend(b, p.p.x, p.p.y);
      return b;
    case 'circle':
      return { minX: p.c.x - p.r, minY: p.c.y - p.r, maxX: p.c.x + p.r, maxY: p.c.y + p.r };
    case 'arc': {
      const s = arcStart(p);
      const e = arcEnd(p);
      extend(b, s.x, s.y);
      extend(b, e.x, e.y);
      const sweep = arcSweep(p);
      for (let q = 0; q < 4; q++) {
        const ang = (q * Math.PI) / 2;
        if (inSpan(ang, p.a0, sweep)) extend(b, p.c.x + p.r * Math.cos(ang), p.c.y + p.r * Math.sin(ang));
      }
      return b;
    }
    case 'ellipse': {
      const sweep = ellipseSweep(p);
      const n = ellipseMinor(p);
      const cands = [Math.atan2(n.x, p.major.x), Math.atan2(n.y, p.major.y)];
      cands.push(cands[0] + Math.PI, cands[1] + Math.PI);
      for (const t of cands) {
        if (inSpan(t, p.t0, sweep)) {
          const q = ellipsePoint(p, t);
          extend(b, q.x, q.y);
        }
      }
      if (sweep < TAU) {
        const s = ellipsePoint(p, p.t0);
        const e = ellipsePoint(p, p.t0 + sweep);
        extend(b, s.x, s.y);
        extend(b, e.x, e.y);
      }
      return b;
    }
  }
}

// 8-point Gauss–Legendre nodes and weights on [-1, 1].
const GL_X = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498, 0.1834346424956498,
  0.525532409916329, 0.7966664774136267, 0.9602898564975363,
];
const GL_W = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362, 0.362683783378362,
  0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
];

function glIntegrate(f: (t: number) => number, a: number, b: number, m: number): number {
  const h = (b - a) / m;
  let sum = 0;
  for (let k = 0; k < m; k++) {
    const mid = a + (k + 0.5) * h;
    for (let q = 0; q < 8; q++) sum += GL_W[q] * f(mid + (GL_X[q] * h) / 2);
  }
  return (sum * h) / 2;
}

/** Arc length of an ellipse between absolute parameters ta and tb (tb ≥ ta). */
export function ellipseArcLength(p: EllipsePrim, ta: number, tb: number): number {
  if (tb <= ta) return 0;
  const speed = (t: number) => {
    const d = ellipseDeriv(p, t);
    return Math.hypot(d.x, d.y);
  };
  let m = Math.max(4, Math.ceil(((tb - ta) / TAU) * 32));
  let prev = glIntegrate(speed, ta, tb, m);
  for (let iter = 0; iter < 8; iter++) {
    m *= 2;
    const next = glIntegrate(speed, ta, tb, m);
    if (Math.abs(next - prev) <= 1e-13 * Math.max(1e-300, Math.abs(next))) return next;
    prev = next;
  }
  return prev;
}

/** Length of a primitive (0 for points). */
export function primLength(p: Prim): number {
  switch (p.k) {
    case 'seg':
      return Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
    case 'arc':
      return p.r * arcSweep(p);
    case 'circle':
      return TAU * p.r;
    case 'ellipse':
      return ellipseArcLength(p, p.t0, p.t0 + ellipseSweep(p));
    case 'point':
      return 0;
  }
}

/**
 * Point at normalised parameter t ∈ [0, 1]: linear along segments, angular along arcs and circles
 * (starting at angle 0 for circles), parametric along ellipses. t = 0 / 1 return the exact stored
 * endpoints.
 */
export function primPointAt(p: Prim, t: number): Pt {
  switch (p.k) {
    case 'seg':
      if (t === 0) return copy(p.a);
      if (t === 1) return copy(p.b);
      return { x: p.a.x + (p.b.x - p.a.x) * t, y: p.a.y + (p.b.y - p.a.y) * t };
    case 'arc': {
      if (t === 0) return arcStart(p);
      if (t === 1) return arcEnd(p);
      const a = p.a0 + arcSweep(p) * t;
      return { x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) };
    }
    case 'circle': {
      const a = TAU * t;
      return { x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) };
    }
    case 'ellipse':
      return ellipsePoint(p, p.t0 + ellipseSweep(p) * t);
    case 'point':
      return copy(p.p);
  }
}

/** Unit tangent (direction of increasing parameter) at normalised parameter t. */
export function primTangentAt(p: Prim, t: number): Pt {
  let d: Pt;
  switch (p.k) {
    case 'seg':
      d = { x: p.b.x - p.a.x, y: p.b.y - p.a.y };
      break;
    case 'arc': {
      const a = p.a0 + arcSweep(p) * t;
      d = { x: -Math.sin(a), y: Math.cos(a) };
      break;
    }
    case 'circle': {
      const a = TAU * t;
      d = { x: -Math.sin(a), y: Math.cos(a) };
      break;
    }
    case 'ellipse':
      d = ellipseDeriv(p, p.t0 + ellipseSweep(p) * t);
      break;
    case 'point':
      return { x: 0, y: 0 };
  }
  const l = Math.hypot(d.x, d.y);
  return l > 0 ? { x: d.x / l, y: d.y / l } : { x: 0, y: 0 };
}

/** True for primitives without endpoints (circles and full ellipses). */
export function primIsClosed(p: Prim): boolean {
  return p.k === 'circle' || (p.k === 'ellipse' && isFullEllipse(p));
}

/**
 * Endpoints of a primitive: segment ends, arc ends (exact stored points when available), ellipse
 * arc ends and the point of a point primitive. Closed curves have none.
 */
export function primEndpoints(p: Prim): Pt[] {
  switch (p.k) {
    case 'seg':
      return [copy(p.a), copy(p.b)];
    case 'arc':
      return [arcStart(p), arcEnd(p)];
    case 'circle':
      return [];
    case 'ellipse':
      if (isFullEllipse(p)) return [];
      return [ellipsePoint(p, p.t0), ellipsePoint(p, p.t0 + ellipseSweep(p))];
    case 'point':
      return [copy(p.p)];
  }
}

/** Normalised arc parameter of an absolute angle, clamped to [0, 1] towards the nearer end. */
export function spanParam(angle: number, start: number, sweep: number): number {
  const rel = normAngle(angle - start);
  if (rel <= sweep) return sweep > 0 ? rel / sweep : 0;
  // Outside the span: clamp to the nearer end.
  return rel - sweep < TAU - rel ? 1 : 0;
}

/** Union of bounds. */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}
