import type { Pt } from '@/core/types';
import { intersectPrims, primsTolerance } from './intersect';
import {
  arcEnd,
  arcStart,
  arcSweep,
  ellipseArcLength,
  ellipseDeriv,
  ellipseMinor,
  ellipsePoint,
  ellipseSweep,
  inSpan,
  isFullEllipse,
  primBounds,
  primEndpoints,
  spanParam,
  type EllipsePrim,
  type Prim,
} from './prims';
import { TAU, normAngle } from './vec';

/**
 * Snap-candidate math (FDR row 27). Endpoint and centre candidates return the stored numbers
 * untouched; everything else is computed relative to the primitive (never with products of absolute
 * coordinates) so plant/UTM-sized coordinates keep full precision.
 */

export interface NearestResult {
  pt: Pt;
  /** Normalised parameter on the primitive (see primPointAt). */
  t: number;
  dist: number;
}

const copy = (p: Pt): Pt => ({ x: p.x, y: p.y });

/** Bracketed Newton/bisection root of g on [lo, hi] (g(lo), g(hi) of opposite sign). */
function solveBracket(g: (t: number) => number, dg: (t: number) => number, lo: number, hi: number): number {
  let glo = g(lo);
  let x = (lo + hi) / 2;
  for (let it = 0; it < 100; it++) {
    const gx = g(x);
    if (gx === 0) return x;
    if (Math.sign(gx) === Math.sign(glo)) {
      lo = x;
      glo = gx;
    } else hi = x;
    let next = (lo + hi) / 2;
    const d = dg(x);
    if (d !== 0) {
      const nx = x - gx / d;
      if (nx > lo && nx < hi) next = nx;
    }
    if (Math.abs(next - x) <= 1e-16 * Math.max(1, Math.abs(x)) || hi - lo <= 1e-15 * Math.max(1, Math.abs(x)))
      return next;
    x = next;
  }
  return x;
}

/**
 * Foot-point function for ellipses: g(t) = (E(t) − p)·E'(t), zero at perpendicular feet.
 * Computed relative to the centre for precision.
 */
function ellipseFootFns(e: EllipsePrim, p: Pt) {
  const n = ellipseMinor(e);
  const qx = p.x - e.c.x;
  const qy = p.y - e.c.y;
  const mx = e.major.x;
  const my = e.major.y;
  const g = (t: number) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    const ex = mx * c + n.x * s - qx;
    const ey = my * c + n.y * s - qy;
    const dx = -mx * s + n.x * c;
    const dy = -my * s + n.y * c;
    return ex * dx + ey * dy;
  };
  const dg = (t: number) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    const px = mx * c + n.x * s;
    const py = my * c + n.y * s;
    const dx = -mx * s + n.x * c;
    const dy = -my * s + n.y * c;
    // E'' = −(E − c)
    return dx * dx + dy * dy - ((px - qx) * px + (py - qy) * py);
  };
  const d2 = (t: number) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    const ex = mx * c + n.x * s - qx;
    const ey = my * c + n.y * s - qy;
    return ex * ex + ey * ey;
  };
  return { g, dg, d2 };
}

/** Parameters (absolute) of all perpendicular feet from p on the ellipse span. */
function ellipseFeetParams(e: EllipsePrim, p: Pt): number[] {
  const sweep = ellipseSweep(e);
  const { g, dg } = ellipseFootFns(e, p);
  const n = Math.max(16, Math.ceil((sweep / TAU) * 256));
  const out: number[] = [];
  let tPrev = e.t0;
  let gPrev = g(tPrev);
  for (let i = 1; i <= n; i++) {
    const t = e.t0 + (sweep * i) / n;
    const gt = g(t);
    if (gPrev === 0) out.push(tPrev);
    else if (gPrev * gt < 0) out.push(solveBracket(g, dg, tPrev, t));
    tPrev = t;
    gPrev = gt;
  }
  if (gPrev === 0 && sweep < TAU) out.push(tPrev);
  return out;
}

