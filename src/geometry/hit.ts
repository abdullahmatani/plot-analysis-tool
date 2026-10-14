import type { Bounds, Geometry, Pt, Vertex } from '@/core/types';

import { bulgeToArc } from './bulge';
import { isClosed, rectCorners } from './convert';
import { bounds, distanceToBulgeSegment, distanceToSegment, pointInRing } from './measure';
import { TAU, angleInArc, ccwSweep } from './vec';

/**
 * Hit testing and selection (FDR row 43): boundary distance, filled-interior tests, window / crossing
 * rectangles and lasso polygons. Circles, arcs, bulges and ellipses are handled analytically (no
 * tessellation).
 *
 * Selection semantics: "inside" (window / lasso) requires the whole shape inside. "Intersects" (crossing)
 * is true when any part of the outline is inside or crosses the selection; with `{ filled: true }` closed
 * shapes are treated as filled, so a selection entirely inside a shape also hits it (CAD default: outline
 * only).
 */

export interface SelectOptions {
  /** Treat closed shapes as filled regions (default false: outline only). */
  filled?: boolean;
}

/** Outline primitive. Arcs are CCW from a0 by sweep (> 0). */
type Prim =
  | { k: 'seg'; a: Pt; b: Pt }
  | { k: 'arc'; c: Pt; r: number; a0: number; sweep: number }
  | { k: 'circle'; c: Pt; r: number }
  | { k: 'ellipse'; c: Pt; rx: number; ry: number; rot: number }
  | { k: 'pt'; p: Pt };

function pathPrims(pts: readonly Vertex[], closed: boolean, out: Prim[]): void {
  const n = pts.length;
  if (n === 1) out.push({ k: 'pt', p: pts[0] });
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const arc = a.bulge ? bulgeToArc(a, b, a.bulge) : null;
    if (arc) {
      const a0 = arc.ccw ? arc.a0 : arc.a1;
      out.push({ k: 'arc', c: arc.c, r: arc.r, a0, sweep: Math.abs(arc.sweep) });
    } else out.push({ k: 'seg', a, b });
  }
}

function primitives(g: Geometry): Prim[] {
  const out: Prim[] = [];
  switch (g.type) {
    case 'point':
      out.push({ k: 'pt', p: g.p });
      break;
    case 'circle':
      out.push({ k: 'circle', c: g.c, r: Math.abs(g.r) });
      break;
    case 'arc':
      out.push({ k: 'arc', c: g.c, r: Math.abs(g.r), a0: g.a0, sweep: ccwSweep(g.a0, g.a1) });
      break;
    case 'rect':
      pathPrims(rectCorners(g), true, out);
      break;
    case 'ellipse': {
      const rx = Math.abs(g.rx);
      const ry = Math.abs(g.ry);
      if (rx > 0 && ry > 0) out.push({ k: 'ellipse', c: g.c, rx, ry, rot: g.rot });
      else {
        // Degenerate ellipse: the segment along its non-zero axis.
        const ux = Math.cos(g.rot);
        const uy = Math.sin(g.rot);
        const ex = rx * ux - ry * uy;
        const ey = rx * uy + ry * ux;
        out.push({ k: 'seg', a: { x: g.c.x - ex, y: g.c.y - ey }, b: { x: g.c.x + ex, y: g.c.y + ey } });
      }
      break;
    }
    case 'polyline':
      pathPrims(g.pts, g.closed, out);
      break;
    case 'multipolygon':
      for (const r of g.rings) pathPrims(r, true, out);
      break;
  }
  return out;
}

/** A point on the primitive. */
function samplePoint(p: Prim): Pt {
  switch (p.k) {
    case 'seg':
      return p.a;
    case 'pt':
      return p.p;
    case 'arc':
      return { x: p.c.x + p.r * Math.cos(p.a0), y: p.c.y + p.r * Math.sin(p.a0) };
    case 'circle':
      return { x: p.c.x + p.r, y: p.c.y };
    case 'ellipse':
      return { x: p.c.x + p.rx * Math.cos(p.rot), y: p.c.y + p.rx * Math.sin(p.rot) };
  }
}

