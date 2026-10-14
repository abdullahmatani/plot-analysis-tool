/**
 * SPLINE tessellation: NURBS evaluation (de Boor, homogeneous coordinates) with adaptive
 * subdivision, and interpolation through fit points for splines stored only as fit data (AutoCAD
 * "fit" splines in DWG carry no control points). Points are flat (x, y, z) arrays.
 */

export interface SplineDef {
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
/** Chord tolerance relative to the control polygon's diagonal. */
const REL_TOL = 5e-5;
const MAX_DEPTH = 12;

function diagonal(p: number[]): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i + 2 < p.length; i += 3) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
    z0 = Math.min(z0, p[i + 2]);
    z1 = Math.max(z1, p[i + 2]);
  }
  const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  return Number.isFinite(d) ? d : 0;
}

function uniformClampedKnots(n: number, p: number): number[] {
  const k: number[] = [];
  for (let i = 0; i <= p; i++) k.push(0);
  for (let i = 1; i < n - p; i++) k.push(i);
  const end = Math.max(1, n - p);
  for (let i = 0; i <= p; i++) k.push(end);
  return k;
}

/** NURBS curve evaluator (de Boor on homogeneous control points). */
class Curve {
  private readonly hw: Float64Array;
  private readonly tmp: Float64Array;
  readonly lo: number;
  readonly hi: number;

  constructor(
    private readonly p: number,
    private readonly U: number[],
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
    this.tmp = new Float64Array((p + 1) * 4);
    this.lo = U[p];
    this.hi = U[n];
  }

  private span(t: number): number {
    const n = this.hw.length / 4;
    const U = this.U;
    if (t >= U[n]) {
      let k = n - 1;
      while (k > this.p && U[k] >= U[n]) k--;
      return k;
    }
    let a = this.p;
    let b = n;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if (t < U[m]) b = m;
      else a = m;
    }
    return a;
  }

  eval(t: number, out: Float64Array) {
    const p = this.p;
    const U = this.U;
    const k = this.span(t);
    const d = this.tmp;
    for (let j = 0; j <= p; j++) {
      const s = (k - p + j) * 4;
      d[j * 4] = this.hw[s];
      d[j * 4 + 1] = this.hw[s + 1];
      d[j * 4 + 2] = this.hw[s + 2];
      d[j * 4 + 3] = this.hw[s + 3];
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = U[i + p - r + 1] - U[i];
        const a = den > 0 ? (t - U[i]) / den : 0;
        for (let c = 0; c < 4; c++) d[j * 4 + c] = (1 - a) * d[(j - 1) * 4 + c] + a * d[j * 4 + c];
      }
    }
    const w = d[p * 4 + 3] || 1;
    out[0] = d[p * 4] / w;
    out[1] = d[p * 4 + 1] / w;
    out[2] = d[p * 4 + 2] / w;
  }
}

/** Distance of m from the segment a–b (3D). */
function chordDeviation(a: Float64Array, m: Float64Array, b: Float64Array): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const px = m[0] - a[0];
  const py = m[1] - a[1];
  const pz = m[2] - a[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 === 0) return Math.hypot(px, py, pz);
  const t = (px * dx + py * dy + pz * dz) / l2;
  return Math.hypot(px - t * dx, py - t * dy, pz - t * dz);
}

