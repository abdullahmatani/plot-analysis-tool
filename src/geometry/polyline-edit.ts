import type { Pt, Vertex } from '@/core/types';
import { bulgeToArc } from './bulge';
import { TAU, normAngle } from './vec';

/**
 * Pure editing operations on bulge polylines (FDR row 53). Inputs are never mutated; outputs are
 * fresh vertex objects that keep the input numbers exactly wherever a vertex is unchanged.
 *
 * Bulge semantics: `pts[i].bulge` describes the segment from pts[i] to pts[i + 1] (wrapping to
 * pts[0] on closed polylines). The last vertex of an open polyline carries no segment.
 */

export interface Poly {
  pts: Vertex[];
  closed: boolean;
}

const vtx = (p: Pt, bulge = 0): Vertex => (bulge ? { x: p.x, y: p.y, bulge } : { x: p.x, y: p.y });
const clone = (v: Vertex): Vertex => vtx(v, v.bulge ?? 0);

/** Number of segments of a polyline. */
export function segmentCount(poly: Poly): number {
  const n = poly.pts.length;
  return poly.closed ? (n > 1 ? n : 0) : Math.max(0, n - 1);
}

/** Signed included angle of a bulge segment. */
const bulgeAngle = (b: number) => 4 * Math.atan(b);

/**
 * Point on segment `index` at parameter t (linear along lines, angular along arcs), and the bulges
 * of the two sub-segments obtained by splitting there.
 */
export function pointOnSegment(poly: Poly, index: number, t: number): { p: Pt; b1: number; b2: number } {
  const n = poly.pts.length;
  const a = poly.pts[index];
  const b = poly.pts[(index + 1) % n];
  const bulge = a.bulge ?? 0;
  const arc = bulge ? bulgeToArc(a, b, bulge) : null;
  if (!arc) return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, b1: 0, b2: 0 };
  const ang = arc.a0 + arc.sweep * t;
  return {
    p: { x: arc.c.x + arc.r * Math.cos(ang), y: arc.c.y + arc.r * Math.sin(ang) },
    b1: Math.tan((arc.sweep * t) / 4),
    b2: Math.tan((arc.sweep * (1 - t)) / 4),
  };
}

/** Parameter of point p projected onto segment `index` (clamped to [0, 1]). */
function segmentParam(poly: Poly, index: number, p: Pt): number {
  const n = poly.pts.length;
  const a = poly.pts[index];
  const b = poly.pts[(index + 1) % n];
  const bulge = a.bulge ?? 0;
  const arc = bulge ? bulgeToArc(a, b, bulge) : null;
  if (!arc) {
    const rx = b.x - a.x;
    const ry = b.y - a.y;
    const rr = rx * rx + ry * ry;
    if (rr === 0) return 0;
    return Math.min(1, Math.max(0, ((p.x - a.x) * rx + (p.y - a.y) * ry) / rr));
  }
  const ang = Math.atan2(p.y - arc.c.y, p.x - arc.c.x);
  const abs = Math.abs(arc.sweep);
  const rel = arc.sweep > 0 ? normAngle(ang - arc.a0) : normAngle(arc.a0 - ang);
  if (rel <= abs) return rel / abs;
  return rel - abs < TAU - rel ? 1 : 0;
}

/** Nearest location on a polyline: segment index, parameter, point and distance. */
export function locateOnPolyline(
  poly: Poly,
  p: Pt,
): { index: number; t: number; pt: Pt; dist: number } | null {
  const m = segmentCount(poly);
  let best: { index: number; t: number; pt: Pt; dist: number } | null = null;
  for (let i = 0; i < m; i++) {
    const t = segmentParam(poly, i, p);
    const pt =
      t === 0
        ? vtx(poly.pts[i])
        : t === 1
          ? vtx(poly.pts[(i + 1) % poly.pts.length])
          : pointOnSegment(poly, i, t).p;
    const dist = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (!best || dist < best.dist) best = { index: i, t, pt, dist };
  }
  return best;
}

