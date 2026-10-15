import { describe, expect, it } from 'vitest';

import type { Geometry, Pt, Vertex } from '@/core/types';

import { toRings } from './convert';
import { distanceToGeometry } from './hit';
import { area, perimeter, signedArea } from './measure';
import {
  OFFSET_MESSAGES,
  intervalDistances,
  multiRingOffsets,
  offsetGeometry,
  type OffsetJoin,
  type OffsetOptions,
} from './offset';

const TOL = 0.005; // FDR default chord tolerance (5 mm)
const MM = 0.001;
const round: OffsetOptions = { join: 'round', chordTol: TOL };

type Polyline = Extract<Geometry, { type: 'polyline' }>;
type Multi = Extract<Geometry, { type: 'multipolygon' }>;

/** All result vertices (straight-segment results from Clipper). */
function vertices(g: Geometry): Pt[] {
  if (g.type === 'polyline') return g.pts;
  if (g.type === 'multipolygon') return g.rings.flat();
  throw new Error(`unexpected ${g.type}`);
}

function ringsOf(g: Geometry): Vertex[][] {
  if (g.type === 'polyline') return [g.pts];
  if (g.type === 'multipolygon') return g.rings;
  throw new Error(`unexpected ${g.type}`);
}

/** Max |dist(v, source boundary) − |d|| over result vertices. */
function maxDistanceError(result: Geometry, source: Geometry, d: number): number {
  let worst = 0;
  for (const v of vertices(result))
    worst = Math.max(worst, Math.abs(distanceToGeometry(v, source) - Math.abs(d)));
  return worst;
}

const square = (x0: number, y0: number, s: number): Vertex[] => [
  { x: x0, y: y0 },
  { x: x0 + s, y: y0 },
  { x: x0 + s, y: y0 + s },
  { x: x0, y: y0 + s },
];

