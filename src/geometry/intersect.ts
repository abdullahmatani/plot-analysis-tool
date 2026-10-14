import type { Pt } from '@/core/types';
import {
  arcEnd,
  arcStart,
  arcSweep,
  ellipseMinor,
  ellipsePoint,
  ellipseSweep,
  inSpan,
  primBounds,
  spanParam,
  type EllipsePrim,
  type Prim,
} from './prims';
import { TAU } from './vec';

/**
 * Intersections between primitives.
 *
 * All computations are done relative to a point of one of the inputs (never with absolute
 * coordinates in products), so plant/UTM-sized coordinates keep sub-micrometre precision (NFR-7).
 * When an intersection falls within tolerance of a stored endpoint, that endpoint is returned
 * unchanged so intersection snaps at shared corners reproduce source coordinates exactly.
 */

export interface Hit {
  p: Pt;
  /** Normalised parameter on the first primitive (see primPointAt). */
  ta: number;
  /** Normalised parameter on the second primitive. */
  tb: number;
}

/** Default geometric tolerance for a set of primitives: 1e-9 of their size, floored by float precision. */
export function primsTolerance(...prims: Prim[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of prims) {
    const b = primBounds(p);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (!Number.isFinite(minX)) return 1e-12;
  const size = Math.max(maxX - minX, maxY - minY);
  const mag = Math.max(Math.abs(minX), Math.abs(minY), Math.abs(maxX), Math.abs(maxY));
  return Math.max(1e-9 * size, 4e-15 * mag, 1e-12);
}

const copy = (p: Pt): Pt => ({ x: p.x, y: p.y });
const near = (a: Pt, b: Pt, tol: number) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * Intersection of the infinite lines through a1–a2 and b1–b2, or null when they are parallel
 * (or either is degenerate). Axis-aligned inputs give exact coordinates on the aligned axis.
 */
export function intersectInfiniteLines(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const rx = a2.x - a1.x;
  const ry = a2.y - a1.y;
  const sx = b2.x - b1.x;
  const sy = b2.y - b1.y;
  const den = rx * sy - ry * sx;
  const lr = Math.hypot(rx, ry);
  const ls = Math.hypot(sx, sy);
  if (lr === 0 || ls === 0 || Math.abs(den) <= 1e-14 * lr * ls) return null;
  const qx = b1.x - a1.x;
  const qy = b1.y - a1.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  // Average the two parametric estimates (each exact along its own line) for symmetry.
  let x = (a1.x + rx * t + (b1.x + sx * u)) / 2;
  let y = (a1.y + ry * t + (b1.y + sy * u)) / 2;
  if (ry === 0) y = a1.y;
  else if (sy === 0) y = b1.y;
  if (rx === 0) x = a1.x;
  else if (sx === 0) x = b1.x;
  return { x, y };
}

function pointOnSeg(p: Pt, a: Pt, b: Pt, tol: number): number | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const rr = rx * rx + ry * ry;
  const qx = p.x - a.x;
  const qy = p.y - a.y;
  if (rr === 0) return Math.hypot(qx, qy) <= tol ? 0 : null;
  const t = clamp01((qx * rx + qy * ry) / rr);
  const dx = qx - rx * t;
  const dy = qy - ry * t;
  return Math.hypot(dx, dy) <= tol ? t : null;
}

