import {
  Clipper64,
  ClipType,
  FillRule,
  PolyTree64,
  type Path64,
  type Paths64,
  type PolyPath64,
} from '@countertype/clipper2-ts';

import type { Geometry, Pt } from '@/core/types';

import { signedArea } from './measure';

/**
 * Float (world metres) ↔ Clipper2 integer conversion (FDR row 61, NFR-7).
 *
 * Clipper2 works on integer coordinates. This port stores them in float64 and evaluates cross products
 * such as (b − a) × (c − b) in plain float64 arithmetic, which is exact only while every product stays
 * below 2^53. We therefore convert in a *local frame*:
 *
 *   X = round((x − ox) · scale),  Y = round((y − oy) · scale)
 *
 * with (ox, oy) the bounding-box centre of the input rounded to whole metres (so UTM-sized offsets such as
 * X 600 000 / Y 2 500 000 never reach the integers), and `scale` chosen so that |X|, |Y| ≤ 2^25 (≈ 3.36e7)
 * including a margin for the offset distance. Then every coordinate difference is ≤ 2^26, every product of
 * two differences ≤ 2^52 and the difference of two such products ≤ 2^53: all cross/dot products are exact.
 * (|X| ≲ 5e7 is *not* enough: differences reach 1e8 and products 1e16 > 2^53 ≈ 9.007e15.) The scale is
 * rounded down to two significant digits so whole-metre (and, for scale ≥ 1e4, millimetre) inputs land
 * exactly on the grid.
 *
 * Resulting precision: the quantisation error is 0.5 / scale. For a 10 km site (half extent 5 km) plus a
 * 50 m offset margin, scale = 6 600 units/m → 0.15 mm grid, ≤ 0.076 mm rounding error, inside the 0.1 mm
 * budget; the budget holds for half extents up to ≈ 6 km and the error stays < 1 mm (NFR-7) up to ≈ 60 km
 * half extents. Small inputs are capped at 1e6 units/m (1 µm grid).
 */

/** Largest integer coordinate magnitude allowed in the local frame (2^25). */
export const CLIPPER_MAX_COORD = 2 ** 25;
/** Finest grid (units per metre). */
export const CLIPPER_MAX_SCALE = 1e6;

export interface ClipperFrame {
  /** Local origin (world metres). */
  ox: number;
  oy: number;
  /** Integer units per metre. */
  scale: number;
}

export type ClipFillRule = 'evenodd' | 'nonzero' | 'positive' | 'negative';
export type ClipOp = 'union' | 'intersection' | 'difference' | 'xor';

const FILL: Record<ClipFillRule, FillRule> = {
  evenodd: FillRule.EvenOdd,
  nonzero: FillRule.NonZero,
  positive: FillRule.Positive,
  negative: FillRule.Negative,
};

const OPS: Record<ClipOp, ClipType> = {
  union: ClipType.Union,
  intersection: ClipType.Intersection,
  difference: ClipType.Difference,
  xor: ClipType.Xor,
};

export function clipFillRule(rule: ClipFillRule): FillRule {
  return FILL[rule];
}

/**
 * Frame for a set of float paths: origin at the bounding-box centre, scale from the half extent plus
 * `margin` (metres the result may grow beyond the input, e.g. the offset distance).
 */
export function createFrame(paths: readonly (readonly Pt[])[], margin = 0): ClipperFrame {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const p of path) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!(minX <= maxX)) return { ox: 0, oy: 0, scale: CLIPPER_MAX_SCALE };
  // Whole-metre origin and a scale rounded down to 2 significant digits: typed dimensions (whole metres,
  // millimetres when scale ≥ 1e4) land exactly on the integer grid. Costs ≤ 10 % of the resolution.
  const ox = Math.round((minX + maxX) / 2);
  const oy = Math.round((minY + maxY) / 2);
  const half = Math.max(maxX - ox, ox - minX, maxY - oy, oy - minY) + Math.abs(margin);
  const scale = half > 0 ? floor2(Math.min(CLIPPER_MAX_SCALE, CLIPPER_MAX_COORD / half)) : CLIPPER_MAX_SCALE;
  return { ox, oy, scale };
}

/** Rounds down to two significant digits. */
function floor2(v: number): number {
  const p = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.floor(v / p + 1e-9) * p;
}

/** Maximum quantisation error of a frame, metres. */
export function frameMaxError(f: ClipperFrame): number {
  return 0.5 / f.scale;
}

