import { describe, expect, it } from 'vitest';

import type { Pt, Vertex } from '@/core/types';
import { polylineSignedArea } from '@/geometry/polyline-edit';
import { primsFromPolyline, type Prim } from '@/geometry/prims';
import { EntityStoreBuilder, ET, FLAG, GK } from '@/underlay/entity-store';
import { findBoundary, findBoundaryFromStore, type BoundaryOptions } from './boundary';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P = (x: number, y: number): Pt => ({ x, y });
const seg = (a: Pt, b: Pt): Prim => ({ k: 'seg', a, b });
const opts = (o: Partial<BoundaryOptions> = {}): BoundaryOptions => ({
  gapTol: 0.05,
  detectIslands: true,
  chordTol: 0.005,
  ...o,
});

function box(x0: number, y0: number, x1: number, y1: number): Prim[] {
  return [
    seg(P(x0, y0), P(x1, y0)),
    seg(P(x1, y0), P(x1, y1)),
    seg(P(x1, y1), P(x0, y1)),
    seg(P(x0, y1), P(x0, y0)),
  ];
}

function expectRing(pts: Vertex[], corners: Pt[]) {
  expect(pts).toHaveLength(corners.length);
  const start = corners.findIndex((c) => c.x === pts[0].x && c.y === pts[0].y);
  expect(start, `ring starts at a corner: ${JSON.stringify(pts[0])}`).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < corners.length; i++) {
    const c = corners[(start + i) % corners.length];
    expect({ x: pts[i].x, y: pts[i].y }).toEqual(c);
    expect(pts[i].bulge ?? 0).toBe(0);
  }
}

/**
 * A rectangular bund drawn as separate lines: each side in two pieces with a 2–5 cm gap, and a
 * different gap/overshoot style at every corner. Returns the lines (shuffled, random directions).
 */
function bund(c0: Pt, w: number, h: number, r: () => number): { prims: Prim[]; corners: Pt[] } {
  const corners = [c0, P(c0.x + w, c0.y), P(c0.x + w, c0.y + h), P(c0.x, c0.y + h)];
  const g = () => 0.02 + r() * 0.03;
  const lines: [Pt, Pt][] = [];
  const along = (a: Pt, b: Pt, d: number): Pt => {
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    return d === 0 ? a : P(a.x + ((b.x - a.x) / l) * d, a.y + ((b.y - a.y) / l) * d);
  };
  // Corner styles: how far the incoming side stops before (−overshoot) its end corner, and how far
  // the outgoing side starts after its start corner.
  const styles: [number, number][] = [
    [0, g()], // incoming reaches the corner, outgoing starts short
    [0.03, 0.03], // both short (endpoint distance ≈ 4.2 cm)
    [-0.03, 0], // incoming overshoots, outgoing starts exactly at the corner
    [-0.025, 0.03], // incoming overshoots, outgoing starts short
  ];
  for (let s = 0; s < 4; s++) {
    const a = corners[s];
    const b = corners[(s + 1) % 4];
    const len = s % 2 === 0 ? w : h;
    const [, startGap] = styles[s];
    const [endGap] = styles[(s + 1) % 4];
    const mid = len * (0.3 + r() * 0.4);
    const gap = g();
    const p0 = along(a, b, startGap);
    const p1 = along(a, b, mid - gap / 2);
    const p2 = along(a, b, mid + gap / 2);
    const p3 = endGap === 0 ? b : along(a, b, len - endGap);
    lines.push([p0, p1], [p2, p3]);
  }
  const prims = lines.map(([a, b]) => (r() < 0.5 ? seg(a, b) : seg(b, a)));
  for (let i = prims.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [prims[i], prims[j]] = [prims[j], prims[i]];
  }
  return { prims, corners };
}

