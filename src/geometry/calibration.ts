import type { Affine2D, Pt } from '@/core/types';

/**
 * Calibration fits: drawing units → world metres (FDR rows 28–31).
 *
 * Transforms use the Affine2D convention [a, b, c, d, e, f]: (x, y) → (a·x + c·y + e, b·x + d·y + f).
 * Point-pair fits centre both point sets on their means before solving, so the normal equations involve
 * only local coordinates; with UTM-sized world coordinates (X 600 000, Y 2 500 000) this keeps the fit at
 * float64 precision (≈ 1e-10 m) instead of losing ~6 digits to cancellation. Residuals are in metres:
 * signed (fitted − real) for distance fits, Euclidean misfit |T(drawing) − world| for point fits.
 */

export interface DistanceRef {
  a: Pt;
  b: Pt;
  /** Real distance in metres. */
  distance: number;
}

export interface PointPair {
  drawing: Pt;
  world: Pt;
}

export interface ResidualReport {
  /** Per reference, metres. */
  residuals: number[];
  rms: number;
  /** Index of the reference with the largest |residual|. */
  worst: number;
}

export interface DistanceScaleFit extends ResidualReport {
  /** Metres per drawing unit. */
  k: number;
  transform: Affine2D;
}

export interface DistanceScaleXYFit extends DistanceScaleFit {
  kx: number;
  ky: number;
}

export interface PointFit extends ResidualReport {
  transform: Affine2D;
  /** Uniform scale (√|det|), metres per drawing unit. */
  scale: number;
  /** Rotation of the drawing x axis in the world, radians CCW. */
  rotation: number;
}

export interface ScaleXYPointFit extends PointFit {
  kx: number;
  ky: number;
}

/** Residual summary; callers guarantee at least one residual. */
function report(residuals: number[]): ResidualReport {
  let ss = 0;
  let worst = -1;
  let worstAbs = -1;
  residuals.forEach((r, i) => {
    ss += r * r;
    if (Math.abs(r) > worstAbs) {
      worstAbs = Math.abs(r);
      worst = i;
    }
  });
  return { residuals, rms: Math.sqrt(ss / residuals.length), worst };
}

const drawingLength = (r: DistanceRef): number => Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y);

/** Metres per drawing unit from two picked points and the real distance between them. */
export function scaleFromTwoPoints(d0: Pt, d1: Pt, realDistanceMetres: number): number {
  const l = Math.hypot(d1.x - d0.x, d1.y - d0.y);
  if (!(l > 0)) throw new Error('The two points coincide');
  if (!(realDistanceMetres > 0) || !Number.isFinite(realDistanceMetres)) {
    throw new Error('The real distance must be a positive number');
  }
  return realDistanceMetres / l;
}

export function uniformScaleTransform(k: number): Affine2D {
  return [k, 0, 0, k, 0, 0];
}

/** Stated-ratio scale (e.g. 1:500 → ratio 500) with the drawing unit's size on paper in metres. */
export function ratioScale(ratio: number, unitToMetres: number): number {
  if (!(ratio > 0) || !(unitToMetres > 0)) throw new Error('Ratio and unit size must be positive');
  return ratio * unitToMetres;
}

/**
 * Transform for a stated ratio: e.g. a 1:500 PDF (1 pt = 0.0254/72 m on paper) → k = (0.0254/72)·500.
 * For CAD drawings pass ratio 1 and the unit-to-metre factor.
 */
export function ratioTransform(ratio: number, unitToMetres: number): Affine2D {
  return uniformScaleTransform(ratioScale(ratio, unitToMetres));
}

/** Least-squares uniform scale over reference distances: k = Σ Dᵢ Rᵢ / Σ Dᵢ² (absolute residuals). */
export function fitDistanceScale(refs: readonly DistanceRef[]): DistanceScaleFit {
  if (refs.length === 0) throw new Error('At least one reference distance is required');
  let sdr = 0;
  let sdd = 0;
  for (const r of refs) {
    if (!(r.distance > 0)) throw new Error('Reference distances must be positive');
    const D = drawingLength(r);
    sdr += D * r.distance;
    sdd += D * D;
  }
  if (!(sdd > 0)) throw new Error('Reference points coincide');
  const k = sdr / sdd;
  return {
    k,
    transform: uniformScaleTransform(k),
    ...report(refs.map((r) => k * drawingLength(r) - r.distance)),
  };
}

/** Solves the symmetric 2×2 system [p q; q s]·x = [u; v]; null when singular. */
function solve2(p: number, q: number, s: number, u: number, v: number): [number, number] | null {
  const det = p * s - q * q;
  if (!(Math.abs(det) > 1e-12 * Math.max(p * s, q * q))) return null;
  return [(s * u - q * v) / det, (p * v - q * u) / det];
}

/**
 * Separate X/Y scale (distorted scans) from reference distances: real = √((kx·dx)² + (ky·dy)²). Starts from
 * the linear least-squares solution in (kx², ky²) and refines with damped Gauss–Newton on the residuals.
 * Needs references in at least two directions.
 */