/**
 * Inserts point p on segment `segIndex` (between pts[segIndex] and the next vertex). On an arc the
 * arc is split at p's angular position so both halves stay on the original circle when p lies on it.
 */
export function insertVertex(poly: Poly, segIndex: number, p: Pt): Poly {
  if (segIndex < 0 || segIndex >= segmentCount(poly))
    throw new RangeError(`segment ${segIndex} out of range`);
  const pts = poly.pts.map(clone);
  const a = pts[segIndex];
  const bulge = a.bulge ?? 0;
  let b2 = 0;
  if (bulge) {
    const t = segmentParam(poly, segIndex, p);
    const s = pointOnSegment(poly, segIndex, t);
    pts[segIndex] = vtx(a, s.b1);
    b2 = s.b2;
  }
  pts.splice(segIndex + 1, 0, vtx(p, b2));
  return { pts, closed: poly.closed };
}

function sameCircle(a: Pt, b: Pt, c: Pt, b1: number, b2: number): boolean {
  const arc1 = bulgeToArc(a, b, b1);
  const arc2 = bulgeToArc(b, c, b2);
  if (!arc1 || !arc2 || Math.sign(b1) !== Math.sign(b2)) return false;
  const tol = 1e-9 * Math.max(arc1.r, arc2.r);
  return (
    Math.abs(arc1.r - arc2.r) <= tol &&
    Math.abs(arc1.c.x - arc2.c.x) <= tol &&
    Math.abs(arc1.c.y - arc2.c.y) <= tol
  );
}

/**
 * Removes vertex i. The neighbouring segments merge into one: an exact arc when both were arcs of
 * the same circle and direction, otherwise a straight segment. Returns null when fewer than two
 * vertices would remain.
 */
export function removeVertex(poly: Poly, i: number): Poly | null {
  const n = poly.pts.length;
  if (i < 0 || i >= n) throw new RangeError(`vertex ${i} out of range`);
  if (n - 1 < 2) return null;
  const pts = poly.pts.map(clone);
  if (!poly.closed && i === 0) return { pts: pts.slice(1), closed: false };
  if (!poly.closed && i === n - 1) {
    const out = pts.slice(0, n - 1);
    out[out.length - 1] = vtx(out[out.length - 1]);
    return { pts: out, closed: false };
  }
  const prev = (i - 1 + n) % n;
  const next = (i + 1) % n;
  const b1 = pts[prev].bulge ?? 0;
  const b2 = pts[i].bulge ?? 0;
  let merged = 0;
  if (b1 && b2 && sameCircle(pts[prev], pts[i], pts[next], b1, b2)) {
    const sweep = bulgeAngle(b1) + bulgeAngle(b2);
    if (Math.abs(sweep) < TAU - 1e-9) merged = Math.tan(sweep / 4);
  }
  pts[prev] = vtx(pts[prev], merged);
  pts.splice(i, 1);
  return { pts, closed: poly.closed };
}

/**
 * Moves vertex i to p. Adjacent arcs keep their bulge, i.e. their included angle: the arc shape is
 * preserved (scaled and rotated onto the new chord).
 */
export function moveVertex(poly: Poly, i: number, p: Pt): Poly {
  if (i < 0 || i >= poly.pts.length) throw new RangeError(`vertex ${i} out of range`);
  const pts = poly.pts.map(clone);
  pts[i] = vtx(p, poly.pts[i].bulge ?? 0);
  return { pts, closed: poly.closed };
}

/**
 * Reverses the direction. Bulges are negated and moved to the vertex that now starts their
 * segment. Closed polylines keep their first vertex.
 */
export function reversePolyline(poly: Poly): Poly {
  const n = poly.pts.length;
  const src = poly.pts;
  if (n === 0) return { pts: [], closed: poly.closed };
  const pts: Vertex[] = new Array(n);
  if (poly.closed) {
    for (let j = 0; j < n; j++) {
      const v = src[(n - j) % n];
      pts[j] = vtx(v, -(src[(n - j - 1) % n].bulge ?? 0));
    }
  } else {
    for (let j = 0; j < n; j++) {
      const v = src[n - 1 - j];
      pts[j] = vtx(v, j < n - 1 ? -(src[n - 2 - j].bulge ?? 0) : 0);
    }
  }
  return { pts, closed: poly.closed };
}

