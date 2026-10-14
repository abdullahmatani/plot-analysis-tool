import type { Bounds, Geometry, Pt, Vertex } from '@/core/types';

import { bulgeToArc, segmentLength } from './bulge';
import { TAU, angleInArc, ccwSweep } from './vec';

/**
 * Exact measurements of analysis geometry (FDR rows 35, 39, 40).
 *
 * Precision notes (NFR-7): world coordinates can be large (plant/UTM, e.g. X 600 000, Y 2 500 000), so
 * every accumulation (shoelace sums, first moments, centroids) is done relative to a local origin (the
 * first vertex) to avoid catastrophic cancellation. Bulge arcs are handled analytically (circular segment
 * areas and centroids), never by tessellation.
 */

/** Below this angle (radians) closed-form expressions are replaced by their Taylor series. */
const SMALL_ANGLE = 0.05;

/** θ − sin θ without cancellation for small |θ|. */
function thetaMinusSin(t: number): number {
  if (Math.abs(t) < SMALL_ANGLE) {
    const t2 = t * t;
    return ((t * t2) / 6) * (1 - (t2 / 20) * (1 - (t2 / 42) * (1 - t2 / 72)));
  }
  return t - Math.sin(t);
}

/**
 * Centroid of a circular segment (region between chord and arc) measured from the chord midpoint along
 * the sagitta, as a fraction of the sagitta. α = half the included angle, 0 < α ≤ π.
 */
function segmentCentroidFraction(alpha: number): number {
  if (alpha < SMALL_ANGLE) {
    const a2 = alpha * alpha;
    return 0.4 + (3 / 350) * a2 + (11 / 21000) * a2 * a2;
  }
  const s = Math.sin(alpha);
  const c = Math.cos(alpha);
  const f = (4 * s * s * s) / (3 * (2 * alpha - Math.sin(2 * alpha)));
  return (f - c) / (1 - c);
}

/** Centroid of a circular arc (curve) from the chord midpoint along the sagitta, as a fraction of the sagitta. */
function arcCentroidFraction(alpha: number): number {
  if (alpha < SMALL_ANGLE) {
    const a2 = alpha * alpha;
    return 2 / 3 - a2 / 90 - (a2 * a2) / 2520;
  }
  const c = Math.cos(alpha);
  return (Math.sin(alpha) / alpha - c) / (1 - c);
}

/**
 * Signed area of the circular segment between the chord p0→p1 and its bulge arc. Positive bulges arc to
 * the right of p0→p1 (outwards for a counter-clockwise ring), so the value adds directly to the ring's
 * signed (shoelace) area.
 */
export function bulgeSegmentArea(p0: Pt, p1: Pt, bulge: number | undefined): number {
  if (!bulge) return 0;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const c2 = dx * dx + dy * dy;
  if (c2 === 0) return 0;
  const theta = 4 * Math.atan(bulge);
  const s = Math.sin(theta / 2);
  return (c2 / (8 * s * s)) * thetaMinusSin(theta);
}

/** Midpoint of the bulge arc from p0 to p1 (the chord midpoint for straight segments). */
export function bulgeMidpoint(p0: Pt, p1: Pt, bulge: number | undefined): Pt {
  const b = bulge ?? 0;
  return { x: (p0.x + p1.x) / 2 + ((p1.y - p0.y) * b) / 2, y: (p0.y + p1.y) / 2 - ((p1.x - p0.x) * b) / 2 };
}

/** Signed area of a closed ring (CCW positive), exact for bulge arcs. */
export function signedArea(pts: readonly Vertex[]): number {
  const n = pts.length;
  if (n < 2) return 0;
  const ox = pts[0].x;
  const oy = pts[0].y;
  let a2 = 0;
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[i + 1 === n ? 0 : i + 1];
    a2 += (p.x - ox) * (q.y - oy) - (q.x - ox) * (p.y - oy);
    if (p.bulge) seg += bulgeSegmentArea(p, q, p.bulge);
  }
  return a2 / 2 + seg;
}

interface Moments {
  /** Signed area. */
  a: number;
  /** First moments ∫x dA and ∫y dA relative to the local origin. */
  mx: number;
  my: number;
}