describe('findBoundary: basics', () => {
  it('square of four lines: outer is CCW with exact corners; outside is null', () => {
    const prims = box(0, 0, 10, 10);
    const res = findBoundary(prims, P(5, 5), opts())!;
    expectRing(res.outer, [P(0, 0), P(10, 0), P(10, 10), P(0, 10)]);
    expect(polylineSignedArea(res.outer)).toBe(100);
    expect(res.holes).toEqual([]);
    expect(findBoundary(prims, P(15, 5), opts())).toBeNull();
    expect(findBoundary([], P(0, 0), opts())).toBeNull();
    expect(findBoundary([{ k: 'point', p: P(0, 0) }], P(0, 0), opts())).toBeNull();
  });

  it('open geometry (not enclosed) returns null', () => {
    const prims = [seg(P(0, 0), P(10, 0)), seg(P(10, 0), P(10, 10)), seg(P(10, 10), P(0, 10))];
    expect(findBoundary(prims, P(5, 5), opts())).toBeNull();
  });

  it('crossing lines (# pattern): the middle cell from intersection points', () => {
    const prims = [
      seg(P(0, 3), P(10, 3)),
      seg(P(0, 7), P(10, 7)),
      seg(P(3, 0), P(3, 10)),
      seg(P(7, 0), P(7, 10)),
    ];
    const res = findBoundary(prims, P(5, 5), opts())!;
    expectRing(res.outer, [P(3, 3), P(7, 3), P(7, 7), P(3, 7)]);
    expect(findBoundary(prims, P(1, 1), opts())).toBeNull();
  });

  it('rooms sharing walls: the picked room only; collinear T-joints are merged away', () => {
    const prims = [...box(0, 0, 20, 10), seg(P(10, 0), P(10, 10)), seg(P(10, 5), P(20, 5))];
    expectRing(findBoundary(prims, P(5, 5), opts())!.outer, [P(0, 0), P(10, 0), P(10, 10), P(0, 10)]);
    expectRing(findBoundary(prims, P(15, 2), opts())!.outer, [P(10, 0), P(20, 0), P(20, 5), P(10, 5)]);
    expectRing(findBoundary(prims, P(15, 8), opts())!.outer, [P(10, 5), P(20, 5), P(20, 10), P(10, 10)]);
  });

  it('duplicate and overlapping lines do not create slivers', () => {
    const prims = [
      ...box(0, 0, 10, 10),
      ...box(0, 0, 10, 10),
      seg(P(-5, 0), P(5, 0)),
      seg(P(2, 10), P(8, 10)),
    ];
    expectRing(findBoundary(prims, P(5, 5), opts())!.outer, [P(0, 0), P(10, 0), P(10, 10), P(0, 10)]);
  });

  it('dangling lines inside are pruned; a line bridging to an island is ignored', () => {
    const prims = [
      ...box(0, 0, 20, 20),
      seg(P(5, 5), P(8, 8)),
      seg(P(20, 10), P(15, 10)),
      ...box(12, 12, 16, 16),
      seg(P(0, 14), P(12, 14)),
    ];
    const res = findBoundary(prims, P(3, 3), opts())!;
    expectRing(res.outer, [P(0, 0), P(20, 0), P(20, 20), P(0, 20)]);
    expect(res.holes).toHaveLength(1);
    expectRing(res.holes[0], [P(12, 12), P(12, 16), P(16, 16), P(16, 12)]);
    expect(polylineSignedArea(res.holes[0])).toBe(-16);
  });
});