/** Nearest point on a primitive. */
export function nearestOnPrim(p: Pt, prim: Prim): NearestResult {
  switch (prim.k) {
    case 'point':
      return { pt: copy(prim.p), t: 0, dist: Math.hypot(p.x - prim.p.x, p.y - prim.p.y) };
    case 'seg': {
      const { a, b } = prim;
      const rx = b.x - a.x;
      const ry = b.y - a.y;
      const rr = rx * rx + ry * ry;
      let t = rr > 0 ? ((p.x - a.x) * rx + (p.y - a.y) * ry) / rr : 0;
      let pt: Pt;
      if (t <= 0) {
        t = 0;
        pt = copy(a);
      } else if (t >= 1) {
        t = 1;
        pt = copy(b);
      } else pt = { x: a.x + rx * t, y: a.y + ry * t };
      return { pt, t, dist: Math.hypot(p.x - pt.x, p.y - pt.y) };
    }
    case 'circle': {
      const dx = p.x - prim.c.x;
      const dy = p.y - prim.c.y;
      const ang = dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx);
      const pt = { x: prim.c.x + prim.r * Math.cos(ang), y: prim.c.y + prim.r * Math.sin(ang) };
      return { pt, t: normAngle(ang) / TAU, dist: Math.abs(Math.hypot(dx, dy) - prim.r) };
    }
    case 'arc': {
      const dx = p.x - prim.c.x;
      const dy = p.y - prim.c.y;
      const sweep = arcSweep(prim);
      const ang = dx === 0 && dy === 0 ? prim.a0 : Math.atan2(dy, dx);
      if (inSpan(ang, prim.a0, sweep, 0)) {
        const pt = { x: prim.c.x + prim.r * Math.cos(ang), y: prim.c.y + prim.r * Math.sin(ang) };
        return { pt, t: spanParam(ang, prim.a0, sweep), dist: Math.abs(Math.hypot(dx, dy) - prim.r) };
      }
      const s = arcStart(prim);
      const e = arcEnd(prim);
      const ds = Math.hypot(p.x - s.x, p.y - s.y);
      const de = Math.hypot(p.x - e.x, p.y - e.y);
      return ds <= de ? { pt: s, t: 0, dist: ds } : { pt: e, t: 1, dist: de };
    }
    case 'ellipse': {
      const sweep = ellipseSweep(prim);
      const { d2 } = ellipseFootFns(prim, p);
      let bestT = prim.t0;
      let bestD = d2(prim.t0);
      const consider = (t: number) => {
        const d = d2(t);
        if (d < bestD) {
          bestD = d;
          bestT = t;
        }
      };
      for (const t of ellipseFeetParams(prim, p)) consider(t);
      consider(prim.t0 + sweep);
      const t = bestT === prim.t0 + sweep && sweep < TAU ? 1 : spanParam(bestT, prim.t0, sweep);
      return { pt: ellipsePoint(prim, bestT), t, dist: Math.sqrt(bestD) };
    }
  }
}

/** Feet of perpendiculars from `from` that lie on the primitive. */
export function perpendicularFeet(from: Pt, prim: Prim): Pt[] {
  switch (prim.k) {
    case 'point':
      return [];
    case 'seg': {
      const { a, b } = prim;
      const rx = b.x - a.x;
      const ry = b.y - a.y;
      const rr = rx * rx + ry * ry;
      if (rr === 0) return [];
      const t = ((from.x - a.x) * rx + (from.y - a.y) * ry) / rr;
      if (t < -1e-12 || t > 1 + 1e-12) return [];
      if (t <= 0) return [copy(a)];
      if (t >= 1) return [copy(b)];
      return [{ x: a.x + rx * t, y: a.y + ry * t }];
    }
    case 'circle':
    case 'arc': {
      const dx = from.x - prim.c.x;
      const dy = from.y - prim.c.y;
      const d = Math.hypot(dx, dy);
      if (d === 0) return [];
      const ux = dx / d;
      const uy = dy / d;
      const out: Pt[] = [];
      for (const s of [1, -1]) {
        const ang = Math.atan2(uy * s, ux * s);
        if (prim.k === 'arc' && !inSpan(ang, prim.a0, arcSweep(prim), 1e-12)) continue;
        out.push({ x: prim.c.x + prim.r * ux * s, y: prim.c.y + prim.r * uy * s });
      }
      return out;
    }
    case 'ellipse':
      return ellipseFeetParams(prim, from).map((t) => ellipsePoint(prim, t));
  }
}