/** Signed area and first moments of a closed ring relative to (ox, oy), exact for bulges. */
function ringMoments(pts: readonly Vertex[], ox: number, oy: number): Moments {
  const n = pts.length;
  let a2 = 0;
  let mx6 = 0;
  let my6 = 0;
  let sa = 0;
  let smx = 0;
  let smy = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[i + 1 === n ? 0 : i + 1];
    const x0 = p.x - ox;
    const y0 = p.y - oy;
    const x1 = q.x - ox;
    const y1 = q.y - oy;
    const cr = x0 * y1 - x1 * y0;
    a2 += cr;
    mx6 += (x0 + x1) * cr;
    my6 += (y0 + y1) * cr;
    const b = p.bulge;
    if (b) {
      const as = bulgeSegmentArea(p, q, b);
      if (as === 0) continue;
      const t = segmentCentroidFraction(Math.abs(2 * Math.atan(b)));
      const cx = (x0 + x1) / 2 + (((y1 - y0) * b) / 2) * t;
      const cy = (y0 + y1) / 2 - (((x1 - x0) * b) / 2) * t;
      sa += as;
      smx += as * cx;
      smy += as * cy;
    }
  }
  return { a: a2 / 2 + sa, mx: mx6 / 6 + smx, my: my6 / 6 + smy };
}

/** Length of a polyline including bulge arcs (closing segment included when closed). */
export function polylineLength(pts: readonly Vertex[], closed: boolean): number {
  const n = pts.length;
  if (n < 2) return 0;
  const segs = closed ? n : n - 1;
  let total = 0;
  for (let i = 0; i < segs; i++) {
    const p = pts[i];
    total += segmentLength(p, pts[(i + 1) % n], p.bulge ?? 0);
  }
  return total;
}

/**
 * Ellipse perimeter, exact to machine precision via the arithmetic–geometric mean:
 * P = 2π (a² − Σₙ 2ⁿ⁻¹ cₙ²) / AGM(a, b) with c₀² = a² − b² (Gauss–Legendre). Converges quadratically.
 */
export function ellipsePerimeter(rx: number, ry: number): number {
  let a = Math.abs(rx);
  let b = Math.abs(ry);
  if (a < b) [a, b] = [b, a];
  if (a === 0) return 0;
  if (b === 0) return 4 * a;
  let sum = (a * a + b * b) / 2;
  let an = a;
  let bn = b;
  let pow = 1;
  for (let i = 0; i < 64; i++) {
    const c = (an - bn) / 2;
    const next = (an + bn) / 2;
    bn = Math.sqrt(an * bn);
    an = next;
    sum -= pow * c * c;
    pow *= 2;
    if (Math.abs(c) <= 1e-10 * a) break;
  }
  return (2 * Math.PI * sum) / an;
}

/** Distance from p to the straight segment a–b. */
export function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const px = p.x - a.x;
  const py = p.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? (px * dx + py * dy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - t * dx, py - t * dy);
}

/** Distance from p to the segment a→b, which is a circular arc when `bulge` ≠ 0. */
export function distanceToBulgeSegment(p: Pt, a: Pt, b: Pt, bulge: number | undefined): number {
  const arc = bulge ? bulgeToArc(a, b, bulge) : null;
  if (!arc) return distanceToSegment(p, a, b);
  const dx = p.x - arc.c.x;
  const dy = p.y - arc.c.y;
  const ang = Math.atan2(dy, dx);
  const inside = arc.ccw ? angleInArc(ang, arc.a0, arc.a1, 1e-12) : angleInArc(ang, arc.a1, arc.a0, 1e-12);
  if (inside) return Math.abs(Math.hypot(dx, dy) - arc.r);
  return Math.min(Math.hypot(p.x - a.x, p.y - a.y), Math.hypot(p.x - b.x, p.y - b.y));
}

/** Distance from p to the boundary of a ring (closed) or path (open), bulge-aware. */
export function distanceToRing(p: Pt, pts: readonly Vertex[], closed = true): number {
  const n = pts.length;
  if (n === 0) return Infinity;
  if (n === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  const segs = closed ? n : n - 1;
  let best = Infinity;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const d = distanceToBulgeSegment(p, a, pts[(i + 1) % n], a.bulge);
    if (d < best) best = d;
  }
  return best;
}