/** Segment–segment intersection, including collinear overlaps (overlap ends are returned). */
export function intersectSegSeg(a: Pt, b: Pt, c: Pt, d: Pt, tol: number): Hit[] {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const lr = Math.hypot(rx, ry);
  const ls = Math.hypot(sx, sy);
  if (lr === 0 || ls === 0) {
    if (lr === 0) {
      const u = pointOnSeg(a, c, d, tol);
      return u === null ? [] : [{ p: copy(a), ta: 0, tb: u }];
    }
    const t = pointOnSeg(c, a, b, tol);
    return t === null ? [] : [{ p: copy(c), ta: t, tb: 0 }];
  }
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const den = rx * sy - ry * sx;
  // Signed distances of c and d from line ab, and of a and b from line cd.
  const dc = (rx * qy - ry * qx) / lr;
  const dd = (rx * (d.y - a.y) - ry * (d.x - a.x)) / lr;
  const da = (sx * -qy - sy * -qx) / ls;
  const db = (sx * (b.y - c.y) - sy * (b.x - c.x)) / ls;
  const collinear =
    (Math.abs(dc) <= tol && Math.abs(dd) <= tol) || (Math.abs(da) <= tol && Math.abs(db) <= tol);
  if (collinear) {
    const hits: Hit[] = [];
    const push = (h: Hit) => {
      if (!hits.some((o) => near(o.p, h.p, tol))) hits.push(h);
    };
    const ta0 = pointOnSeg(a, c, d, tol);
    if (ta0 !== null) push({ p: copy(a), ta: 0, tb: ta0 });
    const ta1 = pointOnSeg(b, c, d, tol);
    if (ta1 !== null) push({ p: copy(b), ta: 1, tb: ta1 });
    const tc = pointOnSeg(c, a, b, tol);
    if (tc !== null) push({ p: copy(c), ta: tc, tb: 0 });
    const td = pointOnSeg(d, a, b, tol);
    if (td !== null) push({ p: copy(d), ta: td, tb: 1 });
    return hits;
  }
  if (Math.abs(den) <= 1e-14 * lr * ls) return [];
  let t = (qx * sy - qy * sx) / den;
  let u = (qx * ry - qy * rx) / den;
  const tolT = tol / lr;
  const tolU = tol / ls;
  if (t < -tolT || t > 1 + tolT || u < -tolU || u > 1 + tolU) return [];
  let p: Pt;
  if (Math.abs(t) <= tolT) {
    t = 0;
    p = copy(a);
  } else if (Math.abs(t - 1) <= tolT) {
    t = 1;
    p = copy(b);
  } else if (Math.abs(u) <= tolU) {
    u = 0;
    p = copy(c);
  } else if (Math.abs(u - 1) <= tolU) {
    u = 1;
    p = copy(d);
  } else {
    p = { x: a.x + rx * t, y: a.y + ry * t };
  }
  // Exact endpoint coincidence on the other primitive as well.
  if (u !== 0 && u !== 1) {
    if (near(p, c, tol)) u = 0;
    else if (near(p, d, tol)) u = 1;
  }
  return [{ p, ta: clamp01(t), tb: clamp01(u) }];
}

interface CircleLike {
  c: Pt;
  r: number;
  /** Start angle and CCW sweep (2π for full circles). */
  start: number;
  sweep: number;
  /** Exact endpoints (arcs only). */
  ends: Pt[];
}

function circleLike(p: Extract<Prim, { k: 'arc' | 'circle' }>): CircleLike {
  if (p.k === 'circle') return { c: p.c, r: p.r, start: 0, sweep: TAU, ends: [] };
  return { c: p.c, r: p.r, start: p.a0, sweep: arcSweep(p), ends: [arcStart(p), arcEnd(p)] };
}

function circleParam(cl: CircleLike, angle: number): number {
  return spanParam(angle, cl.start, cl.sweep);
}

/** Replaces p by an exact endpoint of `cl` when within tolerance; returns the endpoint index or -1. */
function snapEnds(p: Pt, ends: Pt[], tol: number): { p: Pt; end: number } {
  for (let i = 0; i < ends.length; i++) if (near(p, ends[i], tol)) return { p: copy(ends[i]), end: i };
  return { p, end: -1 };
}