/** Point in the ellipse's unit-circle frame. */
function toUnit(e: { c: Pt; rx: number; ry: number; rot: number }, p: Pt): Pt {
  const dx = p.x - e.c.x;
  const dy = p.y - e.c.y;
  const cs = Math.cos(e.rot);
  const sn = Math.sin(e.rot);
  return { x: (dx * cs + dy * sn) / e.rx, y: (-dx * sn + dy * cs) / e.ry };
}

/**
 * Distance from (y0, y1) (first quadrant) to the ellipse x²/e0² + y²/e1² = 1 with e0 ≥ e1 > 0
 * (D. Eberly, "Distance from a Point to an Ellipse", robust bisection on the Lagrange root).
 */
function ellipseDistanceQ1(e0: number, e1: number, y0: number, y1: number): number {
  if (y1 > 0) {
    if (y0 > 0) {
      const z0 = y0 / e0;
      const z1 = y1 / e1;
      const g = z0 * z0 + z1 * z1 - 1;
      if (g === 0) return 0;
      const r0 = (e0 / e1) ** 2;
      const n0 = r0 * z0;
      let s0 = z1 - 1;
      let s1 = g < 0 ? 0 : Math.hypot(n0, z1) - 1;
      let s = 0;
      for (let i = 0; i < 1100; i++) {
        s = (s0 + s1) / 2;
        if (s === s0 || s === s1) break;
        const ra = n0 / (s + r0);
        const rb = z1 / (s + 1);
        const gs = ra * ra + rb * rb - 1;
        if (gs > 0) s0 = s;
        else if (gs < 0) s1 = s;
        else break;
      }
      const x0 = (r0 * y0) / (s + r0);
      const x1 = y1 / (s + 1);
      return Math.hypot(x0 - y0, x1 - y1);
    }
    return Math.abs(y1 - e1);
  }
  const numer0 = e0 * y0;
  const denom0 = e0 * e0 - e1 * e1;
  if (numer0 < denom0) {
    const xde0 = numer0 / denom0;
    const x0 = e0 * xde0;
    const x1 = e1 * Math.sqrt(Math.max(0, 1 - xde0 * xde0));
    return Math.hypot(x0 - y0, x1);
  }
  return Math.abs(y0 - e0);
}

function ellipseDistance(e: { c: Pt; rx: number; ry: number; rot: number }, p: Pt): number {
  const dx = p.x - e.c.x;
  const dy = p.y - e.c.y;
  const cs = Math.cos(e.rot);
  const sn = Math.sin(e.rot);
  const lx = Math.abs(dx * cs + dy * sn);
  const ly = Math.abs(-dx * sn + dy * cs);
  return e.rx >= e.ry ? ellipseDistanceQ1(e.rx, e.ry, lx, ly) : ellipseDistanceQ1(e.ry, e.rx, ly, lx);
}

function primDistance(prim: Prim, p: Pt): number {
  switch (prim.k) {
    case 'pt':
      return Math.hypot(p.x - prim.p.x, p.y - prim.p.y);
    case 'seg':
      return distanceToSegment(p, prim.a, prim.b);
    case 'circle':
      return Math.abs(Math.hypot(p.x - prim.c.x, p.y - prim.c.y) - prim.r);
    case 'arc': {
      const dx = p.x - prim.c.x;
      const dy = p.y - prim.c.y;
      if (angleInArc(Math.atan2(dy, dx), prim.a0, prim.a0 + prim.sweep, 1e-12) || prim.sweep >= TAU) {
        return Math.abs(Math.hypot(dx, dy) - prim.r);
      }
      const e0 = prim.a0;
      const e1 = prim.a0 + prim.sweep;
      return Math.min(
        Math.hypot(p.x - prim.c.x - prim.r * Math.cos(e0), p.y - prim.c.y - prim.r * Math.sin(e0)),
        Math.hypot(p.x - prim.c.x - prim.r * Math.cos(e1), p.y - prim.c.y - prim.r * Math.sin(e1)),
      );
    }
    case 'ellipse':
      return ellipseDistance(prim, p);
  }
}

