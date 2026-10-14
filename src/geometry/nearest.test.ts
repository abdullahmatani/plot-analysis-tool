import { describe, expect, it } from 'vitest';

import type { Pt } from '@/core/types';
import {
  centre,
  endpoints,
  midpoint,
  nearestOnPrim,
  perpendicularFeet,
  quadrantPoints,
  snapCandidates,
  tangentPoints,
  SNAP_PRIORITY,
  type SnapMode,
} from './nearest';
import {
  arcFromBulge,
  ellipseDeriv,
  ellipseMinor,
  ellipsePoint,
  primLength,
  type EllipsePrim,
  type Prim,
} from './prims';

const seg = (ax: number, ay: number, bx: number, by: number): Prim => ({
  k: 'seg',
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});
const ell = (t0 = 0, t1 = 2 * Math.PI): EllipsePrim => ({
  k: 'ellipse',
  c: { x: 1, y: 2 },
  major: { x: 3, y: 0 },
  ratio: 0.5,
  t0,
  t1,
});
const close = (p: Pt, x: number, y: number, d = 12) => {
  expect(p.x).toBeCloseTo(x, d);
  expect(p.y).toBeCloseTo(y, d);
};
const all = new Set<SnapMode>([
  'endpoint',
  'midpoint',
  'centre',
  'quadrant',
  'intersection',
  'nearest',
  'perpendicular',
  'tangent',
]);

describe('nearestOnPrim', () => {
  it('segments clamp to exact endpoints', () => {
    const s = seg(612000.111, 2534000.222, 612010.333, 2534000.222);
    const before = nearestOnPrim({ x: 611990, y: 2534001 }, s);
    expect(before.pt).toEqual({ x: 612000.111, y: 2534000.222 });
    expect(before.t).toBe(0);
    const after = nearestOnPrim({ x: 612050, y: 2534001 }, s);
    expect(after.pt).toEqual({ x: 612010.333, y: 2534000.222 });
    expect(after.t).toBe(1);
    const mid = nearestOnPrim({ x: 612005, y: 2534003 }, s);
    expect(mid.pt.y).toBe(2534000.222);
    expect(mid.dist).toBeCloseTo(2.778, 6);
    expect(nearestOnPrim({ x: 1, y: 1 }, seg(0, 0, 0, 0)).pt).toEqual({ x: 0, y: 0 });
  });

  it('circles and arcs (radial projection, endpoints outside the span)', () => {
    const c: Prim = { k: 'circle', c: { x: 0, y: 0 }, r: 2 };
    const r = nearestOnPrim({ x: 0, y: 5 }, c);
    close(r.pt, 0, 2);
    expect(r.t).toBeCloseTo(0.25, 12);
    expect(r.dist).toBeCloseTo(3, 12);
    expect(nearestOnPrim({ x: 0, y: 0 }, c).pt).toEqual({ x: 2, y: 0 });
    const arc = arcFromBulge({ x: 2, y: 0 }, { x: 0, y: 2 }, Math.tan(Math.PI / 8))!;
    const inSpan = nearestOnPrim({ x: 3, y: 3 }, arc);
    close(inSpan.pt, Math.SQRT2, Math.SQRT2);
    expect(inSpan.t).toBeCloseTo(0.5, 9);
    const outside = nearestOnPrim({ x: 3, y: -1 }, arc);
    expect(outside.pt).toEqual({ x: 2, y: 0 });
    expect(outside.t).toBe(0);
    const outside2 = nearestOnPrim({ x: -1, y: 3 }, arc);
    expect(outside2.pt).toEqual({ x: 0, y: 2 });
    expect(outside2.t).toBe(1);
    expect(nearestOnPrim({ x: 0, y: 0 }, arc).t).toBe(0);
  });

  it('ellipses (numeric) match brute force', () => {
    const e = ell();
    for (const p of [
      { x: 5, y: 3 },
      { x: 1, y: 2.2 },
      { x: -4, y: -1 },
      { x: 1.5, y: 10 },
    ]) {
      const r = nearestOnPrim(p, e);
      let best = Infinity;
      for (let i = 0; i < 200000; i++) {
        const q = ellipsePoint(e, (i / 200000) * 2 * Math.PI);
        best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
      }
      expect(r.dist).toBeLessThanOrEqual(best + 1e-9);
      expect(r.dist).toBeCloseTo(best, 6);
      expect(Math.hypot(r.pt.x - p.x, r.pt.y - p.y)).toBeCloseTo(r.dist, 12);
    }
    // Partial ellipse: nearest to a point beyond the end is the end.
    const half = ell(0, Math.PI);
    const r = nearestOnPrim({ x: 6, y: -3 }, half);
    close(r.pt, 4, 2);
    expect(r.t).toBe(0);
    const r2 = nearestOnPrim({ x: -4, y: -3 }, half);
    close(r2.pt, -2, 2);
    expect(r2.t).toBe(1);
  });

  it('points', () => {
    expect(nearestOnPrim({ x: 3, y: 4 }, { k: 'point', p: { x: 0, y: 0 } })).toEqual({
      pt: { x: 0, y: 0 },
      t: 0,
      dist: 5,
    });
  });
});