/** Tessellates a NURBS curve adaptively; invalid knot vectors fall back to uniform clamped knots. */
export function tessellateNurbs(
  degree: number,
  knots: number[],
  ctrl: number[],
  weights: number[] | null,
  warn?: (msg: string) => void,
): number[] {
  const n = Math.floor(ctrl.length / 3);
  if (n < 2) return ctrl.slice(0, n * 3);
  let p = Math.max(1, Math.floor(degree) || 3);
  if (p >= n) p = n - 1;
  let U = knots;
  let ok = U.length === n + p + 1 && U.every((v) => Number.isFinite(v));
  for (let i = 1; ok && i < U.length; i++) if (!(U[i] >= U[i - 1])) ok = false;
  if (ok && !(U[n] > U[p])) ok = false;
  if (!ok) {
    if (knots.length) warn?.('SPLINE with an inconsistent knot vector was evaluated with uniform knots.');
    U = uniformClampedKnots(n, p);
  }
  const W =
    weights && weights.length === n && weights.every((w) => w > 0 && Number.isFinite(w)) ? weights : null;
  if (p === 1 && !W) return ctrl.slice(0, n * 3);

  const curve = new Curve(p, U, ctrl, W);
  const tol = Math.max(diagonal(ctrl) * REL_TOL, 1e-12);
  const out: number[] = [];
  const first = new Float64Array(3);
  curve.eval(curve.lo, first);
  out.push(first[0], first[1], first[2]);

  const breaks: number[] = [curve.lo];
  for (let i = p + 1; i < n; i++) if (U[i] > breaks[breaks.length - 1] && U[i] < curve.hi) breaks.push(U[i]);
  breaks.push(curve.hi);
  let budget = MAX_SPLINE_POINTS - 1;
  const perSpan = Math.max(1, Math.min(p + 1, Math.floor(budget / (breaks.length - 1))));
  const mid = new Float64Array(3);
  const stack: { t0: number; t1: number; a: Float64Array; b: Float64Array; depth: number }[] = [];
  let prev = first;
  for (let s = 0; s + 1 < breaks.length; s++) {
    const a = breaks[s];
    const b = breaks[s + 1];
    for (let k = 1; k <= perSpan; k++) {
      const t0 = a + ((b - a) * (k - 1)) / perSpan;
      const t1 = a + ((b - a) * k) / perSpan;
      const end = new Float64Array(3);
      curve.eval(t1, end);
      stack.length = 0;
      stack.push({ t0, t1, a: prev, b: end, depth: 0 });
      while (stack.length) {
        const seg = stack.pop()!;
        const tm = (seg.t0 + seg.t1) / 2;
        curve.eval(tm, mid);
        if (seg.depth < MAX_DEPTH && budget > 0 && chordDeviation(seg.a, mid, seg.b) > tol) {
          const m = Float64Array.from(mid);
          stack.push({ t0: tm, t1: seg.t1, a: m, b: seg.b, depth: seg.depth + 1 });
          stack.push({ t0: seg.t0, t1: tm, a: seg.a, b: m, depth: seg.depth + 1 });
          budget--;
        } else {
          out.push(seg.b[0], seg.b[1], seg.b[2]);
        }
      }
      prev = end;
    }
  }
  return out;
}

function unit(v: [number, number, number] | null): [number, number, number] | null {
  if (!v) return null;
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

/**
 * C2 cubic through the fit points (chord-length parameterisation). Given end tangents are used as
 * clamped end conditions, otherwise natural ends; closed curves are made periodic-looking by
 * repeating the first point.
 */
export function interpolateFitPoints(
  fit: number[],
  startTangent: [number, number, number] | null,
  endTangent: [number, number, number] | null,
  closed: boolean,
): number[] {
  const pts = fit.slice(0, Math.floor(fit.length / 3) * 3);
  let np = pts.length / 3;
  if (closed && np > 2) {
    const l = np - 1;
    if (Math.hypot(pts[0] - pts[l * 3], pts[1] - pts[l * 3 + 1], pts[2] - pts[l * 3 + 2]) > 0) {
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
  const st = unit(startTangent);
  const et = unit(endTangent);
  // Second derivatives per dimension (tridiagonal system, Thomas algorithm).
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
      if (k === steps) {
        out.push(pts[(i + 1) * 3], pts[(i + 1) * 3 + 1], pts[(i + 1) * 3 + 2]);
        continue;
      }
      const u = t[i] + (h * k) / steps;
      const A = t[i + 1] - u;
      const B = u - t[i];
      for (let dim = 0; dim < 3; dim++) {
        const m = M[dim];
        const y0 = pts[i * 3 + dim];
        const y1 = pts[(i + 1) * 3 + dim];
        out.push(
          (m[i] * A * A * A) / (6 * h) +
            (m[i + 1] * B * B * B) / (6 * h) +
            (y0 / h - (m[i] * h) / 6) * A +
            (y1 / h - (m[i + 1] * h) / 6) * B,
        );
      }
    }
  }
  return out;
}

/** Tessellates a spline: control points when present, otherwise fit points. */
export function tessellateSpline(sp: SplineDef, warn?: (msg: string) => void): number[] {
  if (sp.ctrl.length >= 6) return tessellateNurbs(sp.degree, sp.knots, sp.ctrl, sp.weights, warn);
  if (sp.fit.length >= 6) return interpolateFitPoints(sp.fit, sp.startTangent, sp.endTangent, sp.closed);
  return [];
}
