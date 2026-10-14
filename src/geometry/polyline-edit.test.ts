import { describe, expect, it } from 'vitest';

import type { Vertex } from '@/core/types';
import { bulgeToArc } from './bulge';
import {
  bulgeThrough,
  closePolyline,
  convertSegment,
  insertVertex,
  joinPolylines,
  locateOnPolyline,
  moveVertex,
  openPolyline,
  pointOnSegment,
  polylineSignedArea,
  removeVertex,
  reversePolyline,
  segmentCount,
  splitPolyline,
  type Poly,
} from './polyline-edit';

const open = (...pts: Vertex[]): Poly => ({ pts, closed: false });
const closed = (...pts: Vertex[]): Poly => ({ pts, closed: true });
const square = (): Poly => closed({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 });

describe('basics', () => {
  it('segmentCount', () => {
    expect(segmentCount(open())).toBe(0);
    expect(segmentCount(open({ x: 0, y: 0 }))).toBe(0);
    expect(segmentCount(open({ x: 0, y: 0 }, { x: 1, y: 0 }))).toBe(1);
    expect(segmentCount(closed({ x: 0, y: 0 }))).toBe(0);
    expect(segmentCount(square())).toBe(4);
  });

  it('signed area with bulges', () => {
    expect(polylineSignedArea(square().pts)).toBe(100);
    expect(polylineSignedArea(reversePolyline(square()).pts)).toBe(-100);
    const circle = [
      { x: 0, y: 0, bulge: 1 },
      { x: 2, y: 0, bulge: 1 },
    ];
    expect(polylineSignedArea(circle)).toBeCloseTo(Math.PI, 12);
    expect(polylineSignedArea([{ x: 0, y: 0 }])).toBe(0);
    // Large coordinates keep precision.
    const utm = square().pts.map((v) => ({ x: v.x + 612345.678, y: v.y + 2534210.123 }));
    expect(polylineSignedArea(utm)).toBeCloseTo(100, 6);
  });

  it('pointOnSegment and locateOnPolyline on lines and arcs', () => {
    const p = open({ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 }, { x: 4, y: 0 });
    const m = pointOnSegment(p, 0, 0.5);
    expect(m.p.x).toBeCloseTo(1, 12);
    expect(m.p.y).toBeCloseTo(-1, 12);
    expect(m.b1).toBeCloseTo(Math.tan(Math.PI / 8), 12);
    const loc = locateOnPolyline(p, { x: 1, y: -3 })!;
    expect(loc.index).toBe(0);
    expect(loc.t).toBeCloseTo(0.5, 12);
    expect(loc.dist).toBeCloseTo(2, 12);
    const loc2 = locateOnPolyline(p, { x: 3, y: 1 })!;
    expect(loc2.index).toBe(1);
    expect(loc2.pt).toEqual({ x: 3, y: 0 });
    expect(locateOnPolyline(open({ x: 0, y: 0 }), { x: 1, y: 1 })).toBeNull();
    // Beyond an arc end the parameter clamps to the nearer end.
    expect(locateOnPolyline(open({ x: 0, y: 0, bulge: 0.2 }, { x: 2, y: 0 }), { x: -5, y: 0.1 })!.t).toBe(0);
  });
});

