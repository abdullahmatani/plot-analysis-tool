import type { Affine2D, Bounds, Pt } from './types';

/** Affine helpers. Matrices use the Canvas/SVG convention [a, b, c, d, e, f]. */

export const IDENTITY: Affine2D = [1, 0, 0, 1, 0, 0];

export function apply(m: Affine2D, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function applyXY(m: Affine2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Applies only the linear part (for vectors). */
export function applyVec(m: Affine2D, v: Pt): Pt {
  return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y };
}

/** Returns m1 ∘ m2 (apply m2 first, then m1). */
export function multiply(m1: Affine2D, m2: Affine2D): Affine2D {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function determinant(m: Affine2D): number {
  return m[0] * m[3] - m[1] * m[2];
}

export function invert(m: Affine2D): Affine2D {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) throw new Error('Transform is not invertible');
  const [a, b, c, d, e, f] = m;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function translate(tx: number, ty: number): Affine2D {
  return [1, 0, 0, 1, tx, ty];
}

export function scale(sx: number, sy = sx): Affine2D {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotate(theta: number): Affine2D {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c, s, -s, c, 0, 0];
}

/** Similarity transform: rotate by theta, scale by k, then translate. */
export function similarity(k: number, theta: number, tx: number, ty: number): Affine2D {
  const c = Math.cos(theta) * k;
  const s = Math.sin(theta) * k;
  return [c, s, -s, c, tx, ty];
}

/** Uniform scale factor (geometric mean of the axis scales). */
export function scaleFactor(m: Affine2D): number {
  return Math.sqrt(Math.abs(determinant(m)));
}

/** Rotation angle of the transform's x axis. */
export function rotationOf(m: Affine2D): number {
  return Math.atan2(m[1], m[0]);
}

export function isMirrored(m: Affine2D): boolean {
  return determinant(m) < 0;
}

export function isSimilarity(m: Affine2D, tol = 1e-9): boolean {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const dot = m[0] * m[2] + m[1] * m[3];
  return Math.abs(sx - sy) <= tol * Math.max(sx, sy) && Math.abs(dot) <= tol * sx * sy;
}

export function transformBounds(m: Affine2D, b: Bounds): Bounds {
  const corners = [
    applyXY(m, b.minX, b.minY),
    applyXY(m, b.maxX, b.minY),
    applyXY(m, b.maxX, b.maxY),
    applyXY(m, b.minX, b.maxY),
  ];
  const out: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of corners) {
    if (x < out.minX) out.minX = x;
    if (y < out.minY) out.minY = y;
    if (x > out.maxX) out.maxX = x;
    if (y > out.maxY) out.maxY = y;
  }
  return out;
}

export function approxEqual(m1: Affine2D, m2: Affine2D, tol = 1e-9): boolean {
  return m1.every((v, i) => Math.abs(v - m2[i]) <= tol * Math.max(1, Math.abs(v), Math.abs(m2[i])));
}