describe('perpendicularFeet', () => {
  it('segment foot only inside the segment', () => {
    expect(perpendicularFeet({ x: 1, y: 5 }, seg(0, 0, 2, 0))).toEqual([{ x: 1, y: 0 }]);
    expect(perpendicularFeet({ x: 5, y: 5 }, seg(0, 0, 2, 0))).toEqual([]);
    expect(perpendicularFeet({ x: 0, y: 5 }, seg(0, 0, 2, 0))).toEqual([{ x: 0, y: 0 }]);
    expect(perpendicularFeet({ x: 2, y: 5 }, seg(0, 0, 2, 0))).toEqual([{ x: 2, y: 0 }]);
    expect(perpendicularFeet({ x: 0, y: 5 }, seg(1, 1, 1, 1))).toEqual([]);
    expect(perpendicularFeet({ x: 0, y: 5 }, { k: 'point', p: { x: 0, y: 0 } })).toEqual([]);
  });

  it('circle: near and far radial feet; arc filters by span', () => {
    const c: Prim = { k: 'circle', c: { x: 0, y: 0 }, r: 1 };
    const f = perpendicularFeet({ x: 3, y: 0 }, c);
    expect(f).toHaveLength(2);
    close(f[0], 1, 0);
    close(f[1], -1, 0);
    expect(perpendicularFeet({ x: 0, y: 0 }, c)).toEqual([]);
    const arc: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 1, a0: -Math.PI / 2, a1: Math.PI / 2 };
    expect(perpendicularFeet({ x: 3, y: 0 }, arc)).toHaveLength(1);
  });

  it('ellipse feet are perpendicular', () => {
    const e = ell();
    const from = { x: 1.2, y: 2.1 };
    const feet = perpendicularFeet(from, e);
    expect(feet.length).toBe(4);
    for (const p of feet) {
      // Find the parameter of p and check (p − from) ⟂ E'(t).
      const n = ellipseMinor(e);
      const u = ((p.x - 1) * 3) / 9;
      const v = ((p.y - 2) * n.y) / (n.y * n.y);
      const t = Math.atan2(v, u);
      const d = ellipseDeriv(e, t);
      const dot = (p.x - from.x) * d.x + (p.y - from.y) * d.y;
      expect(Math.abs(dot)).toBeLessThan(1e-9);
    }
    // Outside point: two feet (nearest and farthest).
    expect(perpendicularFeet({ x: 10, y: 2.5 }, e).length).toBe(2);
  });
});

