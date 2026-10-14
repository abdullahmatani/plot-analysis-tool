import type { Geometry, Pt } from '@/core/types';

import {
  clipToTree,
  createFrame,
  normalizePaths,
  polyTreeToPolygons,
  polygonsArea,
  polygonsToGeometry,
  toPaths64,
  type ClipFillRule,
  type ClipOp,
  type ClipperFrame,
  type PolygonWithHoles,
} from './clipper';
import { isClosed, toRings } from './convert';

/**
 * Boolean operations on closed shapes via Clipper2 (FDR rows 60, 74: batch-offset merge and contour
 * envelopes). Curves are tessellated within chordTol (vertices on the curve, so areas are slightly
 * under-estimated by at most ≈ chordTol × perimeter). Each input is first normalised on its own (even–odd
 * for multipolygons, non-zero for single rings), then the inputs are combined with the non-zero rule.
 * Open shapes (arcs, open polylines, points) have no area and are ignored.
 */

interface Prepared {
  rings: Pt[][];
  rule: ClipFillRule;
}

function prepare(g: Geometry, chordTol: number): Prepared | null {
  if (!isClosed(g)) return null;
  return { rings: toRings(g, chordTol), rule: g.type === 'multipolygon' ? 'evenodd' : 'nonzero' };
}

function normalised(items: readonly Prepared[], frame: ClipperFrame) {
  return items.flatMap((p) => normalizePaths(toPaths64(p.rings, frame), p.rule));
}

function run(
  op: ClipOp,
  subject: readonly Geometry[],
  clip: readonly Geometry[] | null,
  chordTol: number,
): PolygonWithHoles[] {
  const subj = subject.map((g) => prepare(g, chordTol)).filter((p): p is Prepared => p !== null);
  const clp = clip ? clip.map((g) => prepare(g, chordTol)).filter((p): p is Prepared => p !== null) : null;
  const frame = createFrame([...subj, ...(clp ?? [])].flatMap((p) => p.rings));
  return polyTreeToPolygons(
    clipToTree(op, normalised(subj, frame), clp ? normalised(clp, frame) : null, 'nonzero'),
    frame,
  );
}

/** Union of closed shapes as polygons with holes. */
export function unionPolygons(gs: readonly Geometry[], chordTol: number): PolygonWithHoles[] {
  return run('union', gs, null, chordTol);
}

/** Union (envelope) of closed shapes: closed polyline for one simple ring, else multipolygon; null if empty. */
export function unionGeometries(gs: readonly Geometry[], chordTol: number): Geometry | null {
  return polygonsToGeometry(unionPolygons(gs, chordTol));
}

/** Area of the union of closed shapes (m²). */
export function unionArea(gs: readonly Geometry[], chordTol: number): number {
  return polygonsArea(unionPolygons(gs, chordTol));
}

/** a ∩ b, or null when they do not overlap. */
export function intersectGeometries(a: Geometry, b: Geometry, chordTol: number): Geometry | null {
  return polygonsToGeometry(run('intersection', [a], [b], chordTol));
}

/** a − b, or null when nothing remains. */
export function differenceGeometries(a: Geometry, b: Geometry, chordTol: number): Geometry | null {
  return polygonsToGeometry(run('difference', [a], [b], chordTol));
}