/** Points where a line through `from` touches a circle, arc or ellipse tangentially. */
export function tangentPoints(from: Pt, prim: Prim): Pt[] {
  if (prim.k === 'circle' || prim.k === 'arc') {
    const dx = from.x - prim.c.x;
    const dy = from.y - prim.c.y;
    const d = Math.hypot(dx, dy);
    if (!(d > prim.r)) return [];
    const base = Math.atan2(dy, dx);
    const alpha = Math.acos(prim.r / d);
    const out: Pt[] = [];
    for (const ang of [base + alpha, base - alpha]) {
      if (prim.k === 'arc' && !inSpan(ang, prim.a0, arcSweep(prim), 1e-12)) continue;
      out.push({ x: prim.c.x + prim.r * Math.cos(ang), y: prim.c.y + prim.r * Math.sin(ang) });
    }
    return out;
  }
  if (prim.k === 'ellipse') {
    // Tangency is affine-invariant: solve in the frame where the ellipse is the unit circle.
    const n = ellipseMinor(prim);
    const qx = from.x - prim.c.x;
    const qy = from.y - prim.c.y;
    const mm = prim.major.x ** 2 + prim.major.y ** 2;
    const nn = n.x * n.x + n.y * n.y;
    const u = (qx * prim.major.x + qy * prim.major.y) / mm;
    const v = (qx * n.x + qy * n.y) / nn;
    const d = Math.hypot(u, v);
    if (!(d > 1)) return [];
    const base = Math.atan2(v, u);
    const alpha = Math.acos(1 / d);
    const sweep = ellipseSweep(prim);
    return [base + alpha, base - alpha]
      .filter((t) => inSpan(t, prim.t0, sweep, 1e-12))
      .map((t) => ellipsePoint(prim, t));
  }
  return [];
}

/** 0°/90°/180°/270° points of circles and arcs (within the arc span); axis ends of ellipses. */
export function quadrantPoints(prim: Prim): Pt[] {
  const out: Pt[] = [];
  if (prim.k === 'circle' || prim.k === 'arc') {
    const sweep = prim.k === 'arc' ? arcSweep(prim) : TAU;
    const start = prim.k === 'arc' ? prim.a0 : 0;
    const offs: [number, number][] = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    offs.forEach(([ox, oy], q) => {
      if (inSpan((q * Math.PI) / 2, start, sweep, 1e-12))
        out.push({ x: prim.c.x + ox * prim.r, y: prim.c.y + oy * prim.r });
    });
  } else if (prim.k === 'ellipse') {
    const sweep = ellipseSweep(prim);
    const n = ellipseMinor(prim);
    const axes: [number, Pt][] = [
      [0, prim.major],
      [Math.PI / 2, n],
      [Math.PI, { x: -prim.major.x, y: -prim.major.y }],
      [(3 * Math.PI) / 2, { x: -n.x, y: -n.y }],
    ];
    for (const [t, v] of axes)
      if (inSpan(t, prim.t0, sweep, 1e-12)) out.push({ x: prim.c.x + v.x, y: prim.c.y + v.y });
  }
  return out;
}

/** Midpoint along the primitive (arc-length midpoint for ellipse arcs); null for closed curves and points. */
export function midpoint(prim: Prim): Pt | null {
  switch (prim.k) {
    case 'seg':
      return { x: (prim.a.x + prim.b.x) / 2, y: (prim.a.y + prim.b.y) / 2 };
    case 'arc': {
      const a = prim.a0 + arcSweep(prim) / 2;
      return { x: prim.c.x + prim.r * Math.cos(a), y: prim.c.y + prim.r * Math.sin(a) };
    }
    case 'ellipse': {
      if (isFullEllipse(prim)) return null;
      const sweep = ellipseSweep(prim);
      const half = ellipseArcLength(prim, prim.t0, prim.t0 + sweep) / 2;
      // Newton on L(t) − L/2 with the speed |E'(t)| as derivative.
      let t = prim.t0 + sweep / 2;
      for (let it = 0; it < 30; it++) {
        const l = ellipseArcLength(prim, prim.t0, t) - half;
        const d = ellipseDeriv(prim, t);
        const speed = Math.hypot(d.x, d.y);
        if (speed === 0) break;
        const step = l / speed;
        t = Math.min(prim.t0 + sweep, Math.max(prim.t0, t - step));
        if (Math.abs(step) <= 1e-15 * Math.max(1, Math.abs(t))) break;
      }
      return ellipsePoint(prim, t);
    }
    default:
      return null;
  }
}