function segCircle(a: Pt, b: Pt, cl: CircleLike, tol: number): Hit[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const fx = a.x - cl.c.x;
  const fy = a.y - cl.c.y;
  if (L2 === 0) {
    const d = Math.hypot(fx, fy);
    if (Math.abs(d - cl.r) > tol) return [];
    const ang = Math.atan2(fy, fx);
    if (!inSpan(ang, cl.start, cl.sweep, tol / Math.max(cl.r, 1e-300))) return [];
    return [{ p: copy(a), ta: 0, tb: circleParam(cl, ang) }];
  }
  const L = Math.sqrt(L2);
  const tm = -(fx * dx + fy * dy) / L2;
  const mx = fx + tm * dx;
  const my = fy + tm * dy;
  const m = Math.hypot(mx, my);
  if (m > cl.r + tol) return [];
  let ts: number[];
  if (cl.r - m <= tol) ts = [tm];
  else {
    const h = Math.sqrt((cl.r - m) * (cl.r + m)) / L;
    ts = [tm - h, tm + h];
  }
  const tolT = tol / L;
  const angTol = tol / Math.max(cl.r, 1e-300);
  const out: Hit[] = [];
  for (let t of ts) {
    if (t < -tolT || t > 1 + tolT) continue;
    let p: Pt;
    if (Math.abs(t) <= tolT) {
      t = 0;
      p = copy(a);
    } else if (Math.abs(t - 1) <= tolT) {
      t = 1;
      p = copy(b);
    } else p = { x: a.x + dx * t, y: a.y + dy * t };
    const ang = Math.atan2(p.y - cl.c.y, p.x - cl.c.x);
    if (!inSpan(ang, cl.start, cl.sweep, angTol)) continue;
    const s = snapEnds(p, cl.ends, tol);
    let tb = circleParam(cl, ang);
    if (s.end >= 0) {
      tb = s.end;
      if (t !== 0 && t !== 1) p = s.p;
    }
    if (!out.some((o) => near(o.p, p, tol))) out.push({ p, ta: clamp01(t), tb });
  }
  return out;
}

function circleCircle(c1: CircleLike, c2: CircleLike, tol: number): Hit[] {
  const dx = c2.c.x - c1.c.x;
  const dy = c2.c.y - c1.c.y;
  const D = Math.hypot(dx, dy);
  const out: Hit[] = [];
  const push = (p: Pt) => {
    const a1 = Math.atan2(p.y - c1.c.y, p.x - c1.c.x);
    const a2 = Math.atan2(p.y - c2.c.y, p.x - c2.c.x);
    if (!inSpan(a1, c1.start, c1.sweep, tol / c1.r) || !inSpan(a2, c2.start, c2.sweep, tol / c2.r)) return;
    let q = p;
    let ta = circleParam(c1, a1);
    let tb = circleParam(c2, a2);
    const s1 = snapEnds(q, c1.ends, tol);
    if (s1.end >= 0) {
      q = s1.p;
      ta = s1.end;
    }
    const s2 = snapEnds(q, c2.ends, tol);
    if (s2.end >= 0) {
      if (s1.end < 0) q = s2.p;
      tb = s2.end;
    }
    if (!out.some((o) => near(o.p, q, tol))) out.push({ p: q, ta, tb });
  };
  if (D <= tol) {
    if (Math.abs(c1.r - c2.r) > tol) return [];
    // Co-circular: overlap ends are the arc endpoints lying on the other arc.
    for (const e of c1.ends) push(e);
    for (const e of c2.ends) push(e);
    return out;
  }
  if (D > c1.r + c2.r + tol || D < Math.abs(c1.r - c2.r) - tol) return [];
  const a = (D * D + c1.r * c1.r - c2.r * c2.r) / (2 * D);
  const ux = dx / D;
  const uy = dy / D;
  const tangent = Math.abs(D - (c1.r + c2.r)) <= tol || Math.abs(D - Math.abs(c1.r - c2.r)) <= tol;
  const h2 = c1.r * c1.r - a * a;
  if (tangent || h2 <= 0) {
    const ac = Math.max(-c1.r, Math.min(c1.r, a));
    push({ x: c1.c.x + ux * ac, y: c1.c.y + uy * ac });
    return out;
  }
  const h = Math.sqrt(h2);
  const bx = c1.c.x + ux * a;
  const by = c1.c.y + uy * a;
  push({ x: bx - uy * h, y: by + ux * h });
  push({ x: bx + uy * h, y: by - ux * h });
  return out;
}