/**
 * Joins two open polylines at their nearest pair of endpoints (reversing either as needed). The
 * joint keeps the first polyline's vertex coordinates. Returns null when no endpoint pair is within
 * `tol` or either input is closed. The result is closed automatically when its ends meet.
 */
export function joinPolylines(a: Poly, b: Poly, tol: number): Poly | null {
  if (a.closed || b.closed || a.pts.length === 0 || b.pts.length === 0) return null;
  const a0 = a.pts[0];
  const a1 = a.pts[a.pts.length - 1];
  const b0 = b.pts[0];
  const b1 = b.pts[b.pts.length - 1];
  const d = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
  const options: { dist: number; first: () => Poly; second: () => Poly }[] = [
    { dist: d(a1, b0), first: () => a, second: () => b },
    { dist: d(a1, b1), first: () => a, second: () => reversePolyline(b) },
    { dist: d(a0, b0), first: () => reversePolyline(a), second: () => b },
    { dist: d(a0, b1), first: () => b, second: () => a },
  ];
  let best = options[0];
  for (const o of options) if (o.dist < best.dist) best = o;
  if (!(best.dist <= tol)) return null;
  const first = best.first();
  const second = best.second();
  const pts = first.pts.slice(0, -1).map(clone);
  const joint = first.pts[first.pts.length - 1];
  pts.push(vtx(joint, second.pts[0].bulge ?? 0));
  for (let k = 1; k < second.pts.length; k++) pts.push(clone(second.pts[k]));
  const end = pts[pts.length - 1];
  if (pts.length > 2 && d(pts[0], end) <= tol) {
    pts.pop();
    return { pts, closed: true };
  }
  return { pts, closed: false };
}

/**
 * Splits at a vertex index or at a point on a segment ({ index, t }, t along the segment, angular
 * on arcs). Open polylines give two parts (one when splitting at an end); closed polylines open at
 * the split point and give one polyline starting and ending there.
 */
export function splitPolyline(poly: Poly, at: number | { index: number; t: number }): Poly[] {
  const n = poly.pts.length;
  if (typeof at !== 'number') {
    if (at.index < 0 || at.index >= segmentCount(poly))
      throw new RangeError(`segment ${at.index} out of range`);
    if (at.t <= 0) return splitPolyline(poly, at.index);
    if (at.t >= 1) return splitPolyline(poly, (at.index + 1) % n);
    const { p, b1, b2 } = pointOnSegment(poly, at.index, at.t);
    const k = at.index;
    if (!poly.closed) {
      const first = poly.pts.slice(0, k).map(clone);
      first.push(vtx(poly.pts[k], b1), vtx(p));
      const second = [vtx(p, b2), ...poly.pts.slice(k + 1).map(clone)];
      return [
        { pts: first, closed: false },
        { pts: second, closed: false },
      ];
    }
    const pts: Vertex[] = [vtx(p, b2)];
    for (let j = 1; j < n; j++) pts.push(clone(poly.pts[(k + j) % n]));
    pts.push(vtx(poly.pts[k], b1), vtx(p));
    return [{ pts, closed: false }];
  }
  const i = at;
  if (i < 0 || i >= n) throw new RangeError(`vertex ${i} out of range`);
  if (!poly.closed) {
    if (i === 0 || i === n - 1) return [{ pts: poly.pts.map(clone), closed: false }];
    const first = poly.pts.slice(0, i + 1).map(clone);
    first[i] = vtx(first[i]);
    return [
      { pts: first, closed: false },
      { pts: poly.pts.slice(i).map(clone), closed: false },
    ];
  }
  const pts: Vertex[] = [];
  for (let j = 0; j < n; j++) pts.push(clone(poly.pts[(i + j) % n]));
  pts.push(vtx(poly.pts[i]));
  return [{ pts, closed: false }];
}