/** True if p lies inside the circular segment between chord a→b and its bulge arc. */
function inBulgeSegmentRegion(p: Pt, a: Pt, b: Pt, bulge: number): boolean {
  const arc = bulgeToArc(a, b, bulge);
  if (!arc) return false;
  const dx = p.x - arc.c.x;
  const dy = p.y - arc.c.y;
  if (dx * dx + dy * dy >= arc.r * arc.r) return false;
  const side = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return bulge > 0 ? side < 0 : side > 0;
}

/**
 * Even–odd point-in-ring test, exact for bulge arcs: the parity against the chord polygon is toggled for
 * every circular segment (between chord and arc) that contains the point. Boundary points are unspecified.
 */
export function pointInRing(p: Pt, pts: readonly Vertex[]): boolean {
  const n = pts.length;
  let inside = false;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[i + 1 === n ? 0 : i + 1];
    if (a.y > p.y !== b.y > p.y) {
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < x) inside = !inside;
    }
    if (a.bulge && inBulgeSegmentRegion(p, a, b, a.bulge)) inside = !inside;
  }
  return inside;
}

function boundsContain(outer: Bounds, inner: Bounds, tol: number): boolean {
  return (
    inner.minX >= outer.minX - tol &&
    inner.minY >= outer.minY - tol &&
    inner.maxX <= outer.maxX + tol &&
    inner.maxY <= outer.maxY + tol
  );
}

/** True if ring `inner` lies inside ring `outer` (decided by a sample point not on outer's boundary). */
function ringInsideRing(inner: readonly Vertex[], outer: readonly Vertex[], tol: number): boolean | null {
  const n = inner.length;
  for (let i = 0; i < n; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % n];
    for (const s of [a, bulgeMidpoint(a, b, a.bulge)]) {
      if (distanceToRing(s, outer) > tol) return pointInRing(s, outer);
    }
  }
  return null; // every sample lies on outer's boundary (coincident rings)
}

/**
 * Containment depth of each ring (number of other rings that contain it). Even depth = outer boundary,
 * odd depth = hole (even–odd semantics). Coincident rings are ordered by index so that they cancel.
 */
export function ringDepths(rings: readonly (readonly Vertex[])[]): number[] {
  const n = rings.length;
  const bbs = rings.map((r) => polylineBounds(r, true));
  const depth = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const bi = bbs[i];
    const tol =
      1e-9 * Math.max(1, bi.maxX - bi.minX, bi.maxY - bi.minY) +
      1e-12 * Math.max(Math.abs(bi.minX), Math.abs(bi.minY), Math.abs(bi.maxX), Math.abs(bi.maxY));
    for (let j = 0; j < n; j++) {
      if (i === j || rings[j].length < 2 || !boundsContain(bbs[j], bi, tol)) continue;
      const inside = ringInsideRing(rings[i], rings[j], tol);
      if (inside === true || (inside === null && j < i)) depth[i]++;
    }
  }
  return depth;
}

/** Unsigned area. Open shapes (arc, open polyline, point) have no area and return 0. */
export function area(g: Geometry): number {
  switch (g.type) {
    case 'circle':
      return Math.PI * g.r * g.r;
    case 'rect':
      return Math.abs(g.w * g.h);
    case 'ellipse':
      return Math.PI * Math.abs(g.rx * g.ry);
    case 'polyline':
      return g.closed ? Math.abs(signedArea(g.pts)) : 0;
    case 'multipolygon': {
      const depths = ringDepths(g.rings);
      let total = 0;
      g.rings.forEach((r, i) => {
        const a = Math.abs(signedArea(r));
        total += depths[i] % 2 === 0 ? a : -a;
      });
      return Math.max(0, total);
    }
    default:
      return 0;
  }
}

/**
 * Boundary length: circumference, rectangle and ellipse perimeters, closed polyline and multipolygon
 * boundary length (all rings). For open shapes (arc, open polyline) this is the curve length.
 */
export function perimeter(g: Geometry): number {
  switch (g.type) {
    case 'circle':
      return TAU * Math.abs(g.r);
    case 'arc':
      return Math.abs(g.r) * ccwSweep(g.a0, g.a1);
    case 'rect':
      return 2 * (Math.abs(g.w) + Math.abs(g.h));
    case 'ellipse':
      return ellipsePerimeter(g.rx, g.ry);
    case 'polyline':
      return polylineLength(g.pts, g.closed);
    case 'multipolygon':
      return g.rings.reduce((s, r) => s + polylineLength(r, true), 0);
    default:
      return 0;
  }
}