/** Affine frame mapping an ellipse onto the unit circle: q ↦ ((q−c)·M/|M|², (q−c)·N/|N|²). */
interface EllFrame {
  c: Pt;
  mx: number;
  my: number;
  nx: number;
  ny: number;
  /** 1/|M|², 1/|N|² */
  im: number;
  inn: number;
  /** Smallest semi-axis (for converting tolerances). */
  minAxis: number;
}

function ellFrame(e: EllipsePrim): EllFrame {
  const n = ellipseMinor(e);
  const mm = e.major.x * e.major.x + e.major.y * e.major.y;
  const nn = n.x * n.x + n.y * n.y;
  return {
    c: e.c,
    mx: e.major.x,
    my: e.major.y,
    nx: n.x,
    ny: n.y,
    im: 1 / mm,
    inn: 1 / nn,
    minAxis: Math.sqrt(Math.min(mm, nn)),
  };
}

function toFrame(f: EllFrame, p: Pt): Pt {
  const qx = p.x - f.c.x;
  const qy = p.y - f.c.y;
  return { x: (qx * f.mx + qy * f.my) * f.im, y: (qx * f.nx + qy * f.ny) * f.inn };
}

function vecToFrame(f: EllFrame, v: Pt): Pt {
  return { x: (v.x * f.mx + v.y * f.my) * f.im, y: (v.x * f.nx + v.y * f.ny) * f.inn };
}

function ellSpan(e: EllipsePrim) {
  const sweep = ellipseSweep(e);
  const full = sweep >= TAU - 1e-12;
  const ends = full ? [] : [ellipsePoint(e, e.t0), ellipsePoint(e, e.t0 + sweep)];
  return { start: e.t0, sweep, ends };
}

function segEllipse(a: Pt, b: Pt, e: EllipsePrim, tol: number): Hit[] {
  const f = ellFrame(e);
  const span = ellSpan(e);
  const ua = toFrame(f, a);
  const ub = toFrame(f, b);
  const unit: CircleLike = { c: { x: 0, y: 0 }, r: 1, start: span.start, sweep: span.sweep, ends: [] };
  const tolU = tol / f.minAxis;
  const raw = segCircle(ua, ub, unit, tolU);
  const out: Hit[] = [];
  for (const h of raw) {
    let p =
      h.ta === 0
        ? copy(a)
        : h.ta === 1
          ? copy(b)
          : { x: a.x + (b.x - a.x) * h.ta, y: a.y + (b.y - a.y) * h.ta };
    let tb = h.tb;
    const s = snapEnds(p, span.ends, tol);
    if (s.end >= 0) {
      tb = s.end;
      if (h.ta !== 0 && h.ta !== 1) p = s.p;
    }
    if (!out.some((o) => near(o.p, p, tol))) out.push({ p, ta: h.ta, tb });
  }
  return out;
}

/**
 * Roots of |C + U cos t + V sin t|² = 1 for t on the CCW span [start, start + sweep]
 * (the parametric curve mapped into a frame where the other curve is the unit circle).
 * Sign changes are bracketed on a sample grid and refined with safeguarded Newton; double roots
 * (tangencies) are found as near-zero extrema of the function.
 */