/** Concave star polygon (n tips) centred at c. */
function star(c: Pt, n: number, rOut: number, rIn: number, phase = 0.1): Vertex[] {
  const pts: Vertex[] = [];
  for (let i = 0; i < 2 * n; i++) {
    const r = i % 2 === 0 ? rOut : rIn;
    const a = phase + (Math.PI * i) / n;
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return pts;
}

describe('circle, arc and point offsets (row 55)', () => {
  it('offsets circles exactly', () => {
    const c: Geometry = { type: 'circle', c: { x: 600_000, y: 2_500_000 }, r: 10 };
    expect(offsetGeometry(c, 5, round)).toEqual({ geometry: { type: 'circle', c: c.c, r: 15 } });
    expect(offsetGeometry(c, -4, { join: 'miter', chordTol: TOL }).geometry).toEqual({
      type: 'circle',
      c: c.c,
      r: 6,
    });
    expect(offsetGeometry(c, -10, round)).toEqual({
      geometry: null,
      warning: OFFSET_MESSAGES.circleCollapse,
    });
    expect(OFFSET_MESSAGES.circleCollapse).toBe('Contraction removes the circle (r ≤ 0)');
    const same = offsetGeometry(c, 0, round).geometry;
    expect(same).toEqual(c);
    expect(same).not.toBe(c);
  });

  it('offsets arcs concentrically, keeping the angular span', () => {
    const a: Geometry = { type: 'arc', c: { x: 1, y: 2 }, r: 10, a0: 0.5, a1: 2 };
    expect(offsetGeometry(a, 2.5, round).geometry).toEqual({ ...a, r: 12.5 });
    expect(offsetGeometry(a, -2.5, round).geometry).toEqual({ ...a, r: 7.5 });
    expect(offsetGeometry(a, -11, round)).toEqual({ geometry: null, warning: OFFSET_MESSAGES.arcCollapse });
  });

  it('offsets points to circles and rejects contraction', () => {
    expect(offsetGeometry({ type: 'point', p: { x: 1, y: 1 } }, 3, round).geometry).toEqual({
      type: 'circle',
      c: { x: 1, y: 1 },
      r: 3,
    });
    expect(offsetGeometry({ type: 'point', p: { x: 1, y: 1 } }, -3, round).geometry).toBeNull();
  });

  it('validates inputs', () => {
    const c: Geometry = { type: 'circle', c: { x: 0, y: 0 }, r: 1 };
    expect(() => offsetGeometry(c, NaN, round)).toThrow();
    expect(() => offsetGeometry(c, 1, { join: 'round', chordTol: 0 })).toThrow();
  });
});

describe('rectangle offsets (row 56)', () => {
  const rect: Geometry = { type: 'rect', c: { x: 604_321.5, y: 2_503_210.25 }, w: 120, h: 45, rot: 0.6 };
  const d = 15;

  it('round join is the exact Minkowski sum with a disc (4 edges + 4 quarter arcs)', () => {
    const r = offsetGeometry(rect, d, round);
    const g = r.geometry as Polyline;
    expect(g.type).toBe('polyline');
    expect(g.closed).toBe(true);
    expect(g.pts).toHaveLength(8);
    expect(g.pts.filter((v) => v.bulge).map((v) => v.bulge)).toEqual(Array(4).fill(Math.tan(Math.PI / 8)));
    expect(area(g)).toBeCloseTo(120 * 45 + 2 * d * (120 + 45) + Math.PI * d * d, 6);
    expect(perimeter(g)).toBeCloseTo(2 * (120 + 45) + 2 * Math.PI * d, 9);
    // Every point of the analytic boundary is exactly d from the rectangle (NFR-7: within 1 mm; here ~1e-9).
    for (const p of toRings(g, 1e-4)[0]) expect(Math.abs(distanceToGeometry(p, rect) - d)).toBeLessThan(1e-6);
  });

  it('matches the Clipper polygon offset of the same rectangle within 1 mm (NFR-7)', () => {
    const asPolygon: Geometry = { type: 'polyline', pts: toRings(rect, TOL)[0], closed: true };
    const clipper = offsetGeometry(asPolygon, d, round).geometry!;
    const analytic = offsetGeometry(rect, d, round).geometry!;
    // Clipper vertices lie on the analytic boundary (round-join vertices are on the arcs).
    for (const v of vertices(clipper)) expect(distanceToGeometry(v, analytic)).toBeLessThan(MM);
    expect(Math.abs(area(clipper) - area(analytic))).toBeLessThan(TOL * perimeter(analytic));
  });

  it('miter join grows each side by d (square box), falling back to square beyond the miter limit', () => {
    expect(offsetGeometry(rect, d, { join: 'miter', chordTol: TOL }).geometry).toEqual({
      ...rect,
      w: 150,
      h: 75,
    });
    const limited = offsetGeometry(rect, d, { join: 'miter', miterLimit: 1.2, chordTol: TOL }).geometry!;
    const square = offsetGeometry(rect, d, { join: 'square', chordTol: TOL }).geometry!;
    expect(limited).toEqual(square);
  });

  it('bevel and square joins match Clipper semantics', () => {
    const asPolygon: Geometry = { type: 'polyline', pts: toRings(rect, TOL)[0], closed: true };
    const t = Math.tan(Math.PI / 8);
    const expected: Record<string, number> = {
      bevel: 120 * 45 + 2 * d * (120 + 45) + 2 * d * d,
      square: 120 * 45 + 2 * d * (120 + 45) + 4 * (d * d - (d * (1 - t)) ** 2 / 2),
    };
    for (const join of ['bevel', 'square'] as OffsetJoin[]) {
      const g = offsetGeometry(rect, d, { join, chordTol: TOL }).geometry as Polyline;
      expect(g.pts).toHaveLength(8);
      expect(g.pts.every((v) => !v.bulge)).toBe(true);
      expect(area(g)).toBeCloseTo(expected[join], 6);
      const clipper = offsetGeometry(asPolygon, d, { join, chordTol: TOL }).geometry!;
      expect(Math.abs(area(clipper) - area(g))).toBeLessThan(0.01);
      for (const v of vertices(clipper)) expect(distanceToGeometry(v, g)).toBeLessThan(MM);
    }
    // Bevel corners are the offset edge ends: exactly d from the source corners.
    const bevel = offsetGeometry(rect, d, { join: 'bevel', chordTol: TOL }).geometry as Polyline;
    for (const v of bevel.pts) expect(distanceToGeometry(v, rect)).toBeCloseTo(d, 6);
  });

  it('contracts every side by |d| for any join and rejects w or h ≤ 0', () => {
    for (const join of ['round', 'miter', 'square', 'bevel'] as OffsetJoin[]) {
      expect(offsetGeometry(rect, -10, { join, chordTol: TOL }).geometry).toEqual({ ...rect, w: 100, h: 25 });
      expect(offsetGeometry(rect, -22.5, { join, chordTol: TOL })).toEqual({
        geometry: null,
        warning: OFFSET_MESSAGES.rectCollapse,
      });
    }
  });

  it('handles degenerate rectangles (stadium)', () => {
    const line: Geometry = { type: 'rect', c: { x: 0, y: 0 }, w: 10, h: 0, rot: 0 };
    const g = offsetGeometry(line, 2, round).geometry as Polyline;
    expect(g.pts).toHaveLength(6);
    expect(area(g)).toBeCloseTo(40 + Math.PI * 4, 9);
  });
});

describe('polygon and polyline offsets (row 57)', () => {
  const concave: Geometry = {
    type: 'polyline',
    pts: [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
      { x: 25, y: 30 },
      { x: 25, y: 10 }, // reflex corner region
      { x: 15, y: 10 },
      { x: 15, y: 30 },
      { x: 0, y: 30 },
    ],
    closed: true,
  };
  const convex: Geometry = { type: 'polyline', pts: star({ x: 0, y: 0 }, 6, 20, 20), closed: true };
  const holed: Geometry = { type: 'multipolygon', rings: [square(0, 0, 100), square(30, 30, 40)] };

  it('offsets convex polygons (Steiner formula for round joins)', () => {
    const d = 3;
    const g = offsetGeometry(convex, d, round).geometry!;
    expect(g.type).toBe('polyline');
    const expected = area(convex) + perimeter(convex) * d + Math.PI * d * d;
    expect(Math.abs(area(g) - expected)).toBeLessThan(TOL * perimeter(g));
    expect(maxDistanceError(g, convex, d)).toBeLessThan(MM);
    const inner = offsetGeometry(convex, -d, round).geometry!;
    expect(maxDistanceError(inner, convex, d)).toBeLessThan(MM);
    expect(signedArea((inner as Polyline).pts)).toBeGreaterThan(0);
  });

  it('offsets concave polygons with every join', () => {
    for (const join of ['round', 'bevel'] as OffsetJoin[]) {
      for (const d of [2, -2, 4.5]) {
        const g = offsetGeometry(concave, d, { join, chordTol: TOL }).geometry!;
        expect(maxDistanceError(g, concave, d)).toBeLessThan(MM);
      }
    }
    for (const join of ['miter', 'square'] as OffsetJoin[]) {
      const g = offsetGeometry(concave, 2, { join, chordTol: TOL }).geometry!;
      for (const v of vertices(g)) {
        const dist = distanceToGeometry(v, concave);
        expect(dist).toBeGreaterThan(2 - MM);
        expect(dist).toBeLessThan(2 * 2 + MM);
      }
    }
    // Miter: the outer box grows to 44 × 34; the notch narrows from 10 to 6 wide and stays 20 deep.
    const miter = offsetGeometry(concave, 2, { join: 'miter', chordTol: TOL }).geometry!;
    expect(area(miter)).toBeCloseTo(44 * 34 - 6 * 20, 3);
  });

  it('offsets polygons with holes', () => {
    const grown = offsetGeometry(holed, 5, { join: 'miter', chordTol: TOL }).geometry as Multi;
    expect(grown.type).toBe('multipolygon');
    expect(grown.rings).toHaveLength(2);
    expect(area(grown)).toBeCloseTo(110 * 110 - 30 * 30, 2);
    expect(signedArea(grown.rings[0])).toBeGreaterThan(0);
    expect(signedArea(grown.rings[1])).toBeLessThan(0);
    const shrunk = offsetGeometry(holed, -5, { join: 'miter', chordTol: TOL }).geometry as Multi;
    expect(area(shrunk)).toBeCloseTo(90 * 90 - 50 * 50, 2);
    // The hole closes when expanding by more than half its width: a single ring remains (no warning).
    const closedHole = offsetGeometry(holed, 25, round);
    expect(closedHole.geometry?.type).toBe('polyline');
    expect(closedHole.warning).toBeUndefined();
    expect(maxDistanceError(offsetGeometry(holed, 7, round).geometry!, holed, 7)).toBeLessThan(MM);
  });

  it('resolves self-intersections and overlapping rings first', () => {
    const bowtie: Geometry = {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
      closed: true,
    };
    const g = offsetGeometry(bowtie, 1, round).geometry!;
    expect(area(g)).toBeGreaterThan(50);
    expect(maxDistanceError(g, bowtie, 1)).toBeLessThan(MM);
    // Overlapping rings in a multipolygon follow even–odd: the overlap is a hole.
    const overlap: Geometry = { type: 'multipolygon', rings: [square(0, 0, 10), square(5, 0, 10)] };
    const o = offsetGeometry(overlap, -1, { join: 'miter', chordTol: TOL }).geometry!;
    expect(ringsOf(o)).toHaveLength(2);
    expect(area(o)).toBeCloseTo(2 * 3 * 8, 3);
  });

  it('offsets bulge polylines and ellipses within the chord tolerance', () => {
    const pill: Geometry = {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 20, y: 0, bulge: 1 },
        { x: 20, y: 10 },
        { x: 0, y: 10, bulge: 1 },
      ],
      closed: true,
    };
    for (const d of [3, -3]) {
      const g = offsetGeometry(pill, d, round).geometry!;
      expect(maxDistanceError(g, pill, d)).toBeLessThan(TOL + MM);
    }
    const ell: Geometry = { type: 'ellipse', c: { x: 5, y: 5 }, rx: 30, ry: 12, rot: 0.4 };
    for (const d of [4, -4]) {
      const g = offsetGeometry(ell, d, round).geometry!;
      expect(maxDistanceError(g, ell, d)).toBeLessThan(TOL + MM);
    }
    expect(offsetGeometry(ell, -12, round)).toEqual({ geometry: null, warning: OFFSET_MESSAGES.collapse });
  });

  it('warns on full and partial collapse', () => {
    expect(offsetGeometry(concave, -20, round)).toEqual({
      geometry: null,
      warning: 'Contraction collapses the shape',
    });
    const two: Geometry = { type: 'multipolygon', rings: [square(0, 0, 100), square(200, 0, 4)] };
    const r = offsetGeometry(two, -3, round);
    expect(r.geometry?.type).toBe('polyline');
    expect(r.warning).toBe(OFFSET_MESSAGES.partialCollapse(1, 2));
    // A dumbbell splitting into two pieces is not a collapse.
    const dumbbell: Geometry = {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 8 },
        { x: 30, y: 8 },
        { x: 30, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 20 },
        { x: 30, y: 20 },
        { x: 30, y: 12 },
        { x: 20, y: 12 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      closed: true,
    };
    const split = offsetGeometry(dumbbell, -3, round);
    expect(split.warning).toBeUndefined();
    expect((split.geometry as Multi).rings).toHaveLength(2);
    expect(
      offsetGeometry(
        {
          type: 'polyline',
          pts: [
            { x: 0, y: 0 },
            { x: 5, y: 0 },
          ],
          closed: true,
        },
        1,
        round,
      ).warning,
    ).toBe(OFFSET_MESSAGES.noArea);
  });

  it('builds corridors around open polylines with round, butt and square caps', () => {
    const line: Geometry = {
      type: 'polyline',
      pts: [
        { x: 600_000, y: 2_500_000 },
        { x: 600_100, y: 2_500_000 },
      ],
      closed: false,
    };
    const d = 5;
    const roundCap = offsetGeometry(line, d, round).geometry!;
    expect(Math.abs(area(roundCap) - (2 * d * 100 + Math.PI * d * d))).toBeLessThan(
      TOL * perimeter(roundCap),
    );
    expect(maxDistanceError(roundCap, line, d)).toBeLessThan(MM);
    const butt = offsetGeometry(line, d, { join: 'round', cap: 'butt', chordTol: TOL }).geometry!;
    expect(area(butt)).toBeCloseTo(2 * d * 100, 3);
    const sq = offsetGeometry(line, d, { join: 'round', cap: 'square', chordTol: TOL }).geometry!;
    expect(area(sq)).toBeCloseTo(2 * d * 110, 3);
    expect(offsetGeometry(line, -d, round)).toEqual({
      geometry: null,
      warning: OFFSET_MESSAGES.openNegative,
    });
    // An L-shaped path with a mitred inner join.
    const ell: Geometry = {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 50, y: 0, bulge: 0.2 },
        { x: 50, y: 40 },
      ],
      closed: false,
    };
    const corridor = offsetGeometry(ell, 2, { join: 'miter', cap: 'butt', chordTol: TOL }).geometry!;
    for (const v of vertices(corridor)) expect(distanceToGeometry(v, ell)).toBeGreaterThan(2 - TOL - MM);
    // A closed loop drawn as an open polyline gives a ring with a hole (butt ends leave the start corner open).
    const loop: Geometry = { type: 'polyline', pts: [...square(0, 0, 50), { x: 0, y: 0 }], closed: false };
    const ring = offsetGeometry(loop, 2, { join: 'miter', cap: 'butt', chordTol: TOL }).geometry as Multi;
    expect(ring.type).toBe('multipolygon');
    expect(area(ring)).toBeCloseTo(54 * 54 - 46 * 46 - 2 * 2, 2);
    // Single vertex: a disc.
    const dot = offsetGeometry(
      { type: 'polyline', pts: [{ x: 1, y: 1 }], closed: false },
      2,
      round,
    ).geometry!;
    expect(Math.abs(area(dot) - Math.PI * 4)).toBeLessThan(TOL * 4 * Math.PI);
  });
});

