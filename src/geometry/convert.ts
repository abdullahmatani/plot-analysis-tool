import { applyVec, apply, isSimilarity } from '@/core/affine';
import type { Affine2D, Geometry, Pt, Vertex } from '@/core/types';

import { arcSegments, tessellateBulge, tessellatePolyline } from './bulge';
import { TAU, ccwSweep } from './vec';

/**
 * Geometry conversion and transforms (FDR rows 38, 43, 55–57).
 *
 * `transformGeometry` keeps shapes analytic whenever the transform allows it: similarity transforms
 * (rotation, uniform scale, translation, mirror) map circles, arcs, rectangles, ellipses and bulge
 * polylines exactly (mirroring flips bulge signs and swaps arc start/end). Under general affine maps an
 * ellipse (and a circle) stays an exact ellipse, a rectangle stays a rectangle only while its axes stay
 * perpendicular (otherwise it becomes a 4-vertex closed polyline), and arcs/bulge segments are tessellated
 * so that the *transformed* curve is within `chordTol`.
 */

type Rect = Extract<Geometry, { type: 'rect' }>;

/** True for shapes with an interior (circle, rect, ellipse, multipolygon, closed polyline). */
export function isClosed(g: Geometry): boolean {
  switch (g.type) {
    case 'circle':
    case 'rect':
    case 'ellipse':
    case 'multipolygon':
      return true;
    case 'polyline':
      return g.closed;
    default:
      return false;
  }
}

/** Corners of a (rotated) rectangle in counter-clockwise order. */
export function rectCorners(g: Rect): Pt[] {
  const c = Math.cos(g.rot);
  const s = Math.sin(g.rot);
  const hw = Math.abs(g.w) / 2;
  const hh = Math.abs(g.h) / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => ({ x: g.c.x + x * c - y * s, y: g.c.y + x * s + y * c }));
}

/**
 * Ellipse vertices (CCW, uniform parameter steps). The step is chosen for a circle of radius max(rx, ry);
 * an ellipse is a contraction of that circle, so the chord deviation is ≤ chordTol everywhere.
 */
export function tessellateEllipse(c: Pt, rx: number, ry: number, rot: number, chordTol: number): Pt[] {
  const a = Math.abs(rx);
  const b = Math.abs(ry);
  const n = Math.max(8, arcSegments(Math.max(a, b), TAU, chordTol));
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (TAU * i) / n;
    const x = a * Math.cos(t);
    const y = b * Math.sin(t);
    out.push({ x: c.x + x * cr - y * sr, y: c.y + x * sr + y * cr });
  }
  return out;
}

/** Points along the CCW arc from a0 to a1 (both endpoints included) within chordTol. */
export function tessellateArc(c: Pt, r: number, a0: number, a1: number, chordTol: number): Pt[] {
  const sweep = ccwSweep(a0, a1);
  const n = arcSegments(Math.abs(r), sweep, chordTol);
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}

/**
 * Bulge-polyline representation (rings/paths). Exact where possible: circle → 2 vertices with bulge 1,
 * arc → 2 vertices with bulge tan(sweep/4) (3 vertices with half-sweep bulges when the sweep exceeds 1.5π,
 * since bulges grow without bound as the sweep approaches 2π), rect → 4 CCW vertices, ellipse → tessellated
 * within chordTol, multipolygon → its rings, point → [[p]].
 * Use `isClosed(g)` to know whether the paths are closed.
 */
export function toPolyline(g: Geometry, chordTol: number): Vertex[][] {
  switch (g.type) {
    case 'point':
      return [[{ x: g.p.x, y: g.p.y }]];
    case 'circle': {
      const r = Math.abs(g.r);
      return [
        [
          { x: g.c.x + r, y: g.c.y, bulge: 1 },
          { x: g.c.x - r, y: g.c.y, bulge: 1 },
        ],
      ];
    }
    case 'arc': {
      const sweep = ccwSweep(g.a0, g.a1);
      const r = Math.abs(g.r);
      const at = (a: number): Pt => ({ x: g.c.x + r * Math.cos(a), y: g.c.y + r * Math.sin(a) });
      if (sweep > 1.5 * Math.PI) {
        const b = Math.tan(sweep / 8);
        return [[{ ...at(g.a0), bulge: b }, { ...at(g.a0 + sweep / 2), bulge: b }, at(g.a0 + sweep)]];
      }
      return [[{ ...at(g.a0), bulge: Math.tan(sweep / 4) }, at(g.a0 + sweep)]];
    }
    case 'rect':
      return [rectCorners(g)];
    case 'ellipse':
      return [tessellateEllipse(g.c, g.rx, g.ry, g.rot, chordTol)];
    case 'polyline':
      return [g.pts.map(copyVertex)];
    case 'multipolygon':
      return g.rings.map((r) => r.map(copyVertex));
  }
}