function unitCircleParamRoots(
  C: Pt,
  U: Pt,
  V: Pt,
  start: number,
  sweep: number,
  tolU: number,
): number[] | 'coincident' {
  const fAt = (t: number) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = C.x + U.x * c + V.x * s;
    const y = C.y + U.y * c + V.y * s;
    return x * x + y * y - 1;
  };
  const dfAt = (t: number) => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = C.x + U.x * c + V.x * s;
    const y = C.y + U.y * c + V.y * s;
    const dx = -U.x * s + V.x * c;
    const dy = -U.y * s + V.y * c;
    return 2 * (x * dx + y * dy);
  };
  const n = Math.max(16, Math.ceil((sweep / TAU) * 256));
  const ts = new Float64Array(n + 1);
  const fs = new Float64Array(n + 1);
  const ds = new Float64Array(n + 1);
  let maxAbs = 0;
  for (let i = 0; i <= n; i++) {
    ts[i] = start + (sweep * i) / n;
    fs[i] = fAt(ts[i]);
    ds[i] = dfAt(ts[i]);
    maxAbs = Math.max(maxAbs, Math.abs(fs[i]));
  }
  const fTol = 2 * tolU + 1e-14;
  if (maxAbs <= fTol) return 'coincident';
  const roots: number[] = [];
  const refine = (g: (t: number) => number, dg: ((t: number) => number) | null, lo: number, hi: number) => {
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
      if (dg) {
        const d = dg(x);
        if (d !== 0) {
          const nx = x - gx / d;
          if (nx > lo && nx < hi) next = nx;
        }
      }
      if (Math.abs(hi - lo) <= 1e-15 * Math.max(1, Math.abs(x))) return next;
      if (Math.abs(next - x) <= 1e-16 * Math.max(1, Math.abs(x))) return next;
      x = next;
    }
    return x;
  };
  const d2 = (t: number) => {
    const h = 1e-7;
    return (dfAt(t + h) - dfAt(t - h)) / (2 * h);
  };
  const bracket = (lo: number, flo: number, hi: number, fhi: number) => {
    if (flo === 0) roots.push(lo);
    else if (flo * fhi < 0) roots.push(refine(fAt, dfAt, lo, hi));
  };
  for (let i = 0; i < n; i++) {
    if (ds[i] * ds[i + 1] < 0) {
      // An extremum inside the interval: it may be a tangency (double root) or separate two roots.
      const tm = refine(dfAt, d2, ts[i], ts[i + 1]);
      const fm = fAt(tm);
      if (Math.abs(fm) <= fTol) roots.push(tm);
      bracket(ts[i], fs[i], tm, fm);
      bracket(tm, fm, ts[i + 1], fs[i + 1]);
    } else bracket(ts[i], fs[i], ts[i + 1], fs[i + 1]);
  }
  if (fs[n] === 0) roots.push(ts[n]);
  else if (Math.abs(fs[n]) <= fTol) roots.push(ts[n]);
  if (Math.abs(fs[0]) <= fTol && fs[0] !== 0) roots.push(ts[0]);
  roots.sort((p, q) => p - q);
  const out: number[] = [];
  for (const r of roots) if (!out.length || r - out[out.length - 1] > 1e-9 * sweep) out.push(r);
  return out;
}

/** Circle/arc (cl) against ellipse e. ta refers to the circle, tb to the ellipse. */
function circleEllipse(cl: CircleLike, e: EllipsePrim, tol: number): Hit[] {
  const span = ellSpan(e);
  const n = ellipseMinor(e);
  const ir = 1 / cl.r;
  const C = { x: (e.c.x - cl.c.x) * ir, y: (e.c.y - cl.c.y) * ir };
  const U = { x: e.major.x * ir, y: e.major.y * ir };
  const V = { x: n.x * ir, y: n.y * ir };
  const roots = unitCircleParamRoots(C, U, V, span.start, span.sweep, tol * ir);
  const out: Hit[] = [];
  const push = (p: Pt, te: number) => {
    const ang = Math.atan2(p.y - cl.c.y, p.x - cl.c.x);
    if (!inSpan(ang, cl.start, cl.sweep, tol / cl.r)) return;
    let ta = circleParam(cl, ang);
    let tb = te;
    let q = p;
    const s1 = snapEnds(q, cl.ends, tol);
    if (s1.end >= 0) {
      q = s1.p;
      ta = s1.end;
    }
    const s2 = snapEnds(q, span.ends, tol);
    if (s2.end >= 0) {
      if (s1.end < 0) q = s2.p;
      tb = s2.end;
    }
    if (!out.some((o) => near(o.p, q, tol))) out.push({ p: q, ta, tb });
  };
  if (roots === 'coincident') {
    for (const p of cl.ends) {
      const u = toFrame(ellFrame(e), p);
      const t = Math.atan2(u.y, u.x);
      if (inSpan(t, span.start, span.sweep, tol)) push(p, spanParam(t, span.start, span.sweep));
    }
    for (let i = 0; i < span.ends.length; i++) push(span.ends[i], i);
    return out;
  }
  for (const t of roots) push(ellipsePoint(e, t), spanParam(t, span.start, span.sweep));
  return out;
}