/** Curve length of any shape (for closed shapes this equals the perimeter). */
export function length(g: Geometry): number {
  return perimeter(g);
}

/** Length centroid of a path (bulge arcs use the exact arc centroid). */
function lengthCentroid(pts: readonly Vertex[], closed: boolean): Pt {
  const n = pts.length;
  if (n === 0) return { x: NaN, y: NaN };
  const ox = pts[0].x;
  const oy = pts[0].y;
  const segs = closed ? n : n - 1;
  let L = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < segs; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const b = p.bulge ?? 0;
    const l = segmentLength(p, q, b);
    if (l === 0) continue;
    let cx = (p.x + q.x) / 2 - ox;
    let cy = (p.y + q.y) / 2 - oy;
    if (b) {
      const u = arcCentroidFraction(Math.abs(2 * Math.atan(b)));
      cx += (((q.y - p.y) * b) / 2) * u;
      cy -= (((q.x - p.x) * b) / 2) * u;
    }
    L += l;
    mx += l * cx;
    my += l * cy;
  }
  if (L === 0) return { x: ox, y: oy };
  return { x: ox + mx / L, y: oy + my / L };
}

/** Area centroid of rings combined with signs (+1 outer, −1 hole); null when the area is degenerate. */
function ringsCentroid(rings: readonly (readonly Vertex[])[], signs: readonly number[]): Pt | null {
  const first = rings.find((r) => r.length > 0);
  if (!first) return null;
  const ox = first[0].x;
  const oy = first[0].y;
  let A = 0;
  let Mx = 0;
  let My = 0;
  let scale = 0;
  rings.forEach((r, i) => {
    const m = ringMoments(r, ox, oy);
    const k = (m.a < 0 ? -1 : 1) * signs[i];
    A += k * m.a;
    Mx += k * m.mx;
    My += k * m.my;
    scale = Math.max(scale, polylineLength(r, true));
  });
  if (!(Math.abs(A) > 1e-14 * scale * scale)) return null;
  return { x: ox + Mx / A, y: oy + My / A };
}

/**
 * Centroid: area centroid for closed shapes (exact with bulge segments), length centroid for open
 * polylines and arcs, the point itself for points.
 */
export function centroid(g: Geometry): Pt {
  switch (g.type) {
    case 'point':
      return { x: g.p.x, y: g.p.y };
    case 'circle':
    case 'rect':
    case 'ellipse':
      return { x: g.c.x, y: g.c.y };
    case 'arc': {
      const sweep = ccwSweep(g.a0, g.a1);
      const half = sweep / 2;
      const mid = g.a0 + half;
      const d = (Math.abs(g.r) * Math.sin(half)) / half;
      return { x: g.c.x + d * Math.cos(mid), y: g.c.y + d * Math.sin(mid) };
    }
    case 'polyline':
      if (g.closed) return ringsCentroid([g.pts], [1]) ?? lengthCentroid(g.pts, true);
      return lengthCentroid(g.pts, false);
    case 'multipolygon': {
      const depths = ringDepths(g.rings);
      const c = ringsCentroid(
        g.rings,
        depths.map((d) => (d % 2 === 0 ? 1 : -1)),
      );
      if (c) return c;
      const all = g.rings.flat();
      return lengthCentroid(all, false);
    }
  }
}

function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function extend(b: Bounds, x: number, y: number): void {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
}

const AXIS_ANGLES = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

/** Extends `b` by the CCW arc from a0 with the given sweep (> 0). */
function extendArc(b: Bounds, c: Pt, r: number, a0: number, a1: number): void {
  extend(b, c.x + r * Math.cos(a0), c.y + r * Math.sin(a0));
  extend(b, c.x + r * Math.cos(a1), c.y + r * Math.sin(a1));
  for (const k of AXIS_ANGLES) {
    if (angleInArc(k, a0, a1, 0)) extend(b, c.x + r * Math.cos(k), c.y + r * Math.sin(k));
  }
}

