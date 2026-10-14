import type { Pt, Vertex } from '@/core/types';
import { TAU, angleOf, dist } from './vec';

/**
 * Bulge helpers. A bulge b = tan(θ/4) on the segment from p0 to p1 describes a circular arc with
 * included angle θ (positive = counter-clockwise). |b| = 1 is a semicircle.
 */

export interface BulgeArc {
  c: Pt;
  r: number;
  /** Start and end angles (radians). The arc runs CCW from a0 to a1 when ccw, CW otherwise. */
  a0: number;
  a1: number;
  ccw: boolean;
  /** Signed included angle θ. */
  sweep: number;
}

export function bulgeToArc(p0: Pt, p1: Pt, bulge: number): BulgeArc | null {
  if (!bulge || Math.abs(bulge) < 1e-12) return null;
  const chord = dist(p0, p1);
  if (chord < 1e-15) return null;
  const theta = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
  // Distance from chord midpoint to centre (signed, towards the left of p0→p1 for positive bulge when |θ| < π).
  const mx = (p0.x + p1.x) / 2;
  const my = (p0.y + p1.y) / 2;
  const h = (chord / 2) * ((1 - bulge * bulge) / (2 * bulge));
  const ux = (p1.x - p0.x) / chord;
  const uy = (p1.y - p0.y) / chord;
  const c = { x: mx - uy * h, y: my + ux * h };
  return {
    c,
    r,
    a0: angleOf({ x: p0.x - c.x, y: p0.y - c.y }),
    a1: angleOf({ x: p1.x - c.x, y: p1.y - c.y }),
    ccw: bulge > 0,
    sweep: theta,
  };
}

/** Bulge for an arc from p0 to p1 around centre c in the given direction. */
export function arcToBulge(c: Pt, p0: Pt, p1: Pt, ccw: boolean): number {
  let sweep = angleOf({ x: p1.x - c.x, y: p1.y - c.y }) - angleOf({ x: p0.x - c.x, y: p0.y - c.y });
  if (ccw) {
    while (sweep <= 0) sweep += TAU;
  } else {
    while (sweep >= 0) sweep -= TAU;
  }
  return Math.tan(sweep / 4);
}

/** Arc length (or chord length for straight segments). */
export function segmentLength(p0: Pt, p1: Pt, bulge = 0): number {
  if (!bulge) return dist(p0, p1);
  const theta = 4 * Math.atan(bulge);
  const chord = dist(p0, p1);
  if (chord === 0) return 0;
  const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
  return Math.abs(theta) * r;
}

/** Number of segments to approximate an arc of radius r and |sweep| within chord tolerance. */
export function arcSegments(r: number, sweep: number, chordTol: number, max = 4096): number {
  const absSweep = Math.abs(sweep);
  if (r <= 0 || absSweep === 0) return 1;
  const tol = Math.max(chordTol, r * 1e-9);
  const step = tol >= r ? Math.PI / 2 : 2 * Math.acos(1 - tol / r);
  return Math.min(max, Math.max(1, Math.ceil(absSweep / step)));
}

/** Points along a bulge segment, excluding p0, including p1. */
export function tessellateBulge(p0: Pt, p1: Pt, bulge: number, chordTol: number, out: Pt[] = []): Pt[] {
  const arc = bulgeToArc(p0, p1, bulge);
  if (!arc) {
    out.push({ x: p1.x, y: p1.y });
    return out;
  }
  const n = arcSegments(arc.r, arc.sweep, chordTol);
  for (let i = 1; i < n; i++) {
    const a = arc.a0 + (arc.sweep * i) / n;
    out.push({ x: arc.c.x + arc.r * Math.cos(a), y: arc.c.y + arc.r * Math.sin(a) });
  }
  out.push({ x: p1.x, y: p1.y });
  return out;
}

/** Flattens a polyline with bulges into straight-segment points. */
export function tessellatePolyline(pts: Vertex[], closed: boolean, chordTol: number): Pt[] {
  if (pts.length === 0) return [];
  const out: Pt[] = [{ x: pts[0].x, y: pts[0].y }];
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    tessellateBulge(a, b, a.bulge ?? 0, chordTol, out);
  }
  if (closed && out.length > 1) out.pop(); // last point equals first
  return out;
}