describe('tangentPoints', () => {
  it('circle and arc', () => {
    const c: Prim = { k: 'circle', c: { x: 0, y: 0 }, r: 1 };
    const t = tangentPoints({ x: 2, y: 0 }, c);
    expect(t).toHaveLength(2);
    for (const p of t) {
      expect(p.x).toBeCloseTo(0.5, 12);
      // Radius ⟂ tangent line.
      expect(p.x * (p.x - 2) + p.y * p.y).toBeCloseTo(0, 12);
    }
    expect(tangentPoints({ x: 0.5, y: 0 }, c)).toEqual([]);
    const arc: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 1, a0: 0, a1: Math.PI };
    expect(tangentPoints({ x: 2, y: 0 }, arc)).toHaveLength(1);
    expect(tangentPoints({ x: 2, y: 0 }, seg(0, 0, 1, 1))).toEqual([]);
  });

  it('ellipse (affine-invariant construction)', () => {
    const e = ell();
    const from = { x: 8, y: 5 };
    const t = tangentPoints(from, e);
    expect(t).toHaveLength(2);
    for (const p of t) {
      const n = ellipseMinor(e);
      const u = ((p.x - 1) * 3) / 9;
      const v = ((p.y - 2) * n.y) / (n.y * n.y);
      const d = ellipseDeriv(e, Math.atan2(v, u));
      const cr = (p.x - from.x) * d.y - (p.y - from.y) * d.x;
      expect(Math.abs(cr) / Math.hypot(d.x, d.y)).toBeLessThan(1e-9);
    }
    expect(tangentPoints({ x: 1, y: 2 }, e)).toEqual([]);
    expect(tangentPoints(from, ell(Math.PI, 2 * Math.PI)).length).toBeLessThan(2);
  });
});

describe('quadrant, midpoint, centre, endpoints', () => {
  it('quadrants', () => {
    expect(quadrantPoints({ k: 'circle', c: { x: 10, y: 20 }, r: 5 })).toEqual([
      { x: 15, y: 20 },
      { x: 10, y: 25 },
      { x: 5, y: 20 },
      { x: 10, y: 15 },
    ]);
    expect(quadrantPoints({ k: 'arc', c: { x: 0, y: 0 }, r: 1, a0: -0.1, a1: 1.6 })).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]);
    const q = quadrantPoints(ell(0, Math.PI));
    expect(q).toHaveLength(3);
    expect(q[0]).toEqual({ x: 4, y: 2 });
    expect(q[1]).toEqual({ x: 1, y: 3.5 });
    expect(quadrantPoints(seg(0, 0, 1, 1))).toEqual([]);
  });

  it('midpoints', () => {
    expect(midpoint(seg(0, 0, 2, 4))).toEqual({ x: 1, y: 2 });
    close(midpoint({ k: 'arc', c: { x: 0, y: 0 }, r: 2, a0: 0, a1: Math.PI })!, 0, 2);
    expect(midpoint({ k: 'circle', c: { x: 0, y: 0 }, r: 2 })).toBeNull();
    expect(midpoint(ell())).toBeNull();
    expect(midpoint({ k: 'point', p: { x: 0, y: 0 } })).toBeNull();
    // Ellipse arc midpoint by arc length: symmetric quarter arcs give the axis end.
    const e = ell(-Math.PI / 2, Math.PI / 2);
    close(midpoint(e)!, 4, 2, 9);
    // Asymmetric: arc length to the midpoint is half the total.
    const a = ell(0, 1.2);
    const m = midpoint(a)!;
    const full = primLength(a);
    let acc = 0;
    let prev = ellipsePoint(a, 0);
    let tm = 0;
    for (let i = 1; i <= 100000; i++) {
      const t = (1.2 * i) / 100000;
      const q = ellipsePoint(a, t);
      acc += Math.hypot(q.x - prev.x, q.y - prev.y);
      prev = q;
      if (acc >= full / 2) {
        tm = t;
        break;
      }
    }
    close(m, ellipsePoint(a, tm).x, ellipsePoint(a, tm).y, 4);
  });

  it('centre and endpoints return stored numbers', () => {
    const c = { x: 612345.678901, y: 2534210.123456 };
    expect(centre({ k: 'circle', c, r: 7.5 })).toEqual(c);
    expect(centre({ k: 'arc', c, r: 7.5, a0: 0, a1: 1 })).toEqual(c);
    expect(centre({ ...ell(), c })).toEqual(c);
    expect(centre(seg(0, 0, 1, 1))).toBeNull();
    const v0 = { x: 612345.678901, y: 2534210.123456 };
    const v1 = { x: 612355.1, y: 2534215.9 };
    const arc = arcFromBulge(v0, v1, -0.3)!;
    expect(endpoints(arc)).toEqual([v1, v0]);
  });
});