describe('multi-ring offsets (row 58)', () => {
  it('returns one result per distance, in order', () => {
    const src: Geometry = { type: 'polyline', pts: square(0, 0, 10), closed: true };
    const res = multiRingOffsets(src, [10, 25, -6, 50], round);
    expect(res).toHaveLength(4);
    expect(res[2]).toEqual({ geometry: null, warning: OFFSET_MESSAGES.collapse });
    const areas = [res[0], res[1], res[3]].map((r) => area(r.geometry!));
    expect(areas[0]).toBeLessThan(areas[1]);
    expect(areas[1]).toBeLessThan(areas[2]);
    expect(Math.abs(areas[2] - (100 + 40 * 50 + Math.PI * 2500))).toBeLessThan(TOL * 400);
    expect(intervalDistances(10, 3)).toEqual([10, 20, 30]);
    expect(intervalDistances(5, 2, 0)).toEqual([0, 5]);
    expect(intervalDistances(5, -1)).toEqual([]);
  });
});

/**
 * V8 block coverage (`--coverage`) instruments every branch and slows code several-fold, so the timing
 * budget is only asserted on plain runs (coverage runs keep a loose sanity bound).
 */
const coverageEnabled =
  (globalThis as { __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } } }).__vitest_worker__
    ?.config?.coverage?.enabled === true;

