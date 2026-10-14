import type { Pt } from '@/core/types';

export const EPS = 1e-12;
export const TAU = Math.PI * 2;

export const pt = (x: number, y: number): Pt => ({ x, y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
export const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
export const len = (a: Pt): number => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: Pt, b: Pt): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });
export const angleOf = (a: Pt): number => Math.atan2(a.y, a.x);
export const fromAngle = (theta: number, r = 1): Pt => ({ x: Math.cos(theta) * r, y: Math.sin(theta) * r });
export const eqPt = (a: Pt, b: Pt, tol = 1e-9): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

export function normalize(a: Pt): Pt {
  const l = len(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function rotatePt(p: Pt, theta: number, about: Pt = { x: 0, y: 0 }): Pt {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c };
}

/** Normalises an angle to [0, 2π). */
export function normAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Counter-clockwise sweep from a0 to a1 in (0, 2π]. */
export function ccwSweep(a0: number, a1: number): number {
  const s = normAngle(a1 - a0);
  return s === 0 ? TAU : s;
}

/** True if angle a lies on the CCW arc from a0 to a1 (inclusive, with tolerance). */
export function angleInArc(a: number, a0: number, a1: number, tol = 1e-12): boolean {
  const sweep = ccwSweep(a0, a1);
  const rel = normAngle(a - a0);
  return rel <= sweep + tol || rel >= TAU - tol;
}
