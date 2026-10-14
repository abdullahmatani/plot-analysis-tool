import type { Pt, Vertex } from '@/core/types';
import { bulgeThrough } from '@/geometry/polyline-edit';

/**
 * Arc segments for manual tracing (row 49): bulges from three points and tangent continuations.
 * Bulge = tan(θ/4) of the included angle θ (positive = counter-clockwise), stored on the vertex that
 * starts the segment, as in DXF.
 */

/** Largest |included angle| allowed for a single arc segment (just under a full circle). */
const MAX_SWEEP = 2 * Math.PI - 1e-6;

/** Unit direction of travel at the end of segment a → b with bulge `bulge` (null if degenerate). */
export function endTangent(a: Pt, b: Pt, bulge = 0): Pt | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (!(l > 0)) return null;
  // The tangent at the end of an arc is the chord direction rotated by half the included angle.
  const half = 2 * Math.atan(bulge);
  const c = Math.cos(half);
  const s = Math.sin(half);
  return { x: (dx * c - dy * s) / l, y: (dx * s + dy * c) / l };
}

/** Direction of travel at the last vertex of an open bulge polyline (null for < 2 vertices). */
export function lastTangent(pts: readonly Vertex[]): Pt | null {
  if (pts.length < 2) return null;
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  return endTangent(a, b, a.bulge ?? 0);
}

/**
 * Bulge of the arc from p, leaving in direction t, to q (tangent continuation). 0 when q lies
 * straight ahead; null when q coincides with p.
 */
export function tangentBulge(p: Pt, t: Pt, q: Pt): number | null {
  const cx = q.x - p.x;
  const cy = q.y - p.y;
  if (cx === 0 && cy === 0) return null;
  // Signed angle φ from the tangent to the chord: the included angle is 2φ, so bulge = tan(φ/2).
  const phi = Math.atan2(t.x * cy - t.y * cx, t.x * cx + t.y * cy);
  const theta = Math.max(-MAX_SWEEP, Math.min(MAX_SWEEP, 2 * phi));
  return Math.abs(theta) < 1e-12 ? 0 : Math.tan(theta / 4);
}

/** Bulge of the arc p0 → p1 through m (three-point arc); null when no arc passes through m. */
export function threePointBulge(p0: Pt, m: Pt, p1: Pt): number | null {
  return bulgeThrough(p0, m, p1);
}