describe('NFR-6 performance', () => {
  it('offsets a 1 000-vertex polygon in well under 50 ms', () => {
    const poly: Geometry = {
      type: 'polyline',
      pts: Array.from({ length: 1000 }, (_, i) => {
        const a = (2 * Math.PI * i) / 1000;
        const r = 500 + 80 * Math.sin(7 * a) + 30 * Math.cos(23 * a);
        return { x: 600_000 + r * Math.cos(a), y: 2_500_000 + r * Math.sin(a) };
      }),
      closed: true,
    };
    // Warm up the JIT, then time several runs. The minimum is the estimator least affected by other
    // processes sharing the CPU (CI runs test files in parallel); the median is logged too.
    for (let i = 0; i < 3; i++) offsetGeometry(poly, 15, round);
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      const r = offsetGeometry(poly, i % 2 ? -15 : 15, round);
      times.push(performance.now() - t0);
      expect(r.geometry).not.toBeNull();
    }
    times.sort((a, b) => a - b);
    const best = times[0];
    console.log(
      `NFR-6: 1 000-vertex polygon offset ${best.toFixed(2)} ms (median ${times[4].toFixed(2)} ms` +
        `${coverageEnabled ? ', coverage instrumentation on' : ''})`,
    );
    // FDR budget 50 ms, enforced on the reference machine (PAT_PERF_STRICT=1, `npm run perf:reference`);
    // elsewhere 150 ms leaves headroom for shared CI runners.
    expect(best).toBeLessThan(coverageEnabled ? 1000 : process.env.PAT_PERF_STRICT ? 50 : 150);
  });
});

