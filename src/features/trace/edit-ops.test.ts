import { describe, expect, it } from 'vitest';

import type { Geometry, Pt, Vertex } from '@/core/types';
import { bulgeToArc } from '@/geometry/bulge';
import { area, distanceToBulgeSegment, polylineLength } from '@/geometry/measure';

import {
  closeGeometry,
  convertSegmentAt,
  dedupeGeometry,
  insertAndMove,
  insertVertexAt,
  joinGeometries,
  nearestSegment,
  nearestVertex,
  openGeometry,
  removeVertexAt,
  reverseGeometry,
  segmentMidpoints,
  simplifyGeometry,
  splitGeometryAt,
} from './edit-ops';

/** Trace editing and cleanup (row 53). */

const poly = (pts: Vertex[], closed: boolean): Extract<Geometry, { type: 'polyline' }> => ({
  type: 'polyline',
  pts,
  closed,
});

/** Distance from p to a polyline with bulges. */
function distToPolyline(p: Pt, pts: Vertex[], closed: boolean): number {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++)
    best = Math.min(best, distanceToBulgeSegment(p, pts[i], pts[(i + 1) % n], pts[i].bulge));
  return best;
}

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('simplify with tolerance', () => {
  it('never moves a vertex and never removes one farther than the tolerance (property, UTM)', () => {
    const r = rng(7);
    for (let trial = 0; trial < 60; trial++) {
      const closed = trial % 2 === 0;
      const n = 20 + Math.floor(r() * 200);
      const ox = 612345.678;
      const oy = 2534210.004;
      const pts: Vertex[] = [];
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        const rad = 50 + 5 * Math.sin(5 * t) + (r() - 0.5) * 0.4;
        pts.push({ x: ox + rad * Math.cos(t), y: oy + rad * Math.sin(t) });
      }
      if (trial % 5 === 0) pts[3] = { ...pts[3], bulge: 0.3 };
      const tol = [0.01, 0.1, 0.5, 2][trial % 4];
      const res = simplifyGeometry(poly(pts, closed), tol);
      if (!res) continue;
      const out = (res.geometry as ReturnType<typeof poly>).pts;
      // Kept vertices are input vertices, unchanged and in order.
      let k = 0;
      for (const v of out) {
        while (k < n && (pts[k].x !== v.x || pts[k].y !== v.y)) k++;
        expect(k, 'kept vertex is an input vertex').toBeLessThan(n);
      }
      for (const v of pts) expect(distToPolyline(v, out, closed)).toBeLessThanOrEqual(tol + 1e-9);
      expect(res.removed).toBe(n - out.length);
    }
  });

  it('works per ring on areas with holes and keeps arcs', () => {
    const outer: Vertex[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0.001 },
      { x: 10, y: 0 },
      { x: 10, y: 10, bulge: 0.4 },
      { x: 0, y: 10 },
    ];
    const hole: Vertex[] = [
      { x: 2, y: 2 },
      { x: 2, y: 8 },
      { x: 5, y: 8.0005 },
      { x: 8, y: 8 },
      { x: 8, y: 2 },
    ];
    const res = simplifyGeometry({ type: 'multipolygon', rings: [outer, hole] }, 0.01)!;
    const rings = (res.geometry as Extract<Geometry, { type: 'multipolygon' }>).rings;
    expect(rings[0]).toHaveLength(4);
    expect(rings[0].find((v) => v.bulge)).toEqual({ x: 10, y: 10, bulge: 0.4 });
    expect(rings[1]).toHaveLength(4);
    expect(res.removed).toBe(2);
    expect(simplifyGeometry({ type: 'circle', c: { x: 0, y: 0 }, r: 1 }, 1)).toBeNull();
  });
});