/** Distance from p to the outline of g (exact for arcs, bulges, circles and ellipses). */
export function distanceToGeometry(p: Pt, g: Geometry): number {
  if (g.type === 'polyline' || g.type === 'multipolygon') {
    // Fast path without allocating primitives.
    const rings = g.type === 'polyline' ? [g.pts] : g.rings;
    const closed = g.type === 'polyline' ? g.closed : true;
    let best = Infinity;
    for (const r of rings) {
      const n = r.length;
      if (n === 1) best = Math.min(best, Math.hypot(p.x - r[0].x, p.y - r[0].y));
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const d = distanceToBulgeSegment(p, r[i], r[(i + 1) % n], r[i].bulge);
        if (d < best) best = d;
      }
    }
    return best;
  }
  let best = Infinity;
  for (const prim of primitives(g)) best = Math.min(best, primDistance(prim, p));
  return best;
}

/** True if p is in the filled interior of a closed shape (holes excluded, bulge-aware). Open shapes: false. */
export function pointInGeometry(p: Pt, g: Geometry): boolean {
  switch (g.type) {
    case 'circle':
      return Math.hypot(p.x - g.c.x, p.y - g.c.y) <= Math.abs(g.r);
    case 'rect': {
      const dx = p.x - g.c.x;
      const dy = p.y - g.c.y;
      const cs = Math.cos(g.rot);
      const sn = Math.sin(g.rot);
      return (
        Math.abs(dx * cs + dy * sn) <= Math.abs(g.w) / 2 && Math.abs(-dx * sn + dy * cs) <= Math.abs(g.h) / 2
      );
    }
    case 'ellipse': {
      if (g.rx === 0 || g.ry === 0) return false;
      const u = toUnit({ c: g.c, rx: Math.abs(g.rx), ry: Math.abs(g.ry), rot: g.rot }, p);
      return u.x * u.x + u.y * u.y <= 1;
    }
    case 'polyline':
      return g.closed && pointInRing(p, g.pts);
    case 'multipolygon': {
      let inside = false;
      for (const r of g.rings) if (pointInRing(p, r)) inside = !inside;
      return inside;
    }
    default:
      return false;
  }
}

/** Even–odd point-in-polygon for a plain selection polygon. */
function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  return pointInRing(p, poly);
}

const orient = (a: Pt, b: Pt, c: Pt): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function onSegment(a: Pt, b: Pt, p: Pt): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

/** Closed segment–segment intersection test. */
function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(c, d, a)) return true;
  if (d2 === 0 && onSegment(c, d, b)) return true;
  if (d3 === 0 && onSegment(a, b, c)) return true;
  if (d4 === 0 && onSegment(a, b, d)) return true;
  return false;
}