describe('NFR-7 accuracy at UTM coordinates (10 km extents)', () => {
  const site: Geometry = {
    type: 'polyline',
    pts: star({ x: 605_000, y: 2_505_000 }, 9, 5000, 2600, 0.137),
    closed: true,
  };

  it('every result vertex is |d| ± 1 mm from the source boundary (+15 m and −5 m)', () => {
    for (const join of ['round', 'bevel'] as OffsetJoin[]) {
      for (const d of [15, -5]) {
        const r = offsetGeometry(site, d, { join, chordTol: TOL });
        expect(r.warning).toBeUndefined();
        const err = maxDistanceError(r.geometry!, site, d);
        expect(err).toBeLessThan(MM);
      }
    }
  });

  it('straight portions of mitred offsets are exactly |d| away', () => {
    for (const d of [15, -5]) {
      const g = offsetGeometry(site, d, { join: 'miter', miterLimit: 10, chordTol: TOL })
        .geometry as Polyline;
      // Midpoints of result edges lie on the offset lines.
      for (let i = 0; i < g.pts.length; i++) {
        const a = g.pts[i];
        const b = g.pts[(i + 1) % g.pts.length];
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        expect(Math.abs(distanceToGeometry(m, site) - Math.abs(d))).toBeLessThan(MM);
      }
    }
  });

  it('a rotated rectangle at UTM coordinates offsets to the exact Minkowski sum', () => {
    const rect: Geometry = {
      type: 'rect',
      c: { x: 609_876.54, y: 2_507_654.32 },
      w: 9000,
      h: 3000,
      rot: 1.1,
    };
    const g = offsetGeometry(rect, 15, round).geometry!;
    for (const p of toRings(g, 0.01)[0]) expect(Math.abs(distanceToGeometry(p, rect) - 15)).toBeLessThan(MM);
    const clipper = offsetGeometry(
      { type: 'polyline', pts: toRings(rect, TOL)[0], closed: true },
      15,
      round,
    ).geometry!;
    for (const v of vertices(clipper)) expect(distanceToGeometry(v, g)).toBeLessThan(MM);
  });
});
