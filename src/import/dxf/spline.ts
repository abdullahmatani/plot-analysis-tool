/**
 * NURBS evaluation (de Boor) and adaptive tessellation for SPLINE entities and HATCH spline edges.
 * All coordinates are flat arrays of (x, y, z) triples; output is a flat (x, y, z) polyline.
 */

export interface SplineData {
  degree: number;
  knots: number[];
  /** Control points, flat x, y, z. */
  ctrl: number[];
  weights: number[] | null;
  /** Fit points, flat x, y, z (used when there are no control points). */
  fit: number[];
  startTangent: [number, number, number] | null;
  endTangent: [number, number, number] | null;
  closed: boolean;
}

/** Maximum points produced for one spline. */
export const MAX_SPLINE_POINTS = 20000;
/** Chord tolerance relative to the control polygon's bounding-box diagonal. */
const REL_TOL = 5e-5;
const MAX_DEPTH = 12;

function bboxDiag(p: number[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
    if (p[i + 2] < minZ) minZ = p[i + 2];
    if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

function clampedUniformKnots(n: number, p: number): number[] {
  const k: number[] = [];
  for (let i = 0; i <= p; i++) k.push(0);
  for (let i = 1; i < n - p; i++) k.push(i);
  for (let i = 0; i <= p; i++) k.push(Math.max(1, n - p));
  return k;
}

class Nurbs {
  private readonly hw: Float64Array; // homogeneous control points (x·w, y·w, z·w, w)
  private readonly d: Float64Array; // de Boor scratch
  readonly t0: number;
  readonly t1: number;

  constructor(
    readonly p: number,
    readonly U: number[],
    ctrl: number[],
    weights: number[] | null,
  ) {
    const n = ctrl.length / 3;
    this.hw = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      const w = weights ? weights[i] : 1;
      this.hw[i * 4] = ctrl[i * 3] * w;
      this.hw[i * 4 + 1] = ctrl[i * 3 + 1] * w;
      this.hw[i * 4 + 2] = ctrl[i * 3 + 2] * w;
      this.hw[i * 4 + 3] = w;
    }
    this.d = new Float64Array((p + 1) * 4);
    this.t0 = U[p];
    this.t1 = U[n];
  }

  private span(t: number): number {
    const U = this.U;
    const n = this.hw.length / 4;
    const p = this.p;
    if (t >= U[n]) {
      let k = n - 1;
      while (k > p && U[k] >= U[k + 1]) k--;
      return k;
    }
    let lo = p;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t < U[mid]) hi = mid;
      else lo = mid;
    }
    return lo;
  }

  /** Evaluates the curve at t into out[o..o+2]. */
  eval(t: number, out: Float64Array, o = 0): void {
    const { p, U, hw, d } = this;
    const k = this.span(t);
    for (let j = 0; j <= p; j++) {
      const src = (j + k - p) * 4;
      d[j * 4] = hw[src];
      d[j * 4 + 1] = hw[src + 1];
      d[j * 4 + 2] = hw[src + 2];
      d[j * 4 + 3] = hw[src + 3];
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const den = U[j + 1 + k - r] - U[j + k - p];
        const a = den === 0 ? 0 : (t - U[j + k - p]) / den;
        const b = 1 - a;
        const q = j * 4;
        const q1 = q - 4;
        d[q] = b * d[q1] + a * d[q];
        d[q + 1] = b * d[q1 + 1] + a * d[q + 1];
        d[q + 2] = b * d[q1 + 2] + a * d[q + 2];
        d[q + 3] = b * d[q1 + 3] + a * d[q + 3];
      }
    }
    const q = p * 4;
    const w = d[q + 3] || 1;
    out[o] = d[q] / w;
    out[o + 1] = d[q + 1] / w;
    out[o + 2] = d[q + 2] / w;
  }
}