/** Parameters t ∈ [0, 1] where the segment a→b meets the circle (c, r). */
function segmentCircleParams(a: Pt, b: Pt, c: Pt, r: number): number[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  if (A === 0) return Math.abs(Math.hypot(fx, fy) - r) <= 1e-12 * Math.max(1, r) ? [0] : [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  // Numerically stable roots.
  const q = -0.5 * (B + (B >= 0 ? sq : -sq));
  const roots = q !== 0 ? [q / A, C / q] : [-B / (2 * A)];
  return roots.filter((t) => t >= -1e-12 && t <= 1 + 1e-12);
}

function primIntersectsSegment(prim: Prim, a: Pt, b: Pt): boolean {
  switch (prim.k) {
    case 'pt':
      return distanceToSegment(prim.p, a, b) <= 1e-12 * Math.max(1, Math.abs(prim.p.x), Math.abs(prim.p.y));
    case 'seg':
      return segmentsIntersect(prim.a, prim.b, a, b);
    case 'circle': {
      const dMin = distanceToSegment(prim.c, a, b);
      const dMax = Math.max(
        Math.hypot(a.x - prim.c.x, a.y - prim.c.y),
        Math.hypot(b.x - prim.c.x, b.y - prim.c.y),
      );
      return dMin <= prim.r && prim.r <= dMax;
    }
    case 'arc': {
      for (const t of segmentCircleParams(a, b, prim.c, prim.r)) {
        const x = a.x + t * (b.x - a.x) - prim.c.x;
        const y = a.y + t * (b.y - a.y) - prim.c.y;
        if (prim.sweep >= TAU || angleInArc(Math.atan2(y, x), prim.a0, prim.a0 + prim.sweep, 1e-12))
          return true;
      }
      return false;
    }
    case 'ellipse': {
      const ua = toUnit(prim, a);
      const ub = toUnit(prim, b);
      const o = { x: 0, y: 0 };
      return (
        distanceToSegment(o, ua, ub) <= 1 && 1 <= Math.max(Math.hypot(ua.x, ua.y), Math.hypot(ub.x, ub.y))
      );
    }
  }
}

function polygonBounds(poly: readonly Pt[]): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of poly) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

const overlaps = (a: Bounds, b: Bounds): boolean =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
const within = (inner: Bounds, outer: Bounds): boolean =>
  inner.minX >= outer.minX &&
  inner.maxX <= outer.maxX &&
  inner.minY >= outer.minY &&
  inner.maxY <= outer.maxY;

function outlineCrossesPolygon(prims: readonly Prim[], poly: readonly Pt[]): boolean {
  const n = poly.length;
  for (const prim of prims) {
    for (let i = 0; i < n; i++) {
      if (primIntersectsSegment(prim, poly[i], poly[(i + 1) % n])) return true;
    }
  }
  return false;
}

/** Lasso / crossing: true when any part of the outline lies inside or crosses `poly` (see SelectOptions). */
export function geometryIntersectsPolygon(
  g: Geometry,
  poly: readonly Pt[],
  opts: SelectOptions = {},
): boolean {
  if (poly.length === 0) return false;
  if (!overlaps(bounds(g), polygonBounds(poly))) return false;
  const prims = primitives(g);
  if (poly.length >= 2 && outlineCrossesPolygon(prims, poly)) return true;
  if (poly.length >= 3 && prims.some((p) => pointInPolygon(samplePoint(p), poly))) return true;
  return !!opts.filled && isClosed(g) && pointInGeometry(poly[0], g);
}

/** Lasso window: true when the whole shape lies inside `poly` (touching the lasso does not count). */
export function geometryInsidePolygon(g: Geometry, poly: readonly Pt[]): boolean {
  if (poly.length < 3) return false;
  if (!within(bounds(g), polygonBounds(poly))) return false;
  const prims = primitives(g);
  if (outlineCrossesPolygon(prims, poly)) return false;
  // No crossings: each connected outline piece is entirely inside or outside.
  return prims.every((p) => pointInPolygon(samplePoint(p), poly));
}

function rectPolygon(b: Bounds): Pt[] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

/** Crossing selection rectangle. */
export function geometryIntersectsRect(g: Geometry, b: Bounds, opts: SelectOptions = {}): boolean {
  const gb = bounds(g);
  if (!overlaps(gb, b)) return false;
  if (within(gb, b)) return true;
  return geometryIntersectsPolygon(g, rectPolygon(b), opts);
}

/** Window selection rectangle: the whole shape (exact bounds) lies inside. */
export function geometryInsideRect(g: Geometry, b: Bounds): boolean {
  return within(bounds(g), b);
}