/**
 * Straight-segment rings (closed shapes) or a single open path (arc, open polyline, point), with arcs and
 * bulges tessellated within chordTol. Closed rings do not repeat their first point.
 */
export function toRings(g: Geometry, chordTol: number): Pt[][] {
  const closed = isClosed(g);
  if (g.type === 'arc') return [tessellateArc(g.c, g.r, g.a0, g.a1, chordTol)];
  if (g.type === 'ellipse' || g.type === 'rect') return toPolyline(g, chordTol);
  return toPolyline(g, chordTol).map((r) => tessellatePolyline(r, closed, chordTol));
}

function copyVertex(v: Vertex): Vertex {
  return v.bulge ? { x: v.x, y: v.y, bulge: v.bulge } : { x: v.x, y: v.y };
}

/** Deep copy of a geometry. */
export function cloneGeometry(g: Geometry): Geometry {
  switch (g.type) {
    case 'point':
      return { type: 'point', p: { x: g.p.x, y: g.p.y } };
    case 'polyline':
      return { type: 'polyline', pts: g.pts.map(copyVertex), closed: g.closed };
    case 'multipolygon':
      return { type: 'multipolygon', rings: g.rings.map((r) => r.map(copyVertex)) };
    default:
      return { ...g, c: { x: g.c.x, y: g.c.y } };
  }
}

/**
 * Semi-axes and rotation of the ellipse that is the image of the unit circle under the linear map
 * (x, y) → (a·x + c·y, b·x + d·y) — closed-form 2×2 SVD.
 */
export function ellipseOfLinear(
  a: number,
  b: number,
  c: number,
  d: number,
): { rx: number; ry: number; rot: number } {
  const E = (a + d) / 2;
  const F = (a - d) / 2;
  const G = (b + c) / 2;
  const H = (b - c) / 2;
  const Q = Math.hypot(E, H);
  const R = Math.hypot(F, G);
  const rot = (Math.atan2(H, E) + Math.atan2(G, F)) / 2;
  return { rx: Q + R, ry: Math.abs(Q - R), rot };
}

type PtMap = (p: Pt) => Pt;