function deviation(
  a: Float64Array,
  ao: number,
  m: Float64Array,
  mo: number,
  b: Float64Array,
  bo: number,
): number {
  const dx = b[bo] - a[ao];
  const dy = b[bo + 1] - a[ao + 1];
  const dz = b[bo + 2] - a[ao + 2];
  const px = m[mo] - a[ao];
  const py = m[mo + 1] - a[ao + 1];
  const pz = m[mo + 2] - a[ao + 2];
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 === 0) return Math.hypot(px, py, pz);
  const t = (px * dx + py * dy + pz * dz) / l2;
  return Math.hypot(px - t * dx, py - t * dy, pz - t * dz);
}

/** Tessellates a NURBS curve adaptively. */
export function tessellateNurbs(
  degree: number,
  knots: number[],
  ctrl: number[],
  weights: number[] | null,
  warn?: (msg: string) => void,
): number[] {
  const n = ctrl.length / 3;
  if (n < 2) return ctrl.slice();
  let p = Math.max(1, Math.floor(degree) || 3);
  if (p >= n) p = n - 1;
  let U = knots;
  let valid = U.length === n + p + 1;
  for (let i = 1; valid && i < U.length; i++) if (!(U[i] >= U[i - 1])) valid = false;
  if (valid && !(U[n] > U[p])) valid = false;
  if (!valid) {
    if (knots.length) warn?.('SPLINE with an inconsistent knot vector was evaluated with uniform knots.');
    U = clampedUniformKnots(n, p);
  }
  const W = weights && weights.length === n && weights.every((w) => w > 0) ? weights : null;
  if (p === 1 && !W) return ctrl.slice(); // linear spline: the control polygon itself

  const curve = new Nurbs(p, U, ctrl, W);
  const tol = Math.max(bboxDiag(ctrl) * REL_TOL, 1e-12);
  const out: number[] = [];
  const pa = new Float64Array(3);
  const pb = new Float64Array(3);
  const stack: { t0: number; t1: number; p0: Float64Array; p1: Float64Array; depth: number }[] = [];

  curve.eval(curve.t0, pa);
  out.push(pa[0], pa[1], pa[2]);
  // Distinct knot spans inside the domain.
  const breaks: number[] = [curve.t0];
  for (let i = p + 1; i < n; i++) if (U[i] > breaks[breaks.length - 1] && U[i] < curve.t1) breaks.push(U[i]);
  breaks.push(curve.t1);
  const sub = Math.max(2, p + 1);
  let budget = MAX_SPLINE_POINTS - 1;
  const minPerSpan = Math.max(1, Math.min(sub, Math.floor(budget / (breaks.length - 1))));

  let prev = Float64Array.from(pa);
  for (let s = 0; s + 1 < breaks.length; s++) {
    const a = breaks[s];
    const b = breaks[s + 1];
    for (let k = 1; k <= minPerSpan; k++) {
      const t1 = a + ((b - a) * k) / minPerSpan;
      const t0 = a + ((b - a) * (k - 1)) / minPerSpan;
      const end = new Float64Array(3);
      curve.eval(t1, end);
      // Depth-first refinement keeping output order.
      stack.length = 0;
      stack.push({ t0, t1, p0: prev, p1: end, depth: 0 });
      while (stack.length) {
        const seg = stack.pop()!;
        const tm = (seg.t0 + seg.t1) / 2;
        curve.eval(tm, pb);
        if (seg.depth < MAX_DEPTH && budget > 0 && deviation(seg.p0, 0, pb, 0, seg.p1, 0) > tol) {
          const mid = Float64Array.from(pb);
          // push second half first so the first half is processed first
          stack.push({ t0: tm, t1: seg.t1, p0: mid, p1: seg.p1, depth: seg.depth + 1 });
          stack.push({ t0: seg.t0, t1: tm, p0: seg.p0, p1: mid, depth: seg.depth + 1 });
          budget--;
        } else {
          out.push(seg.p1[0], seg.p1[1], seg.p1[2]);
        }
      }
      prev = end;
    }
  }
  return out;
}

/**
 * Interpolating cubic through fit points (chord-length parameterisation; clamped end tangents when
 * given, natural ends otherwise). Used for SPLINEs defined only by fit points.
 */