/** Exact stored centre of circles, arcs and ellipses. */
export function centre(prim: Prim): Pt | null {
  if (prim.k === 'circle' || prim.k === 'arc' || prim.k === 'ellipse') return copy(prim.c);
  return null;
}

/** Exact stored endpoints (see primEndpoints). */
export function endpoints(prim: Prim): Pt[] {
  return primEndpoints(prim);
}

export type SnapMode =
  'endpoint' | 'midpoint' | 'centre' | 'quadrant' | 'intersection' | 'nearest' | 'perpendicular' | 'tangent';

/** Lower = preferred. */
export const SNAP_PRIORITY: Record<SnapMode, number> = {
  endpoint: 0,
  centre: 0,
  intersection: 0,
  midpoint: 1,
  quadrant: 1,
  perpendicular: 2,
  tangent: 2,
  nearest: 3,
};

export interface SnapCandidate {
  pt: Pt;
  mode: SnapMode;
  /** Distance from the cursor. */
  dist: number;
  primIndex: number;
  /** Second primitive of an intersection. */
  otherIndex?: number;
}

export interface SnapOptions {
  modes: ReadonlySet<SnapMode>;
  /** Search radius around the cursor (same units as the primitives). */
  radius: number;
  /** Previous point, for perpendicular and tangent snaps. */
  from?: Pt;
}

function bboxDist(p: Pt, prim: Prim): number {
  const b = primBounds(prim);
  const dx = p.x < b.minX ? b.minX - p.x : p.x > b.maxX ? p.x - b.maxX : 0;
  const dy = p.y < b.minY ? b.minY - p.y : p.y > b.maxY ? p.y - b.maxY : 0;
  return Math.hypot(dx, dy);
}

/**
 * Snap candidates within `radius` of the cursor, sorted by mode priority (endpoint / centre /
 * intersection, then midpoint / quadrant, then perpendicular / tangent, then nearest) and distance.
 * Callers pass the primitives near the cursor (from a spatial index); intersections are computed
 * pairwise among them.
 */
export function snapCandidates(cursor: Pt, prims: readonly Prim[], opts: SnapOptions): SnapCandidate[] {
  const { modes, radius, from } = opts;
  const out: SnapCandidate[] = [];
  const seen = new Set<string>();
  const add = (pt: Pt, mode: SnapMode, primIndex: number, otherIndex?: number) => {
    const dist = Math.hypot(pt.x - cursor.x, pt.y - cursor.y);
    if (!(dist <= radius)) return;
    const key = `${mode}|${pt.x}|${pt.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    const c: SnapCandidate = { pt, mode, dist, primIndex };
    if (otherIndex !== undefined) c.otherIndex = otherIndex;
    out.push(c);
  };
  const near: number[] = [];
  prims.forEach((prim, i) => {
    const centreReach =
      (prim.k === 'circle' || prim.k === 'arc' || prim.k === 'ellipse') && modes.has('centre');
    if (bboxDist(cursor, prim) <= radius) near.push(i);
    else if (!centreReach) return;
    if (centreReach) {
      const c = centre(prim);
      if (c) add(c, 'centre', i);
    }
  });
  for (const i of near) {
    const prim = prims[i];
    if (modes.has('endpoint')) for (const p of primEndpoints(prim)) add(p, 'endpoint', i);
    if (modes.has('midpoint')) {
      const m = midpoint(prim);
      if (m) add(m, 'midpoint', i);
    }
    if (modes.has('quadrant')) for (const p of quadrantPoints(prim)) add(p, 'quadrant', i);
    if (modes.has('nearest') && prim.k !== 'point') add(nearestOnPrim(cursor, prim).pt, 'nearest', i);
    if (from && modes.has('perpendicular'))
      for (const p of perpendicularFeet(from, prim)) add(p, 'perpendicular', i);
    if (from && modes.has('tangent')) for (const p of tangentPoints(from, prim)) add(p, 'tangent', i);
  }
  if (modes.has('intersection')) {
    for (let x = 0; x < near.length; x++) {
      for (let y = x + 1; y < near.length; y++) {
        const a = prims[near[x]];
        const b = prims[near[y]];
        for (const p of intersectPrims(a, b, primsTolerance(a, b))) add(p, 'intersection', near[x], near[y]);
      }
    }
  }
  out.sort((p, q) => SNAP_PRIORITY[p.mode] - SNAP_PRIORITY[q.mode] || p.dist - q.dist);
  return out;
}