describe('findBoundary: bunds with gaps (accept tests)', () => {
  it('bund drawn as separate lines with 2–5 cm gaps returns the bund outline with exact corners', () => {
    const r = rng(52);
    for (let trial = 0; trial < 20; trial++) {
      const c0 = P(612000.125 + trial * 0.37, 2534000.375 - trial * 0.11);
      const { prims, corners } = bund(c0, 40, 25, r);
      const pick = P(c0.x + 5 + r() * 30, c0.y + 3 + r() * 19);
      const res = findBoundary(prims, pick, opts())!;
      expect(res, `trial ${trial}`).not.toBeNull();
      expectRing(res.outer, corners);
      expect(polylineSignedArea(res.outer)).toBeCloseTo(1000, 6);
    }
  });

  it('rotated bund: corners reached by one of their lines stay exact', () => {
    const c = P(600123.456, 2500789.012);
    const ang = 0.4636;
    const corners = [P(-20, -12), P(20, -12), P(20, 12), P(-20, 12)].map((p) => ({
      x: c.x + p.x * Math.cos(ang) - p.y * Math.sin(ang),
      y: c.y + p.x * Math.sin(ang) + p.y * Math.cos(ang),
    }));
    const prims: Prim[] = [];
    for (let s = 0; s < 4; s++) {
      const a = corners[s];
      const b = corners[(s + 1) % 4];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      // Each side starts 4 cm after its start corner and reaches its end corner exactly.
      const g = 0.04 / l;
      prims.push(seg(P(a.x + (b.x - a.x) * g, a.y + (b.y - a.y) * g), b));
    }
    const res = findBoundary(prims, c, opts())!;
    expectRing(res.outer, corners);
  });

  it('a gap between a line and an arc is closed', () => {
    const prims: Prim[] = [
      seg(P(0, 0), P(8, 0)),
      { k: 'arc', c: P(8, 2), r: 2, a0: -Math.PI / 2 + 0.01, a1: 0 },
      seg(P(10, 2), P(10, 10)),
      seg(P(10, 10), P(0, 10)),
      seg(P(0, 10), P(0, 0)),
    ];
    const res = findBoundary(prims, P(5, 5), opts())!;
    expect(res).not.toBeNull();
    expect(res.outer.filter((v) => v.bulge)).toHaveLength(1);
    expect(polylineSignedArea(res.outer)).toBeCloseTo(100 - (4 - Math.PI), 1);
  });

  it('without gap closing the same bund is not enclosed', () => {
    const { prims, corners } = bund(P(612000.125, 2534000.375), 40, 25, rng(1));
    expect(findBoundary(prims, P(corners[0].x + 20, corners[0].y + 10), opts({ gapTol: 0 }))).toBeNull();
  });

  it('a bund containing a circular tank returns the tank as a hole (islands on)', () => {
    const r = rng(9);
    const c0 = P(612000.125, 2534000.375);
    const { prims, corners } = bund(c0, 40, 25, r);
    const tc = P(c0.x + 25.5, c0.y + 12.25);
    prims.push({ k: 'circle', c: tc, r: 6 });
    const pick = P(c0.x + 5, c0.y + 5);
    const res = findBoundary(prims, pick, opts())!;
    expectRing(res.outer, corners);
    expect(res.holes).toHaveLength(1);
    const hole = res.holes[0];
    expect(hole).toHaveLength(2);
    expect(hole.map((v) => v.bulge)).toEqual([-1, -1]);
    const xs = hole.map((v) => v.x).sort((a, b) => a - b);
    expect(xs).toEqual([tc.x - 6, tc.x + 6]);
    expect(hole.every((v) => v.y === tc.y)).toBe(true);
    expect(polylineSignedArea(hole)).toBeCloseTo(-Math.PI * 36, 9);
    // Islands off: no holes.
    expect(findBoundary(prims, pick, opts({ detectIslands: false }))!.holes).toEqual([]);
    // Picking inside the tank returns the tank (CCW, exact).
    const inTank = findBoundary(prims, P(tc.x + 1, tc.y + 1), opts())!;
    expect(inTank.outer.map((v) => v.bulge)).toEqual([1, 1]);
    expect(polylineSignedArea(inTank.outer)).toBeCloseTo(Math.PI * 36, 9);
    expect(inTank.holes).toEqual([]);
  });

  it('nested islands: only the outermost island inside the face is a hole', () => {
    const prims: Prim[] = [
      ...box(0, 0, 50, 50),
      { k: 'circle', c: P(25, 25), r: 10 },
      { k: 'circle', c: P(25, 25), r: 3 },
      ...box(40, 40, 45, 45),
    ];
    const res = findBoundary(prims, P(2, 2), opts())!;
    expect(res.holes).toHaveLength(2);
    const areas = res.holes.map((h) => polylineSignedArea(h)).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(-Math.PI * 100, 9);
    expect(areas[1]).toBeCloseTo(-25, 9);
    // Between the two circles: annulus with the small circle as its hole.
    const ring = findBoundary(prims, P(25, 31), opts())!;
    expect(polylineSignedArea(ring.outer)).toBeCloseTo(Math.PI * 100, 9);
    expect(ring.holes).toHaveLength(1);
    expect(polylineSignedArea(ring.holes[0])).toBeCloseTo(-Math.PI * 9, 9);
  });

  it('a wall stopping short of another wall is extended onto it (T gap)', () => {
    const prims = [...box(0, 0, 20, 10), seg(P(10, 0.04), P(10, 10))];
    const res = findBoundary(prims, P(5, 5), opts())!;
    expectRing(res.outer, [P(0, 0), P(10, 0), P(10, 10), P(0, 10)]);
  });

  it('a dangling end near a vertex snaps to it; near an arc it snaps onto the arc', () => {
    // Diagonal line ending 3 cm from the corner (10, 10) at an angle that misses both walls.
    const prims = [...box(0, 0, 10, 10), seg(P(0, 0), P(9.98, 9.978))];
    const res = findBoundary(prims, P(8, 2), opts())!;
    expect(res.outer).toHaveLength(3);
    expect(polylineSignedArea(res.outer)).toBeCloseTo(50, 1);
    // Line ending 2 cm outside a circle: snapped onto the circle.
    const prims2: Prim[] = [
      { k: 'circle', c: P(0, 0), r: 5 },
      seg(P(-5, 0), P(0, 0)),
      seg(P(0, 0), P(0, 4.98)),
    ];
    const res2 = findBoundary(prims2, P(-1, 1), opts())!;
    expect(polylineSignedArea(res2.outer)).toBeCloseTo((Math.PI * 25) / 4, 1);
  });

  it('works at large UTM coordinates with arcs (rounded bund corner)', () => {
    const o = P(600000.5, 2500000.25);
    const pts: Vertex[] = [
      { x: o.x, y: o.y },
      { x: o.x + 100, y: o.y },
      { x: o.x + 100, y: o.y + 50, bulge: Math.tan(Math.PI / 8) },
      { x: o.x + 90, y: o.y + 60 },
      { x: o.x, y: o.y + 60 },
    ];
    // Drawn as separate entities: the line prims and the arc prim.
    const prims = primsFromPolyline(pts, true);
    const res = findBoundary(prims, P(o.x + 50, o.y + 30), opts())!;
    expect(res.outer).toHaveLength(5);
    const arcV = res.outer.find((v) => v.bulge)!;
    expect(arcV.bulge).toBeCloseTo(Math.tan(Math.PI / 8), 9);
    expect({ x: arcV.x, y: arcV.y }).toEqual({ x: o.x + 100, y: o.y + 50 });
    for (const v of res.outer) expect(pts.some((p) => p.x === v.x && p.y === v.y)).toBe(true);
    expect(polylineSignedArea(res.outer)).toBeCloseTo(polylineSignedArea(pts), 6);
  });

  it('a line crossing a circle splits it; arcs on the face merge back per source circle', () => {
    const prims: Prim[] = [{ k: 'circle', c: P(0, 0), r: 10 }, seg(P(-20, 0), P(20, 0))];
    const top = findBoundary(prims, P(0, 5), opts())!;
    expect(top.outer).toHaveLength(2);
    expect(polylineSignedArea(top.outer)).toBeCloseTo(Math.PI * 50, 9);
    expect(top.outer.map((v) => ({ x: v.x, y: v.y }))).toContainEqual({ x: 10, y: 0 });
    expect(top.outer.map((v) => ({ x: v.x, y: v.y }))).toContainEqual({ x: -10, y: 0 });
  });

  it('ellipses are tessellated within chordTol', () => {
    const prims: Prim[] = [{ k: 'ellipse', c: P(0, 0), major: P(10, 0), ratio: 0.5, t0: 0, t1: 2 * Math.PI }];
    const res = findBoundary(prims, P(1, 1), opts({ chordTol: 0.001 }))!;
    expect(polylineSignedArea(res.outer)).toBeCloseTo(Math.PI * 50, 1);
    expect(res.outer.length).toBeGreaterThan(50);
  });

  it('a nearly closed arc closes across its gap', () => {
    const prims: Prim[] = [{ k: 'arc', c: P(0, 0), r: 5, a0: 0.005, a1: 2 * Math.PI - 0.005 }];
    const res = findBoundary(prims, P(0, 0), opts())!;
    expect(res).not.toBeNull();
    expect(polylineSignedArea(res.outer)).toBeCloseTo(Math.PI * 25, 0);
  });

  it('an arc overshooting a wall by less than gapTol is trimmed at the wall', () => {
    // Quarter arc from (10, 0) round to (0, 10) that overshoots the y axis slightly.
    const r = 10;
    const over = 0.003; // radians ≈ 3 cm along the arc
    const prims: Prim[] = [
      seg(P(0, 0), P(10, 0)),
      seg(P(0, 0), P(0, 10.5)),
      { k: 'arc', c: P(0, 0), r, a0: 0, a1: Math.PI / 2 + over },
    ];
    // Coarse and fine tessellation (the fine one makes the stub a multi-chord path).
    for (const chordTol of [0.005, 1e-6]) {
      const res = findBoundary(prims, P(2, 2), opts({ chordTol }))!;
      expect(res.outer).toHaveLength(3);
      expect(polylineSignedArea(res.outer)).toBeCloseTo((Math.PI * r * r) / 4, 6);
    }
  });

  it('several walls stopping short of the same wall split it in order', () => {
    const prims = [...box(0, 0, 30, 10), seg(P(10, 0.03), P(10, 10)), seg(P(20, 0.04), P(20, 10))];
    expectRing(findBoundary(prims, P(15, 5), opts())!.outer, [P(10, 0), P(20, 0), P(20, 10), P(10, 10)]);
    expectRing(findBoundary(prims, P(25, 5), opts())!.outer, [P(20, 0), P(30, 0), P(30, 10), P(20, 10)]);
  });

  it('high-degree nodes: 48 spokes through one point', () => {
    const prims: Prim[] = [{ k: 'circle', c: P(0, 0), r: 10 }];
    const n = 48;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      prims.push(seg(P(0, 0), P(12 * Math.cos(a), 12 * Math.sin(a))));
    }
    const a = (0.5 / n) * 2 * Math.PI;
    const res = findBoundary(prims, P(5 * Math.cos(a), 5 * Math.sin(a)), opts())!;
    expect(res.outer).toHaveLength(3);
    expect(res.outer.some((v) => v.x === 0 && v.y === 0)).toBe(true);
    expect(polylineSignedArea(res.outer)).toBeCloseTo((Math.PI * 100) / n, 6);
  });

  it('arc runs of the same circle split at outside junctions are merged back', () => {
    // A circle touched from outside by a line at its top: the inside face merges the two quarter arcs.
    const prims: Prim[] = [{ k: 'circle', c: P(0, 0), r: 10 }, seg(P(0, 10), P(0, 20))];
    const res = findBoundary(prims, P(1, 1), opts())!;
    expect(res.outer.map((v) => v.bulge)).toEqual([1, 1]);
  });

  it('grows the window when an arc of the face bulges beyond it', () => {
    // A near-full circle closed by a short chord; the pick sits next to the chord.
    const prims: Prim[] = [{ k: 'arc', c: P(0, 0), r: 50, a0: -Math.PI / 2 + 0.02, a1: -Math.PI / 2 - 0.02 }];
    const ends = [P(50 * Math.cos(-Math.PI / 2 + 0.02), 50 * Math.sin(-Math.PI / 2 + 0.02))];
    ends.push(P(-ends[0].x, ends[0].y));
    prims.push(seg(ends[1], ends[0]));
    const res = findBoundary(prims, P(0, ends[0].y + 0.2), opts())!;
    expect(res).not.toBeNull();
    expect(polylineSignedArea(res.outer)).toBeGreaterThan(Math.PI * 2500 * 0.99);
  });

  it('respects maxSegments', () => {
    const prims = box(0, 0, 10, 10);
    expect(findBoundary(prims, P(5, 5), opts({ maxSegments: 2 }))).toBeNull();
  });
});