export function fitDistanceScaleXY(refs: readonly DistanceRef[]): DistanceScaleXYFit {
  const uni = fitDistanceScale(refs);
  const dx2 = refs.map((r) => (r.b.x - r.a.x) ** 2);
  const dy2 = refs.map((r) => (r.b.y - r.a.y) ** 2);
  // Normalise by k² so the linear system is well scaled.
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxr = 0;
  let syr = 0;
  const k2 = uni.k * uni.k;
  refs.forEach((r, i) => {
    const R2 = (r.distance * r.distance) / k2;
    sxx += dx2[i] * dx2[i];
    sxy += dx2[i] * dy2[i];
    syy += dy2[i] * dy2[i];
    sxr += dx2[i] * R2;
    syr += dy2[i] * R2;
  });
  const lin = solve2(sxx, sxy, syy, sxr, syr);
  if (!lin) throw new Error('Separate X/Y scales need reference distances in at least two directions');
  let kx = lin[0] > 0 ? Math.sqrt(lin[0]) * uni.k : uni.k;
  let ky = lin[1] > 0 ? Math.sqrt(lin[1]) * uni.k : uni.k;

  const residualsOf = (ax: number, ay: number): number[] =>
    refs.map((r, i) => Math.sqrt(ax * ax * dx2[i] + ay * ay * dy2[i]) - r.distance);
  const cost = (res: number[]): number => res.reduce((s, v) => s + v * v, 0);
  let res = residualsOf(kx, ky);
  let c = cost(res);
  let lambda = 1e-9;
  for (let iter = 0; iter < 100; iter++) {
    let jxx = 0;
    let jxy = 0;
    let jyy = 0;
    let gx = 0;
    let gy = 0;
    refs.forEach((_, i) => {
      const f = res[i] + refs[i].distance;
      if (!(f > 0)) return;
      const jx = (kx * dx2[i]) / f;
      const jy = (ky * dy2[i]) / f;
      jxx += jx * jx;
      jxy += jx * jy;
      jyy += jy * jy;
      gx += jx * res[i];
      gy += jy * res[i];
    });
    const step = solve2(jxx * (1 + lambda), jxy, jyy * (1 + lambda), -gx, -gy);
    if (!step) break;
    const nx = kx + step[0];
    const ny = ky + step[1];
    const nres = residualsOf(nx, ny);
    const nc = cost(nres);
    if (nc <= c) {
      const done = Math.abs(step[0]) <= 1e-15 * Math.abs(kx) && Math.abs(step[1]) <= 1e-15 * Math.abs(ky);
      kx = nx;
      ky = ny;
      res = nres;
      c = nc;
      lambda = Math.max(1e-12, lambda / 10);
      if (done || nc === 0) break;
    } else {
      lambda *= 10;
      if (lambda > 1e6) break;
    }
  }
  kx = Math.abs(kx);
  ky = Math.abs(ky);
  return {
    k: Math.sqrt(kx * ky),
    kx,
    ky,
    transform: [kx, 0, 0, ky, 0, 0],
    ...report(residualsOf(kx, ky)),
  };
}

interface Centred {
  /** Centred drawing and world points. */
  u: Pt[];
  w: Pt[];
  dMean: Pt;
  wMean: Pt;
}

function centre(pairs: readonly PointPair[]): Centred {
  const n = pairs.length;
  let dx = 0;
  let dy = 0;
  let wx = 0;
  let wy = 0;
  for (const p of pairs) {
    dx += p.drawing.x;
    dy += p.drawing.y;
    wx += p.world.x;
    wy += p.world.y;
  }
  const dMean = { x: dx / n, y: dy / n };
  const wMean = { x: wx / n, y: wy / n };
  return {
    u: pairs.map((p) => ({ x: p.drawing.x - dMean.x, y: p.drawing.y - dMean.y })),
    w: pairs.map((p) => ({ x: p.world.x - wMean.x, y: p.world.y - wMean.y })),
    dMean,
    wMean,
  };
}

/** Builds [a, b, c, d, e, f] from a linear part and the centroids (translation = w̄ − L·d̄). */
function withTranslation(a: number, b: number, c: number, d: number, C: Centred): Affine2D {
  return [
    a,
    b,
    c,
    d,
    C.wMean.x - (a * C.dMean.x + c * C.dMean.y),
    C.wMean.y - (b * C.dMean.x + d * C.dMean.y),
  ];
}

/** Residuals |L·uᵢ − wᵢ| in centred coordinates (identical to |T(drawingᵢ) − worldᵢ| without cancellation). */
function pointResiduals(a: number, b: number, c: number, d: number, C: Centred): number[] {
  return C.u.map((u, i) => Math.hypot(a * u.x + c * u.y - C.w[i].x, b * u.x + d * u.y - C.w[i].y));
}

/**
 * Least-squares similarity (scale + rotation + translation) from ≥ 2 point pairs, closed form
 * (complex-number Procrustes on centred points). With `allowReflection` the mirrored solution is also fitted
 * and kept when its RMS is lower (e.g. drawings with a downward y axis).
 */