export function interpolateFitPoints(
  fit: number[],
  startTan: [number, number, number] | null,
  endTan: [number, number, number] | null,
  closed: boolean,
): number[] {
  const pts = fit.slice();
  let np = pts.length / 3;
  if (closed && np > 2) {
    const dx = pts[0] - pts[(np - 1) * 3];
    const dy = pts[1] - pts[(np - 1) * 3 + 1];
    const dz = pts[2] - pts[(np - 1) * 3 + 2];
    if (Math.hypot(dx, dy, dz) > 0) {
      pts.push(pts[0], pts[1], pts[2]);
      np++;
    }
  }
  if (np < 3) return pts;
  const t = new Float64Array(np);
  for (let i = 1; i < np; i++) {
    const h = Math.hypot(
      pts[i * 3] - pts[i * 3 - 3],
      pts[i * 3 + 1] - pts[i * 3 - 2],
      pts[i * 3 + 2] - pts[i * 3 - 1],
    );
    t[i] = t[i - 1] + (h > 0 ? h : 1e-12);
  }
  const unit = (v: [number, number, number] | null) => {
    if (!v) return null;
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : null;
  };
  const st = unit(startTan);
  const et = unit(endTan);
  const M: Float64Array[] = [];
  for (let dim = 0; dim < 3; dim++) {
    const y = (i: number) => pts[i * 3 + dim];
    const a = new Float64Array(np);
    const b = new Float64Array(np);
    const c = new Float64Array(np);
    const r = new Float64Array(np);
    for (let i = 1; i < np - 1; i++) {
      const h0 = t[i] - t[i - 1];
      const h1 = t[i + 1] - t[i];
      a[i] = h0;
      b[i] = 2 * (h0 + h1);
      c[i] = h1;
      r[i] = 6 * ((y(i + 1) - y(i)) / h1 - (y(i) - y(i - 1)) / h0);
    }
    const h0 = t[1] - t[0];
    const hn = t[np - 1] - t[np - 2];
    if (st) {
      b[0] = 2 * h0;
      c[0] = h0;
      r[0] = 6 * ((y(1) - y(0)) / h0 - st[dim]);
    } else b[0] = 1;
    if (et) {
      a[np - 1] = hn;
      b[np - 1] = 2 * hn;
      r[np - 1] = 6 * (et[dim] - (y(np - 1) - y(np - 2)) / hn);
    } else b[np - 1] = 1;
    // Thomas algorithm
    for (let i = 1; i < np; i++) {
      const w = a[i] / b[i - 1];
      b[i] -= w * c[i - 1];
      r[i] -= w * r[i - 1];
    }
    const m = new Float64Array(np);
    m[np - 1] = r[np - 1] / b[np - 1];
    for (let i = np - 2; i >= 0; i--) m[i] = (r[i] - c[i] * m[i + 1]) / b[i];
    M.push(m);
  }
  const out: number[] = [pts[0], pts[1], pts[2]];
  const steps = Math.max(4, Math.min(64, Math.floor(MAX_SPLINE_POINTS / np)));
  for (let i = 0; i < np - 1; i++) {
    const h = t[i + 1] - t[i];
    for (let k = 1; k <= steps; k++) {
      const u = t[i] + (h * k) / steps;
      const A = t[i + 1] - u;
      const B = u - t[i];
      for (let dim = 0; dim < 3; dim++) {
        const m = M[dim];
        const y0 = pts[i * 3 + dim];
        const y1 = pts[(i + 1) * 3 + dim];
        out.push(
          k === steps
            ? y1
            : (m[i] * A * A * A) / (6 * h) +
                (m[i + 1] * B * B * B) / (6 * h) +
                (y0 / h - (m[i] * h) / 6) * A +
                (y1 / h - (m[i + 1] * h) / 6) * B,
        );
      }
    }
  }
  return out;
}

/** Tessellates a SPLINE definition: control points when present, otherwise fit points. */
export function tessellateSpline(sp: SplineData, warn?: (msg: string) => void): number[] {
  if (sp.ctrl.length >= 6) return tessellateNurbs(sp.degree, sp.knots, sp.ctrl, sp.weights, warn);
  if (sp.fit.length >= 6) return interpolateFitPoints(sp.fit, sp.startTangent, sp.endTangent, sp.closed);
  return [];
}