/** Maps a geometry with point map `f` whose linear part is `L` (L[4], L[5] ignored). */
function mapGeometry(g: Geometry, L: Affine2D, f: PtMap, chordTol: number): Geometry {
  const det = L[0] * L[3] - L[1] * L[2];
  const sim = isSimilarity(L);
  const mirrored = det < 0;
  const k = Math.sqrt(Math.abs(det));
  const dirAngle = (theta: number): number => {
    const v = applyVec(L, { x: Math.cos(theta), y: Math.sin(theta) });
    return Math.atan2(v.y, v.x);
  };
  // Largest stretch of L: tessellating with chordTol / σmax keeps the image within chordTol.
  const sigmaMax = ellipseOfLinear(L[0], L[1], L[2], L[3]).rx;
  const tolSrc = sigmaMax > 0 ? chordTol / sigmaMax : chordTol;

  const mapPath = (pts: readonly Vertex[], closed: boolean): Vertex[] => {
    if (sim) {
      return pts.map((v) => {
        const p = f(v);
        return v.bulge ? { x: p.x, y: p.y, bulge: mirrored ? -v.bulge : v.bulge } : p;
      });
    }
    const out: Vertex[] = [];
    const n = pts.length;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < n; i++) {
      const v = pts[i];
      out.push(f(v));
      if (i < segs && v.bulge) {
        const inner = tessellateBulge(v, pts[(i + 1) % n], v.bulge, tolSrc);
        inner.pop(); // the end vertex is emitted by the next iteration (or is the closing vertex)
        for (const p of inner) out.push(f(p));
      }
    }
    return out;
  };

  switch (g.type) {
    case 'point':
      return { type: 'point', p: f(g.p) };
    case 'circle': {
      if (sim) return { type: 'circle', c: f(g.c), r: Math.abs(g.r) * k };
      const r = Math.abs(g.r);
      const e = ellipseOfLinear(L[0] * r, L[1] * r, L[2] * r, L[3] * r);
      return { type: 'ellipse', c: f(g.c), rx: e.rx, ry: e.ry, rot: e.rot };
    }
    case 'arc': {
      const sweep = ccwSweep(g.a0, g.a1);
      if (sim) {
        const a0 = dirAngle(mirrored ? g.a0 + sweep : g.a0);
        return { type: 'arc', c: f(g.c), r: Math.abs(g.r) * k, a0, a1: a0 + sweep };
      }
      const pts = tessellateArc(g.c, g.r, g.a0, g.a1, tolSrc);
      return { type: 'polyline', pts: pts.map(f), closed: false };
    }
    case 'rect': {
      const u = applyVec(L, { x: Math.cos(g.rot), y: Math.sin(g.rot) });
      const v = applyVec(L, { x: -Math.sin(g.rot), y: Math.cos(g.rot) });
      const lu = Math.hypot(u.x, u.y);
      const lv = Math.hypot(v.x, v.y);
      if (sim || Math.abs(u.x * v.x + u.y * v.y) <= 1e-12 * lu * lv) {
        return {
          type: 'rect',
          c: f(g.c),
          w: Math.abs(g.w) * lu,
          h: Math.abs(g.h) * lv,
          rot: Math.atan2(u.y, u.x),
        };
      }
      return { type: 'polyline', pts: rectCorners(g).map(f), closed: true };
    }
    case 'ellipse': {
      if (sim)
        return {
          type: 'ellipse',
          c: f(g.c),
          rx: Math.abs(g.rx) * k,
          ry: Math.abs(g.ry) * k,
          rot: dirAngle(g.rot),
        };
      const cr = Math.cos(g.rot);
      const sr = Math.sin(g.rot);
      const c1 = applyVec(L, { x: g.rx * cr, y: g.rx * sr });
      const c2 = applyVec(L, { x: -g.ry * sr, y: g.ry * cr });
      const e = ellipseOfLinear(c1.x, c1.y, c2.x, c2.y);
      return { type: 'ellipse', c: f(g.c), rx: e.rx, ry: e.ry, rot: e.rot };
    }
    case 'polyline':
      return { type: 'polyline', pts: mapPath(g.pts, g.closed), closed: g.closed };
    case 'multipolygon':
      return { type: 'multipolygon', rings: g.rings.map((r) => mapPath(r, true)) };
  }
}

/** Applies an affine transform [a, b, c, d, e, f] (see module notes for how each shape type maps). */
export function transformGeometry(g: Geometry, m: Affine2D, chordTol: number): Geometry {
  return mapGeometry(g, m, (p) => apply(m, p), chordTol);
}

/** Linear map about a pivot, computed in local coordinates (no cancellation at large world coordinates). */
function aboutMap(L: Affine2D, about: Pt): PtMap {
  return (p) => {
    const dx = p.x - about.x;
    const dy = p.y - about.y;
    return { x: about.x + L[0] * dx + L[2] * dy, y: about.y + L[1] * dx + L[3] * dy };
  };
}

/** Translation (exact). */
export function translateGeometry(g: Geometry, dx: number, dy: number): Geometry {
  const L: Affine2D = [1, 0, 0, 1, 0, 0];
  return mapGeometry(g, L, (p) => ({ x: p.x + dx, y: p.y + dy }), 0);
}

/** Rotation by `angle` radians (CCW) about `about` (default origin). */
export function rotateGeometry(g: Geometry, angle: number, about: Pt = { x: 0, y: 0 }): Geometry {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const L: Affine2D = [c, s, -s, c, 0, 0];
  return mapGeometry(g, L, aboutMap(L, about), 0);
}

/** Uniform scale by k about `about` (default origin). Negative k is a point reflection. */
export function scaleGeometry(g: Geometry, k: number, about: Pt = { x: 0, y: 0 }): Geometry {
  const L: Affine2D = [k, 0, 0, k, 0, 0];
  return mapGeometry(g, L, aboutMap(L, about), 0);
}

/** Mirror across the line through a and b. */
export function mirrorGeometry(g: Geometry, a: Pt, b: Pt): Geometry {
  const phi = Math.atan2(b.y - a.y, b.x - a.x);
  const c = Math.cos(2 * phi);
  const s = Math.sin(2 * phi);
  const L: Affine2D = [c, s, s, -c, 0, 0];
  return mapGeometry(g, L, aboutMap(L, a), 0);
}