describe('findBoundaryFromStore', () => {
  it('skips derived, hidden and text entities; reads lines, polylines, circles and fills', () => {
    const b = new EntityStoreBuilder();
    const B = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const add = (type: number, kind: number, v: number[], flags = 0) =>
      b.add({ type: type as never, layer: 0, color: 0, flags }, kind as never, v, B);
    const o = P(612000.125, 2534000.375);
    const ids = [
      add(ET.LINE, GK.LINE, [o.x, o.y, o.x + 30, o.y]),
      add(ET.LINE, GK.LINE, [o.x + 30, o.y, o.x + 30, o.y + 20]),
      add(ET.LWPOLYLINE, GK.POLY, [3, o.x + 30, o.y + 20, 0, o.x, o.y + 20, 0, o.x, o.y + 0.03, 0]),
      // A derived hatch pattern line and a hidden line across the region must be ignored.
      add(ET.LINE, GK.LINE, [o.x + 10, o.y - 5, o.x + 10, o.y + 25], FLAG.DERIVED),
      add(ET.LINE, GK.LINE, [o.x + 20, o.y - 5, o.x + 20, o.y + 25], FLAG.HIDDEN),
      add(ET.TEXT, GK.TEXT, [o.x + 5, o.y + 5, 1, 0, 1, 0, 0, 0, 0, 1]),
      add(ET.POINT, GK.POINT, [o.x + 6, o.y + 6]),
      add(ET.CIRCLE, GK.CIRCLE, [o.x + 25, o.y + 10, 2]),
      add(ET.HATCH, GK.FILL, [
        1,
        4,
        o.x + 2,
        o.y + 2,
        0,
        o.x + 4,
        o.y + 2,
        0,
        o.x + 4,
        o.y + 4,
        0,
        o.x + 2,
        o.y + 4,
        0,
      ]),
    ];
    const store = b.finish();
    const res = findBoundaryFromStore(store, [...ids, -1, 99], P(o.x + 15, o.y + 10), opts())!;
    expectRing(res.outer, [o, P(o.x + 30, o.y), P(o.x + 30, o.y + 20), P(o.x, o.y + 20)]);
    expect(res.holes).toHaveLength(2);
    // Only a subset of entities (e.g. the visible ones) is considered.
    expect(findBoundaryFromStore(store, [ids[0], ids[1]], P(o.x + 15, o.y + 10), opts())).toBeNull();
  });
});