/** Exact bounds of a polyline including bulge arcs. */
export function polylineBounds(pts: readonly Vertex[], closed: boolean, out: Bounds = emptyBounds()): Bounds {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    extend(out, p.x, p.y);
    if (!p.bulge || (!closed && i === n - 1)) continue;
    const q = pts[(i + 1) % n];
    const arc = bulgeToArc(p, q, p.bulge);
    if (!arc) continue;
    for (const k of AXIS_ANGLES) {
      const inArc = arc.ccw ? angleInArc(k, arc.a0, arc.a1, 0) : angleInArc(k, arc.a1, arc.a0, 0);
      if (inArc) extend(out, arc.c.x + arc.r * Math.cos(k), arc.c.y + arc.r * Math.sin(k));
    }
  }
  return out;
}

/** Exact axis-aligned bounds (arcs, bulges, rotated rectangles and ellipses included). */
export function bounds(g: Geometry): Bounds {
  switch (g.type) {
    case 'point':
      return { minX: g.p.x, minY: g.p.y, maxX: g.p.x, maxY: g.p.y };
    case 'circle': {
      const r = Math.abs(g.r);
      return { minX: g.c.x - r, minY: g.c.y - r, maxX: g.c.x + r, maxY: g.c.y + r };
    }
    case 'arc': {
      const b = emptyBounds();
      const sweep = ccwSweep(g.a0, g.a1);
      extendArc(b, g.c, Math.abs(g.r), g.a0, g.a0 + sweep);
      return b;
    }
    case 'rect': {
      const c = Math.cos(g.rot);
      const s = Math.sin(g.rot);
      const hw = Math.abs(g.w) / 2;
      const hh = Math.abs(g.h) / 2;
      const hx = Math.abs(hw * c) + Math.abs(hh * s);
      const hy = Math.abs(hw * s) + Math.abs(hh * c);
      return { minX: g.c.x - hx, minY: g.c.y - hy, maxX: g.c.x + hx, maxY: g.c.y + hy };
    }
    case 'ellipse': {
      const c = Math.cos(g.rot);
      const s = Math.sin(g.rot);
      const hx = Math.hypot(g.rx * c, g.ry * s);
      const hy = Math.hypot(g.rx * s, g.ry * c);
      return { minX: g.c.x - hx, minY: g.c.y - hy, maxX: g.c.x + hx, maxY: g.c.y + hy };
    }
    case 'polyline':
      return polylineBounds(g.pts, g.closed);
    case 'multipolygon': {
      const b = emptyBounds();
      for (const r of g.rings) polylineBounds(r, true, b);
      return b;
    }
  }
}

/**
 * Radius where meaningful: circles, arcs, circular ellipses (rx = ry) and polylines made only of arcs
 * sharing one centre and radius (e.g. a circle stored as a two-vertex bulge polyline). Otherwise null.
 */
export function radiusOf(g: Geometry): number | null {
  switch (g.type) {
    case 'circle':
    case 'arc':
      return Math.abs(g.r);
    case 'ellipse': {
      const a = Math.abs(g.rx);
      const b = Math.abs(g.ry);
      return Math.abs(a - b) <= 1e-12 * Math.max(a, b) ? a : null;
    }
    case 'polyline':
      return commonArcRadius(g.pts, g.closed);
    case 'multipolygon':
      return g.rings.length === 1 ? commonArcRadius(g.rings[0], true) : null;
    default:
      return null;
  }
}

function commonArcRadius(pts: readonly Vertex[], closed: boolean): number | null {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  if (segs < 1) return null;
  let ref: { c: Pt; r: number } | null = null;
  for (let i = 0; i < segs; i++) {
    const p = pts[i];
    const arc = p.bulge ? bulgeToArc(p, pts[(i + 1) % n], p.bulge) : null;
    if (!arc) return null;
    if (!ref) {
      ref = arc;
      continue;
    }
    const tol = 1e-9 * Math.max(1, ref.r);
    if (Math.abs(arc.r - ref.r) > tol || Math.hypot(arc.c.x - ref.c.x, arc.c.y - ref.c.y) > tol) return null;
  }
  return ref ? ref.r : null;
}

/** Diameter (2 × radiusOf) or null. */
export function diameterOf(g: Geometry): number | null {
  const r = radiusOf(g);
  return r === null ? null : 2 * r;
}