describe('vertex editing', () => {
  const square = poly(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    true,
  );

  it('inserts a snapped point exactly when it lies on the segment, else its projection', () => {
    const seg = nearestSegment(square, { x: 4, y: 0.2 }, 0.005)!;
    expect(seg).toMatchObject({ ring: 0, index: 0 });
    const exact = insertVertexAt(square, seg, { x: 3.3333333333333335, y: 0 }, 0.005, 1e-6)!;
    expect((exact as ReturnType<typeof poly>).pts[1]).toEqual({ x: 3.3333333333333335, y: 0 });
    const projected = insertVertexAt(square, seg, { x: 4, y: 0.2 }, 0.005, 1e-6)!;
    expect((projected as ReturnType<typeof poly>).pts[1]).toEqual({ x: 4, y: 0 });
    expect(area(projected)).toBeCloseTo(100, 12);
  });

  it('inserting on an arc keeps both halves on the circle; midpoint "+" grips insert and move', () => {
    const arcPoly = poly(
      [
        { x: 0, y: 0, bulge: 1 },
        { x: 10, y: 0 },
      ],
      false,
    );
    const mids = segmentMidpoints(arcPoly);
    expect(mids).toHaveLength(1);
    expect(mids[0].pt.x).toBeCloseTo(5, 12);
    expect(mids[0].pt.y).toBeCloseTo(-5, 12);
    const same = insertAndMove(arcPoly, mids[0], mids[0].pt) as ReturnType<typeof poly>;
    expect(same.pts).toHaveLength(3);
    expect(polylineLength(same.pts, false)).toBeCloseTo(Math.PI * 5, 9);
    const moved = insertAndMove(square, segmentMidpoints(square)[1], { x: 15, y: 5 }) as ReturnType<
      typeof poly
    >;
    expect(moved.pts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 15, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  it('removes vertices but keeps at least a triangle / a segment', () => {
    const v = nearestVertex(square, { x: 9.9, y: 10.1 }, 0.005)!;
    expect(v).toMatchObject({ ring: 0, index: 2 });
    const tri = removeVertexAt(square, v, 0.005) as ReturnType<typeof poly>;
    expect(tri.pts).toHaveLength(3);
    expect(removeVertexAt(tri, { ring: 0, index: 0 }, 0.005)).toBeNull();
  });

  it('converts a segment to an arc through a point and back to a line', () => {
    const arc = convertSegmentAt(
      square,
      { ring: 0, index: 0 },
      { kind: 'arc', through: { x: 5, y: -5 } },
      0.005,
    )!;
    const p = (arc as ReturnType<typeof poly>).pts;
    expect(p[0].bulge).toBeCloseTo(1, 12); // left → right below the chord: counter-clockwise
    const a = bulgeToArc(p[0], p[1], p[0].bulge!)!;
    expect(a.r).toBeCloseTo(5, 12);
    const line = convertSegmentAt(arc, { ring: 0, index: 0 }, 'line', 0.005)!;
    expect(line).toEqual(square);
  });
});

describe('split, join, reverse, close/open, duplicates', () => {
  const open = poly(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0, bulge: 0.5 },
      { x: 20, y: 0 },
      { x: 30, y: 5 },
    ],
    false,
  );

  it('splits at a vertex and at a point on a segment; closed outlines open at the point', () => {
    const atVertex = splitGeometryAt(open, { vertex: 2 }, 0.005)!;
    expect(atVertex).toHaveLength(2);
    expect((atVertex[0] as ReturnType<typeof poly>).pts.at(-1)).toEqual({ x: 20, y: 0 });
    expect((atVertex[1] as ReturnType<typeof poly>).pts[0]).toEqual({ x: 20, y: 0 });
    const onArc = splitGeometryAt(open, { segment: 1, t: 0.5 }, 0.005)!;
    const total = onArc.reduce((s, g) => s + polylineLength((g as ReturnType<typeof poly>).pts, false), 0);
    expect(total).toBeCloseTo(polylineLength(open.pts, false), 9);
    expect(splitGeometryAt(open, { vertex: 0 }, 0.005)).toBeNull();
    const ring = splitGeometryAt(
      { type: 'rect', c: { x: 0, y: 0 }, w: 4, h: 2, rot: 0 },
      { segment: 0, t: 0.5 },
      0.005,
    )!;
    expect(ring).toHaveLength(1);
    expect(ring[0]).toMatchObject({ type: 'polyline', closed: false });
    expect(polylineLength((ring[0] as ReturnType<typeof poly>).pts, false)).toBeCloseTo(12, 12);
  });

  it('joins open polylines whose ends meet within the tolerance (closing when they form a ring)', () => {
    const a = poly(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      false,
    );
    const b = poly(
      [
        { x: 10.04, y: 10 },
        { x: 10.04, y: 0.02 },
      ],
      false,
    );
    const c = poly(
      [
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 0, y: 0.05 },
      ],
      false,
    );
    const far = poly(
      [
        { x: 50, y: 50 },
        { x: 60, y: 50 },
      ],
      false,
    );
    const r = joinGeometries([a, far, b, c], 0.1)!;
    expect(r.used.sort()).toEqual([0, 2, 3]);
    expect(r.geometry).toMatchObject({ type: 'polyline', closed: true });
    // Joints keep the first polyline's coordinates; the closing gap is dropped.
    expect((r.geometry as ReturnType<typeof poly>).pts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10.04, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(joinGeometries([a, far], 0.1)).toBeNull();
  });

  it('reverse, close/open and duplicate removal', () => {
    const rev = reverseGeometry(open, 0.005) as ReturnType<typeof poly>;
    expect(rev.pts[0]).toEqual({ x: 30, y: 5 });
    expect(rev.pts[1]).toEqual({ x: 20, y: 0, bulge: -0.5 });
    expect(polylineLength(rev.pts, false)).toBeCloseTo(polylineLength(open.pts, false), 12);
    const closed = closeGeometry(open, 0.005)!;
    expect(closed).toMatchObject({ type: 'polyline', closed: true });
    expect(openGeometry(closed, 0.005)).toEqual(open);
    expect(closeGeometry(closed, 0.005)).toBeNull();
    expect(openGeometry({ type: 'rect', c: { x: 0, y: 0 }, w: 2, h: 2, rot: 0 }, 0.005)).toMatchObject({
      type: 'polyline',
      closed: false,
    });
    const dup = poly(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 1e-7 },
        { x: 5, y: 5 },
        { x: 0, y: 0 },
      ],
      true,
    );
    const d = dedupeGeometry(dup, 1e-6)!;
    expect(d.removed).toBe(3);
    expect((d.geometry as ReturnType<typeof poly>).pts).toHaveLength(3);
    expect(dedupeGeometry(d.geometry, 1e-6)).toBeNull();
  });
});