/** Closes a polyline; a last vertex coinciding with the first (within tol) is dropped. */
export function closePolyline(poly: Poly, tol = 0): Poly {
  const pts = poly.pts.map(clone);
  if (poly.closed) return { pts, closed: true };
  if (pts.length > 2) {
    const f = pts[0];
    const l = pts[pts.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= tol) pts.pop();
  }
  return { pts, closed: true };
}

/**
 * Opens a closed polyline. By default the closing segment is removed; with `keepClosingSegment`
 * the first vertex is repeated at the end so the geometry is unchanged.
 */
export function openPolyline(poly: Poly, keepClosingSegment = false): Poly {
  const pts = poly.pts.map(clone);
  if (!poly.closed || pts.length === 0) return { pts, closed: false };
  if (keepClosingSegment) pts.push(vtx(pts[0]));
  else pts[pts.length - 1] = vtx(pts[pts.length - 1]);
  return { pts, closed: false };
}

/**
 * Bulge of the arc from p0 to p1 passing through m; null when no such arc exists (m collinear with
 * the chord but outside it, or coincident with an end). Returns 0 when m lies on the chord.
 */
export function bulgeThrough(p0: Pt, m: Pt, p1: Pt): number | null {
  const ux = p0.x - m.x;
  const uy = p0.y - m.y;
  const vx = p1.x - m.x;
  const vy = p1.y - m.y;
  if ((ux === 0 && uy === 0) || (vx === 0 && vy === 0)) return null;
  const cr = ux * vy - uy * vx;
  const dt = ux * vx + uy * vy;
  const phi = Math.atan2(Math.abs(cr), dt);
  if (phi < 1e-12) return null;
  const mag = Math.tan((Math.PI - phi) / 2);
  if (cr === 0) return 0;
  // cross(m − p0, p1 − p0) > 0 ⇔ the arc through m runs counter-clockwise.
  const orient = (m.x - p0.x) * (p1.y - p0.y) - (m.y - p0.y) * (p1.x - p0.x);
  return orient > 0 ? mag : -mag;
}

export type SegmentConversion = 'line' | { kind: 'arc'; through: Pt } | { kind: 'arc'; bulge: number };

/** Converts segment `segIndex` to a line or an arc (through a point, or with a given bulge). */
export function convertSegment(poly: Poly, segIndex: number, to: SegmentConversion): Poly | null {
  if (segIndex < 0 || segIndex >= segmentCount(poly))
    throw new RangeError(`segment ${segIndex} out of range`);
  const n = poly.pts.length;
  let bulge: number;
  if (to === 'line') bulge = 0;
  else if ('bulge' in to) bulge = to.bulge;
  else {
    const b = bulgeThrough(poly.pts[segIndex], to.through, poly.pts[(segIndex + 1) % n]);
    if (b === null) return null;
    bulge = b;
  }
  if (!Number.isFinite(bulge)) return null;
  const pts = poly.pts.map(clone);
  pts[segIndex] = vtx(pts[segIndex], bulge);
  return { pts, closed: poly.closed };
}

/**
 * Signed area of a closed bulge polyline (positive = counter-clockwise), computed relative to the
 * first vertex for precision. Open polylines are treated as closed.
 */
export function polylineSignedArea(pts: readonly Vertex[]): number {
  const n = pts.length;
  if (n < 2) return 0;
  const ox = pts[0].x;
  const oy = pts[0].y;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const ax = a.x - ox;
    const ay = a.y - oy;
    const bx = b.x - ox;
    const by = b.y - oy;
    area += (ax * by - ay * bx) / 2;
    const bulge = a.bulge ?? 0;
    if (bulge) {
      const theta = bulgeAngle(bulge);
      const chord = Math.hypot(bx - ax, by - ay);
      if (chord > 0) {
        const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
        area += ((r * r) / 2) * (theta - Math.sin(theta));
      }
    }
  }
  return area;
}