export function toPath64(path: readonly Pt[], f: ClipperFrame): Path64 {
  return path.map((p) => ({ x: Math.round((p.x - f.ox) * f.scale), y: Math.round((p.y - f.oy) * f.scale) }));
}

export function toPaths64(paths: readonly (readonly Pt[])[], f: ClipperFrame): Paths64 {
  return paths.map((p) => toPath64(p, f));
}

export function fromPath64(path: Path64, f: ClipperFrame): Pt[] {
  return path.map((p) => ({ x: p.x / f.scale + f.ox, y: p.y / f.scale + f.oy }));
}

export function fromPaths64(paths: Paths64, f: ClipperFrame): Pt[][] {
  return paths.map((p) => fromPath64(p, f));
}

/** Polygon with holes (outer CCW, holes CW). */
export interface PolygonWithHoles {
  outer: Pt[];
  holes: Pt[][];
}

function oriented(ring: Pt[], ccw: boolean): Pt[] {
  return signedArea(ring) > 0 === ccw ? ring : ring.reverse();
}

/** Converts a PolyTree into polygons with holes (islands inside holes become separate polygons). */
export function polyTreeToPolygons(tree: PolyPath64, f: ClipperFrame): PolygonWithHoles[] {
  const out: PolygonWithHoles[] = [];
  const visitOuter = (node: PolyPath64): void => {
    const holes: Pt[][] = [];
    for (let i = 0; i < node.count; i++) {
      const hole = node.child(i);
      if (hole.polygon && hole.polygon.length >= 3) holes.push(oriented(fromPath64(hole.polygon, f), false));
      for (let j = 0; j < hole.count; j++) visitOuter(hole.child(j));
    }
    if (node.polygon && node.polygon.length >= 3)
      out.push({ outer: oriented(fromPath64(node.polygon, f), true), holes });
  };
  for (let i = 0; i < tree.count; i++) visitOuter(tree.child(i));
  return out;
}

/** Normalises integer paths with a fill rule: outers positive (CCW), holes negative, no self-intersections. */
export function normalizePaths(paths: Paths64, rule: ClipFillRule): Paths64 {
  const c = new Clipper64();
  c.addSubject(paths);
  const out: Paths64 = [];
  c.execute(ClipType.Union, FILL[rule], out);
  return out;
}

/** Boolean operation on integer paths into a PolyTree. */
export function clipToTree(
  op: ClipOp,
  subject: Paths64,
  clip: Paths64 | null,
  rule: ClipFillRule,
): PolyTree64 {
  const c = new Clipper64();
  c.addSubject(subject);
  if (clip) c.addClip(clip);
  const tree = new PolyTree64();
  c.execute(OPS[op], FILL[rule], tree);
  return tree;
}

/** Boolean operation on float rings (a shared frame is created when none is given). */
export function booleanPolygons(
  op: ClipOp,
  subject: readonly (readonly Pt[])[],
  clip: readonly (readonly Pt[])[] | null,
  rule: ClipFillRule,
  frame: ClipperFrame = createFrame(clip ? [...subject, ...clip] : subject),
): PolygonWithHoles[] {
  const tree = clipToTree(op, toPaths64(subject, frame), clip ? toPaths64(clip, frame) : null, rule);
  return polyTreeToPolygons(tree, frame);
}

/** Total area of polygons with holes. */
export function polygonsArea(polys: readonly PolygonWithHoles[]): number {
  let a = 0;
  for (const p of polys) {
    a += Math.abs(signedArea(p.outer));
    for (const h of p.holes) a -= Math.abs(signedArea(h));
  }
  return a;
}

/** Number of rings (outers + holes). */
export function countRings(polys: readonly PolygonWithHoles[]): number {
  return polys.reduce((n, p) => n + 1 + p.holes.length, 0);
}

/** One ring without holes → closed polyline; otherwise multipolygon; nothing → null. */
export function polygonsToGeometry(polys: readonly PolygonWithHoles[]): Geometry | null {
  if (polys.length === 0) return null;
  if (polys.length === 1 && polys[0].holes.length === 0) {
    return { type: 'polyline', pts: polys[0].outer.map((p) => ({ x: p.x, y: p.y })), closed: true };
  }
  const rings: Pt[][] = [];
  for (const p of polys) rings.push(p.outer, ...p.holes);
  return { type: 'multipolygon', rings: rings.map((r) => r.map((p) => ({ x: p.x, y: p.y }))) };
}