function ellipseEllipse(a: EllipsePrim, b: EllipsePrim, tol: number): Hit[] {
  const fa = ellFrame(a);
  const sa = ellSpan(a);
  const sb = ellSpan(b);
  const nb = ellipseMinor(b);
  const C = toFrame(fa, b.c);
  const U = vecToFrame(fa, b.major);
  const V = vecToFrame(fa, nb);
  const tolU = tol / fa.minAxis;
  const roots = unitCircleParamRoots(C, U, V, sb.start, sb.sweep, tolU);
  const out: Hit[] = [];
  const push = (p: Pt, tB: number) => {
    const u = toFrame(fa, p);
    const tA = Math.atan2(u.y, u.x);
    if (!inSpan(tA, sa.start, sa.sweep, tolU)) return;
    let ta = spanParam(tA, sa.start, sa.sweep);
    let tb = tB;
    let q = p;
    const s1 = snapEnds(q, sa.ends, tol);
    if (s1.end >= 0) {
      q = s1.p;
      ta = s1.end;
    }
    const s2 = snapEnds(q, sb.ends, tol);
    if (s2.end >= 0) {
      if (s1.end < 0) q = s2.p;
      tb = s2.end;
    }
    if (!out.some((o) => near(o.p, q, tol))) out.push({ p: q, ta, tb });
  };
  if (roots === 'coincident') {
    for (let i = 0; i < sa.ends.length; i++) {
      const u = toFrame(ellFrame(b), sa.ends[i]);
      const t = Math.atan2(u.y, u.x);
      if (inSpan(t, sb.start, sb.sweep, tolU)) push(sa.ends[i], spanParam(t, sb.start, sb.sweep));
    }
    for (let i = 0; i < sb.ends.length; i++) push(sb.ends[i], i);
    return out;
  }
  for (const t of roots) push(ellipsePoint(b, t), spanParam(t, sb.start, sb.sweep));
  return out;
}

const swap = (hits: Hit[]): Hit[] => hits.map((h) => ({ p: h.p, ta: h.tb, tb: h.ta }));

/**
 * Intersections of two primitives with their normalised parameters. Point primitives never
 * intersect. `tol` defaults to primsTolerance(a, b).
 */
export function intersectPrimsParams(a: Prim, b: Prim, tol = primsTolerance(a, b)): Hit[] {
  if (a.k === 'point' || b.k === 'point') return [];
  if (a.k === 'seg') {
    if (b.k === 'seg') return intersectSegSeg(a.a, a.b, b.a, b.b, tol);
    if (b.k === 'arc' || b.k === 'circle') {
      const cl = circleLike(b);
      return segCircle(a.a, a.b, cl, tol).map((h) => withSegEnds(h, a.a, a.b, tol));
    }
    return segEllipse(a.a, a.b, b, tol);
  }
  if (a.k === 'arc' || a.k === 'circle') {
    const ca = circleLike(a);
    if (b.k === 'seg') return swap(intersectPrimsParams(b, a, tol));
    if (b.k === 'arc' || b.k === 'circle') return circleCircle(ca, circleLike(b), tol);
    return circleEllipse(ca, b, tol);
  }
  // a is an ellipse
  if (b.k === 'ellipse') return ellipseEllipse(a, b, tol);
  return swap(intersectPrimsParams(b, a, tol));
}

/** Seg–circle hits already prefer the segment's exact ends; keep the segment end if both apply. */
function withSegEnds(h: Hit, a: Pt, b: Pt, tol: number): Hit {
  if (h.ta !== 0 && h.ta !== 1) {
    if (near(h.p, a, tol)) return { p: copy(a), ta: 0, tb: h.tb };
    if (near(h.p, b, tol)) return { p: copy(b), ta: 1, tb: h.tb };
  }
  return h;
}

/** Intersection points of two primitives. */
export function intersectPrims(a: Prim, b: Prim, tol?: number): Pt[] {
  return intersectPrimsParams(a, b, tol).map((h) => h.p);
}