describe('findBoundary: performance', () => {
  it('50 000 segments: local and whole-site picks', () => {
    const r = rng(2026);
    const o = P(600000, 2500000);
    const prims: Prim[] = [...box(o.x - 10, o.y - 10, o.x + 2000, o.y + 2000)];
    const n = 110;
    const pitch = 18;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = o.x + i * pitch;
        const y = o.y + j * pitch;
        const corners = [P(x, y), P(x + 10, y), P(x + 10, y + 10), P(x, y + 10)];
        for (let k = 0; k < 4; k++) {
          const a = corners[k];
          const b = corners[(k + 1) % 4];
          // Every 7th building has a 3 cm gap at one corner.
          const short = (i * n + j) % 7 === 0 && k === 1;
          const a2 = short ? P(a.x, a.y + 0.03) : a;
          prims.push(seg(a2, b));
        }
      }
    }
    while (prims.length < 50000) {
      // Short random lines in the yards between buildings (some touch or cross buildings).
      const x = o.x + r() * 1980;
      const y = o.y + r() * 1980;
      const a = r() * Math.PI * 2;
      prims.push(seg(P(x, y), P(x + Math.cos(a) * 3, y + Math.sin(a) * 3)));
    }
    expect(prims.length).toBe(50000);

    let t0 = performance.now();
    const local = findBoundary(prims, P(o.x + 55 * pitch + 5, o.y + 55 * pitch + 5), opts());
    const tLocal = performance.now() - t0;
    expect(local).not.toBeNull();
    expect(polylineSignedArea(local!.outer)).toBeGreaterThan(0);

    t0 = performance.now();
    const site = findBoundary(prims, P(o.x - 5, o.y + 1000), opts());
    const tSite = performance.now() - t0;
    expect(site).not.toBeNull();
    expectRing(site!.outer, [
      P(o.x - 10, o.y - 10),
      P(o.x + 2000, o.y - 10),
      P(o.x + 2000, o.y + 2000),
      P(o.x - 10, o.y + 2000),
    ]);
    expect(site!.holes.length).toBeGreaterThan(11000);

    t0 = performance.now();
    const none = findBoundary(prims, P(o.x - 100, o.y - 100), opts());
    const tNone = performance.now() - t0;
    expect(none).toBeNull();

    // Coverage instrumentation slows execution several-fold; the 2 s budget applies to plain runs.
    const worker = (globalThis as { __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } } })
      .__vitest_worker__;
    const budget = worker?.config?.coverage?.enabled ? 10000 : 2000;
    console.log(
      `[boundary perf] 50 000 segments: local pick ${tLocal.toFixed(0)} ms, whole-site pick ${tSite.toFixed(0)} ms ` +
        `(${site!.holes.length} islands), outside pick ${tNone.toFixed(0)} ms; budget ${budget} ms`,
    );
    expect(tSite).toBeLessThan(budget);
    expect(tLocal).toBeLessThan(budget);
  }, 30000);
});