describe('snapCandidates', () => {
  const v = { x: 612345.678901, y: 2534210.123456 };
  const prims: Prim[] = [
    { k: 'seg', a: { x: v.x - 10, y: v.y }, b: v },
    { k: 'seg', a: v, b: { x: v.x, y: v.y + 10 } },
    { k: 'circle', c: { x: v.x + 5, y: v.y + 5 }, r: 1 },
  ];

  it('prefers endpoints and returns the exact stored coordinates', () => {
    const cands = snapCandidates({ x: v.x + 0.1, y: v.y + 0.05 }, prims, { modes: all, radius: 0.5 });
    expect(cands[0].mode === 'endpoint' || cands[0].mode === 'intersection').toBe(true);
    expect(cands[0].pt).toEqual(v);
    const ep = cands.find((c) => c.mode === 'endpoint')!;
    expect(ep.pt).toEqual(v);
    expect(cands.some((c) => c.mode === 'nearest')).toBe(true);
    // Sorted by priority then distance.
    for (let i = 1; i < cands.length; i++) {
      const a = cands[i - 1];
      const b = cands[i];
      expect(
        SNAP_PRIORITY[a.mode] < SNAP_PRIORITY[b.mode] ||
          (SNAP_PRIORITY[a.mode] === SNAP_PRIORITY[b.mode] && a.dist <= b.dist),
      ).toBe(true);
    }
  });

  it('centre snap returns the stored centre exactly', () => {
    const cands = snapCandidates({ x: v.x + 5.2, y: v.y + 5.1 }, prims, {
      modes: new Set(['centre']),
      radius: 0.5,
    });
    expect(cands).toHaveLength(1);
    expect(cands[0].pt).toEqual({ x: v.x + 5, y: v.y + 5 });
    expect(cands[0].primIndex).toBe(2);
  });

  it('centre of a small far arc is reachable from near its centre', () => {
    const arc: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 100, a0: 0, a1: 0.01 };
    const cands = snapCandidates({ x: 0.1, y: 0 }, [arc], {
      modes: new Set(['centre', 'endpoint']),
      radius: 0.5,
    });
    expect(cands.map((c) => c.mode)).toEqual(['centre']);
  });

  it('intersection, midpoint, quadrant, perpendicular, tangent', () => {
    const square: Prim[] = [seg(0, 0, 10, 0), seg(5, -5, 5, 5), { k: 'circle', c: { x: 20, y: 0 }, r: 2 }];
    const ix = snapCandidates({ x: 5.1, y: 0.1 }, square, { modes: new Set(['intersection']), radius: 0.5 });
    expect(ix).toHaveLength(1);
    expect(ix[0].pt).toEqual({ x: 5, y: 0 });
    expect(ix[0].otherIndex).toBe(1);
    const mids = snapCandidates({ x: 5.1, y: 0.1 }, square, { modes: new Set(['midpoint']), radius: 0.5 });
    expect(mids.map((c) => c.pt)).toEqual([{ x: 5, y: 0 }]);
    const quads = snapCandidates({ x: 22.1, y: 0 }, square, { modes: new Set(['quadrant']), radius: 0.5 });
    expect(quads.map((c) => c.pt)).toEqual([{ x: 22, y: 0 }]);
    const perp = snapCandidates({ x: 3, y: 0.2 }, square, {
      modes: new Set(['perpendicular']),
      radius: 0.5,
      from: { x: 3, y: 7 },
    });
    expect(perp[0].pt).toEqual({ x: 3, y: 0 });
    const tan = snapCandidates({ x: 20, y: 2.1 }, square, {
      modes: new Set(['tangent']),
      radius: 0.5,
      from: { x: 30, y: 2 },
    });
    expect(tan).toHaveLength(1);
    expect(tan[0].pt.y).toBeCloseTo(2, 1);
    // Without a previous point there are no perpendicular/tangent candidates.
    expect(
      snapCandidates({ x: 3, y: 0.2 }, square, { modes: new Set(['perpendicular', 'tangent']), radius: 0.5 }),
    ).toEqual([]);
    // Nothing in reach.
    expect(snapCandidates({ x: 100, y: 100 }, square, { modes: all, radius: 0.5 })).toEqual([]);
  });

  it('point primitives snap as endpoints only', () => {
    const cands = snapCandidates({ x: 0.1, y: 0 }, [{ k: 'point', p: { x: 0, y: 0 } }], {
      modes: all,
      radius: 1,
    });
    expect(cands.map((c) => c.mode)).toEqual(['endpoint']);
  });
});