export function fitSimilarity(
  pairs: readonly PointPair[],
  opts: { allowReflection?: boolean } = {},
): PointFit {
  if (pairs.length < 2) throw new Error('At least two point pairs are required');
  const C = centre(pairs);
  const fit = (sign: 1 | -1): PointFit => {
    let suu = 0;
    let re = 0;
    let im = 0;
    C.u.forEach((u0, i) => {
      const u = { x: u0.x, y: sign * u0.y };
      const w = C.w[i];
      suu += u.x * u.x + u.y * u.y;
      re += u.x * w.x + u.y * w.y;
      im += u.x * w.y - u.y * w.x;
    });
    if (!(suu > 0)) throw new Error('Drawing points coincide');
    const ar = re / suu;
    const ai = im / suu;
    // L = [ar −ai; ai ar] · diag(1, sign)
    const a = ar;
    const b = ai;
    const c = -ai * sign;
    const d = ar * sign;
    return {
      transform: withTranslation(a, b, c, d, C),
      scale: Math.hypot(ar, ai),
      rotation: Math.atan2(ai, ar),
      ...report(pointResiduals(a, b, c, d, C)),
    };
  };
  const proper = fit(1);
  if (!opts.allowReflection) return proper;
  const mirrored = fit(-1);
  return mirrored.rms < proper.rms ? mirrored : proper;
}

function covariance(C: Centred): { sxx: number; sxy: number; syy: number } {
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const u of C.u) {
    sxx += u.x * u.x;
    sxy += u.x * u.y;
    syy += u.y * u.y;
  }
  return { sxx, sxy, syy };
}

function assertNotCollinear(sxx: number, sxy: number, syy: number): void {
  const det = sxx * syy - sxy * sxy;
  if (!(det > 1e-12 * (sxx + syy) * (sxx + syy))) throw new Error('Drawing points are collinear');
}

/** Least-squares general affine transform from ≥ 3 non-collinear point pairs (distorted scans). */
export function fitAffine(pairs: readonly PointPair[]): PointFit {
  if (pairs.length < 3) throw new Error('At least three point pairs are required');
  const C = centre(pairs);
  const { sxx, sxy, syy } = covariance(C);
  assertNotCollinear(sxx, sxy, syy);
  let xu = 0;
  let yu = 0;
  let xv = 0;
  let yv = 0;
  C.u.forEach((u, i) => {
    const w = C.w[i];
    xu += u.x * w.x;
    yu += u.y * w.x;
    xv += u.x * w.y;
    yv += u.y * w.y;
  });
  const [a, c] = solve2(sxx, sxy, syy, xu, yu)!;
  const [b, d] = solve2(sxx, sxy, syy, xv, yv)!;
  return {
    transform: withTranslation(a, b, c, d, C),
    scale: Math.sqrt(Math.abs(a * d - b * c)),
    rotation: Math.atan2(b, a),
    ...report(pointResiduals(a, b, c, d, C)),
  };
}

/**
 * Separate X/Y scales along the drawing axes, then rotation and translation:
 * world = R(θ)·diag(kx, ky)·drawing + t, from ≥ 3 non-collinear pairs. Closed form: for a fixed θ the optimal
 * kx, ky are linear, and the remaining objective is A + α·cos 2θ + β·sin 2θ, maximised at 2θ = atan2(β, α).
 * kx is reported positive; a negative ky means the drawing is mirrored.
 */
export function fitScaleXYTranslation(pairs: readonly PointPair[]): ScaleXYPointFit {
  if (pairs.length < 3) throw new Error('At least three point pairs are required');
  const C = centre(pairs);
  const { sxx, sxy, syy } = covariance(C);
  assertNotCollinear(sxx, sxy, syy);
  let P = 0;
  let Q = 0;
  let U = 0;
  let V = 0;
  C.u.forEach((u, i) => {
    const w = C.w[i];
    P += u.x * w.x;
    Q += u.x * w.y;
    U += u.y * w.x;
    V += u.y * w.y;
  });
  const alpha = (P * P - Q * Q) / (2 * sxx) + (V * V - U * U) / (2 * syy);
  const beta = (P * Q) / sxx - (U * V) / syy;
  let theta = Math.atan2(beta, alpha) / 2;
  let cs = Math.cos(theta);
  let sn = Math.sin(theta);
  let kx = (cs * P + sn * Q) / sxx;
  let ky = (cs * V - sn * U) / syy;
  if (kx < 0) {
    theta += Math.PI;
    cs = -cs;
    sn = -sn;
    kx = -kx;
    ky = -ky;
  }
  const a = cs * kx;
  const b = sn * kx;
  const c = -sn * ky;
  const d = cs * ky;
  return {
    transform: withTranslation(a, b, c, d, C),
    kx,
    ky,
    scale: Math.sqrt(Math.abs(kx * ky)),
    rotation: Math.atan2(sn, cs),
    ...report(pointResiduals(a, b, c, d, C)),
  };
}