describe('insert / remove / move', () => {
  it('inserts on straight segments (including the closing segment)', () => {
    const r = insertVertex(square(), 3, { x: 0, y: 5 });
    expect(r.pts).toHaveLength(5);
    expect(r.pts[4]).toEqual({ x: 0, y: 5 });
    const r2 = insertVertex(square(), 0, { x: 5, y: 0 });
    expect(r2.pts[1]).toEqual({ x: 5, y: 0 });
    expect(() => insertVertex(square(), 4, { x: 0, y: 0 })).toThrow(RangeError);
  });

  it('inserting on an arc keeps both halves on the original circle', () => {
    const p = open({ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 });
    const r = insertVertex(p, 0, { x: 1, y: -1 });
    expect(r.pts[0].bulge).toBeCloseTo(Math.tan(Math.PI / 8), 12);
    expect(r.pts[1].bulge).toBeCloseTo(Math.tan(Math.PI / 8), 12);
    const a1 = bulgeToArc(r.pts[0], r.pts[1], r.pts[0].bulge!)!;
    const a2 = bulgeToArc(r.pts[1], r.pts[2], r.pts[1].bulge!)!;
    for (const a of [a1, a2]) {
      expect(a.c.x).toBeCloseTo(1, 12);
      expect(a.c.y).toBeCloseTo(0, 12);
      expect(a.r).toBeCloseTo(1, 12);
    }
  });

  it('removeVertex merges co-circular arcs exactly and straightens otherwise', () => {
    const p = open({ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 });
    const split = insertVertex(p, 0, { x: 1, y: -1 });
    const merged = removeVertex(split, 1)!;
    expect(merged.pts).toHaveLength(2);
    expect(merged.pts[0].bulge).toBeCloseTo(1, 12);
    const r = removeVertex(square(), 1)!;
    expect(r.pts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    // Removing vertex 0 of a closed polyline merges the closing segment.
    const r0 = removeVertex(
      closed({ x: 0, y: 0, bulge: 0.5 }, { x: 10, y: 0 }, { x: 10, y: 10, bulge: 0.3 }),
      0,
    )!;
    expect(r0.pts).toEqual([
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    // Open ends.
    const o = open({ x: 0, y: 0 }, { x: 1, y: 0, bulge: 0.5 }, { x: 2, y: 0 });
    expect(removeVertex(o, 0)!.pts).toEqual([
      { x: 1, y: 0, bulge: 0.5 },
      { x: 2, y: 0 },
    ]);
    expect(removeVertex(o, 2)!.pts).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    expect(removeVertex(open({ x: 0, y: 0 }, { x: 1, y: 0 }), 0)).toBeNull();
    expect(() => removeVertex(o, 5)).toThrow(RangeError);
    // Arcs on different circles are straightened.
    const two = open({ x: 0, y: 0, bulge: 0.5 }, { x: 2, y: 0, bulge: 0.2 }, { x: 4, y: 0 });
    expect(removeVertex(two, 1)!.pts[0].bulge).toBeUndefined();
    // Two semicircles of the same circle would make a full circle: straightened instead.
    const circ = open({ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0, bulge: 1 }, { x: 0, y: 0 });
    expect(removeVertex(circ, 1)!.pts[0].bulge).toBeUndefined();
  });

  it('moveVertex keeps bulges (included angles) and never mutates input', () => {
    const p = open({ x: 0, y: 0, bulge: 0.5 }, { x: 2, y: 0 });
    const m = moveVertex(p, 1, { x: 4, y: 0 });
    expect(m.pts).toEqual([
      { x: 0, y: 0, bulge: 0.5 },
      { x: 4, y: 0 },
    ]);
    expect(p.pts[1]).toEqual({ x: 2, y: 0 });
    expect(() => moveVertex(p, 2, { x: 0, y: 0 })).toThrow(RangeError);
  });
});

describe('reverse', () => {
  it('open polylines: bulges negated and shifted', () => {
    const p = open({ x: 0, y: 0, bulge: 0.5 }, { x: 1, y: 0 }, { x: 2, y: 0, bulge: -0.25 }, { x: 3, y: 0 });
    const r = reversePolyline(p);
    expect(r.pts).toEqual([
      { x: 3, y: 0, bulge: 0.25 },
      { x: 2, y: 0 },
      { x: 1, y: 0, bulge: -0.5 },
      { x: 0, y: 0 },
    ]);
    expect(reversePolyline(r)).toEqual(p);
    expect(reversePolyline(open())).toEqual(open());
  });

  it('closed polylines keep the start vertex and the same arcs', () => {
    const p = closed({ x: 0, y: 0, bulge: 0.5 }, { x: 10, y: 0 }, { x: 10, y: 10, bulge: -1 });
    const r = reversePolyline(p);
    expect(r.pts).toEqual([
      { x: 0, y: 0, bulge: 1 },
      { x: 10, y: 10 },
      { x: 10, y: 0, bulge: -0.5 },
    ]);
    expect(polylineSignedArea(r.pts)).toBeCloseTo(-polylineSignedArea(p.pts), 12);
    expect(reversePolyline(r)).toEqual(p);
  });
});

describe('join', () => {
  const a = open({ x: 0, y: 0 }, { x: 10, y: 0 });
  it('joins end to start, reversing as needed', () => {
    expect(joinPolylines(a, open({ x: 10, y: 0, bulge: 0.3 }, { x: 10, y: 10 }), 0)!.pts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0, bulge: 0.3 },
      { x: 10, y: 10 },
    ]);
    // b reversed (its end meets a's end).
    expect(joinPolylines(a, open({ x: 10, y: 10, bulge: 0.3 }, { x: 10.001, y: 0 }), 0.01)!.pts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0, bulge: -0.3 },
      { x: 10, y: 10 },
    ]);
    // a reversed (starts meet).
    expect(joinPolylines(a, open({ x: 0, y: 0 }, { x: 0, y: 5 }), 0)!.pts).toEqual([
      { x: 10, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 5 },
    ]);
    // b then a (b's end meets a's start).
    expect(joinPolylines(a, open({ x: 0, y: 5 }, { x: 0, y: 0 }), 0)!.pts).toEqual([
      { x: 0, y: 5 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it('returns null when nothing is within tolerance or an input is closed', () => {
    expect(joinPolylines(a, open({ x: 20, y: 0 }, { x: 30, y: 0 }), 1)).toBeNull();
    expect(joinPolylines(square(), a, 1)).toBeNull();
    expect(joinPolylines(a, open(), 1)).toBeNull();
  });

  it('auto-closes when the result ends meet', () => {
    const b = open({ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0.001 });
    const r = joinPolylines(a, b, 0.01)!;
    expect(r.closed).toBe(true);
    expect(r.pts).toEqual(square().pts);
  });
});

describe('split', () => {
  it('open polyline at a vertex and at ends', () => {
    const p = open({ x: 0, y: 0 }, { x: 1, y: 0, bulge: 0.5 }, { x: 2, y: 0 }, { x: 3, y: 0 });
    const [a, b] = splitPolyline(p, 1);
    expect(a.pts).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    expect(b.pts).toEqual([
      { x: 1, y: 0, bulge: 0.5 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
    expect(splitPolyline(p, 0)).toHaveLength(1);
    expect(splitPolyline(p, 3)).toHaveLength(1);
    expect(() => splitPolyline(p, 7)).toThrow(RangeError);
    expect(() => splitPolyline(p, { index: 3, t: 0.5 })).toThrow(RangeError);
  });

  it('open polyline inside a segment, including arcs', () => {
    const p = open({ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 }, { x: 4, y: 0 });
    const [a, b] = splitPolyline(p, { index: 0, t: 0.5 });
    expect(a.pts).toHaveLength(2);
    expect(a.pts[0].bulge).toBeCloseTo(Math.tan(Math.PI / 8), 12);
    expect(a.pts[1].x).toBeCloseTo(1, 12);
    expect(a.pts[1].y).toBeCloseTo(-1, 12);
    expect(b.pts[0].bulge).toBeCloseTo(Math.tan(Math.PI / 8), 12);
    expect(b.pts.slice(1)).toEqual([
      { x: 2, y: 0 },
      { x: 4, y: 0 },
    ]);
    expect(splitPolyline(p, { index: 1, t: 0 })).toHaveLength(2);
    expect(splitPolyline(p, { index: 1, t: 1 })).toHaveLength(1);
  });

  it('closed polylines open at the split point', () => {
    const [r] = splitPolyline(square(), 2);
    expect(r.closed).toBe(false);
    expect(r.pts).toEqual([
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    const [s] = splitPolyline(square(), { index: 3, t: 0.5 });
    expect(s.pts).toEqual([
      { x: 0, y: 5 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 5 },
    ]);
  });
});

describe('close / open', () => {
  it('close drops a duplicate end vertex; open removes or keeps the closing segment', () => {
    const p = open({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 });
    expect(closePolyline(p).pts).toHaveLength(3);
    expect(closePolyline(p).closed).toBe(true);
    expect(closePolyline(open({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 })).pts).toHaveLength(3);
    expect(closePolyline(square())).toEqual(square());
    const c = closed({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10, bulge: 0.5 });
    expect(openPolyline(c).pts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(openPolyline(c, true).pts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10, bulge: 0.5 },
      { x: 0, y: 0 },
    ]);
    expect(openPolyline(p)).toEqual(p);
  });
});

describe('convertSegment', () => {
  it('line ↔ arc conversions', () => {
    const p = open({ x: 0, y: 0 }, { x: 2, y: 0 });
    const below = convertSegment(p, 0, { kind: 'arc', through: { x: 1, y: -1 } })!;
    expect(below.pts[0].bulge).toBeCloseTo(1, 12);
    const above = convertSegment(p, 0, { kind: 'arc', through: { x: 1, y: 1 } })!;
    expect(above.pts[0].bulge).toBeCloseTo(-1, 12);
    // Through point off the perpendicular bisector: the arc passes through it.
    const through = { x: 0.4, y: 0.8 };
    const r = convertSegment(p, 0, { kind: 'arc', through })!;
    const arc = bulgeToArc(r.pts[0], r.pts[1], r.pts[0].bulge!)!;
    expect(Math.hypot(through.x - arc.c.x, through.y - arc.c.y)).toBeCloseTo(arc.r, 12);
    expect(convertSegment(r, 0, 'line')!.pts[0].bulge).toBeUndefined();
    expect(convertSegment(p, 0, { kind: 'arc', bulge: 0.25 })!.pts[0].bulge).toBe(0.25);
    expect(convertSegment(p, 0, { kind: 'arc', bulge: Infinity })).toBeNull();
    expect(convertSegment(p, 0, { kind: 'arc', through: { x: 5, y: 0 } })).toBeNull();
    expect(convertSegment(p, 0, { kind: 'arc', through: { x: 1, y: 0 } })!.pts[0].bulge).toBeUndefined();
    expect(() => convertSegment(p, 1, 'line')).toThrow(RangeError);
    // Closing segment of a closed polyline.
    const sq = convertSegment(square(), 3, { kind: 'arc', through: { x: -5, y: 5 } })!;
    expect(sq.pts[3].bulge).toBeCloseTo(1, 12);
  });

  it('bulgeThrough: major arcs and degenerate inputs', () => {
    // Point beyond the centre gives a major arc (|bulge| > 1).
    const b = bulgeThrough({ x: 0, y: 0 }, { x: 1, y: -1.8 }, { x: 2, y: 0 })!;
    expect(b).toBeGreaterThan(1);
    expect(bulgeThrough({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
    // UTM magnitudes.
    const o = { x: 612345.678, y: 2534210.123 };
    const u = bulgeThrough(o, { x: o.x + 1, y: o.y - 1 }, { x: o.x + 2, y: o.y })!;
    expect(u).toBeCloseTo(1, 9);
  });
});
