import { describe, expect, it } from 'vitest';

import type { Pt } from '@/core/types';
import {
  intersectInfiniteLines,
  intersectPrims,
  intersectPrimsParams,
  intersectSegSeg,
  primsTolerance,
} from './intersect';
import { arcFromBulge, ellipseMinor, primPointAt, type EllipsePrim, type Prim } from './prims';

const seg = (ax: number, ay: number, bx: number, by: number): Prim => ({
  k: 'seg',
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});
const circle = (x: number, y: number, r: number): Prim => ({ k: 'circle', c: { x, y }, r });
const ell = (
  cx: number,
  cy: number,
  mx: number,
  my: number,
  ratio: number,
  t0 = 0,
  t1 = 2 * Math.PI,
): EllipsePrim => ({
  k: 'ellipse',
  c: { x: cx, y: cy },
  major: { x: mx, y: my },
  ratio,
  t0,
  t1,
});

/** Implicit ellipse value (1 on the curve). */
function ellVal(e: EllipsePrim, p: Pt): number {
  const n = ellipseMinor(e);
  const qx = p.x - e.c.x;
  const qy = p.y - e.c.y;
  const u = (qx * e.major.x + qy * e.major.y) / (e.major.x ** 2 + e.major.y ** 2);
  const v = (qx * n.x + qy * n.y) / (n.x ** 2 + n.y ** 2);
  return u * u + v * v;
}

function onPrim(p: Prim, q: Pt, tol: number): boolean {
  switch (p.k) {
    case 'seg': {
      const rx = p.b.x - p.a.x;
      const ry = p.b.y - p.a.y;
      const t = Math.min(1, Math.max(0, ((q.x - p.a.x) * rx + (q.y - p.a.y) * ry) / (rx * rx + ry * ry)));
      return Math.hypot(p.a.x + rx * t - q.x, p.a.y + ry * t - q.y) <= tol;
    }
    case 'circle':
    case 'arc':
      return Math.abs(Math.hypot(q.x - p.c.x, q.y - p.c.y) - p.r) <= tol;
    case 'ellipse':
      return Math.abs(ellVal(p, q) - 1) <= tol;
    default:
      return false;
  }
}

function checkParams(a: Prim, b: Prim, tol = 1e-9) {
  for (const h of intersectPrimsParams(a, b)) {
    const pa = primPointAt(a, h.ta);
    const pb = primPointAt(b, h.tb);
    expect(Math.hypot(pa.x - h.p.x, pa.y - h.p.y)).toBeLessThan(tol);
    expect(Math.hypot(pb.x - h.p.x, pb.y - h.p.y)).toBeLessThan(tol);
  }
}

describe('intersectInfiniteLines', () => {
  it('intersects general lines', () => {
    const p = intersectInfiniteLines({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 2, y: 0 })!;
    expect(p.x).toBeCloseTo(1, 14);
    expect(p.y).toBeCloseTo(1, 14);
  });

  it('is exact for axis-aligned lines at UTM magnitude', () => {
    const p = intersectInfiniteLines(
      { x: 612300.37, y: 2534100.11 },
      { x: 612340.97, y: 2534100.11 },
      { x: 612345.123, y: 2534100.15 },
      { x: 612345.123, y: 2534180.5 },
    )!;
    expect(p).toEqual({ x: 612345.123, y: 2534100.11 });
  });

  it('returns null for parallel or degenerate lines', () => {
    expect(intersectInfiniteLines({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 5, y: 1 })).toBeNull();
    expect(intersectInfiniteLines({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 5, y: 1 })).toBeNull();
  });
});

describe('segment–segment', () => {
  it('crossing', () => {
    const h = intersectPrimsParams(seg(0, 0, 2, 2), seg(0, 2, 2, 0));
    expect(h).toHaveLength(1);
    expect(h[0].p.x).toBeCloseTo(1, 14);
    expect(h[0].ta).toBeCloseTo(0.5, 14);
    expect(h[0].tb).toBeCloseTo(0.5, 14);
  });

  it('returns stored endpoints exactly at corners and T-junctions (UTM coordinates)', () => {
    const corner = { x: 612345.1234567, y: 2534210.0045678 };
    const a: Prim = { k: 'seg', a: { x: 612300.0000001, y: 2534200.0000003 }, b: corner };
    const b: Prim = { k: 'seg', a: corner, b: { x: 612390.7654321, y: 2534260.1234567 } };
    expect(intersectPrims(a, b)).toEqual([corner]);
    // T-junction: b's start lies in the middle of c.
    const c: Prim = {
      k: 'seg',
      a: { x: 612345.1234567 - 30, y: 2534210.0045678 - 20 },
      b: { x: 612345.1234567 + 30, y: 2534210.0045678 + 20 },
    };
    const hits = intersectPrimsParams(c, b);
    expect(hits).toHaveLength(1);
    expect(hits[0].p).toEqual(corner);
    expect(hits[0].tb).toBe(0);
    expect(hits[0].ta).toBeCloseTo(0.5, 9);
  });

  it('keeps sub-mm precision for crossings at UTM magnitude', () => {
    const ox = 600000;
    const oy = 2500000;
    const a: Prim = { k: 'seg', a: { x: ox, y: oy }, b: { x: ox + 10000, y: oy + 10000 } };
    const b: Prim = { k: 'seg', a: { x: ox, y: oy + 10000 }, b: { x: ox + 10000, y: oy } };
    const [p] = intersectPrims(a, b);
    expect(Math.abs(p.x - (ox + 5000))).toBeLessThan(1e-6);
    expect(Math.abs(p.y - (oy + 5000))).toBeLessThan(1e-6);
  });

  it('parallel, disjoint and misses', () => {
    expect(intersectPrims(seg(0, 0, 1, 0), seg(0, 1, 1, 1))).toEqual([]);
    expect(intersectPrims(seg(0, 0, 1, 0), seg(2, 0, 3, 0))).toEqual([]);
    expect(intersectPrims(seg(0, 0, 1, 0), seg(2, -1, 2, 1))).toEqual([]);
  });

  it('collinear overlaps return the overlap ends', () => {
    const h = intersectPrimsParams(seg(0, 0, 10, 0), seg(5, 0, 15, 0));
    expect(h.map((x) => x.p)).toEqual([
      { x: 10, y: 0 },
      { x: 5, y: 0 },
    ]);
    expect(h[0].ta).toBe(1);
    expect(h[0].tb).toBeCloseTo(0.5, 14);
    expect(h[1].ta).toBeCloseTo(0.5, 14);
    expect(h[1].tb).toBe(0);
    // Containment and identical segments.
    expect(intersectPrims(seg(0, 0, 10, 0), seg(2, 0, 4, 0))).toHaveLength(2);
    expect(intersectPrims(seg(0, 0, 10, 0), seg(10, 0, 0, 0))).toHaveLength(2);
    // End-to-end touching collinear segments meet at one point.
    expect(intersectPrims(seg(0, 0, 10, 0), seg(10, 0, 20, 0))).toEqual([{ x: 10, y: 0 }]);
  });

  it('degenerate segments act as points', () => {
    expect(intersectSegSeg({ x: 1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }, 1e-9)).toEqual([
      { p: { x: 1, y: 0 }, ta: 0, tb: 0.5 },
    ]);
    expect(intersectSegSeg({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 }, 1e-9)).toEqual([]);
    expect(
      intersectSegSeg({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, 1e-9),
    ).toHaveLength(1);
    expect(intersectSegSeg({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 0, y: 0 }, { x: 2, y: 0 }, 1e-9)).toEqual([]);
  });

  it('end-on-end of the other segment snaps to the other stored endpoint', () => {
    const h = intersectSegSeg({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: -1 }, { x: 2, y: 0 }, 1e-9);
    expect(h).toEqual([{ p: { x: 2, y: 0 }, ta: 0.5, tb: 1 }]);
  });
});

describe('segment–circle/arc', () => {
  it('secant, tangent, miss and inside', () => {
    const c = circle(0, 0, 1);
    const two = intersectPrims(seg(-2, 0, 2, 0), c);
    expect(two).toHaveLength(2);
    expect(two[0].x).toBeCloseTo(-1, 14);
    expect(two[1].x).toBeCloseTo(1, 14);
    const tangent = intersectPrims(seg(-2, 1, 2, 1), c);
    expect(tangent).toHaveLength(1);
    expect(tangent[0].x).toBeCloseTo(0, 12);
    expect(intersectPrims(seg(-2, 2, 2, 2), c)).toEqual([]);
    expect(intersectPrims(seg(-0.5, 0, 0.5, 0), c)).toEqual([]);
    checkParams(seg(-2, 0.3, 2, -0.1), c);
    checkParams(c, seg(-2, 0.3, 2, -0.1));
  });

  it('filters by arc span and snaps to exact shared endpoints', () => {
    const arc: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 1, a0: 0, a1: Math.PI };
    expect(intersectPrims(seg(-2, 0.5, 2, 0.5), arc)).toHaveLength(2);
    expect(intersectPrims(seg(-2, -0.5, 2, -0.5), arc)).toEqual([]);
    // A polyline: seg then CW arc sharing the exact vertex.
    const v = { x: 612345.6789, y: 2534210.1234 };
    const s: Prim = { k: 'seg', a: { x: v.x - 10, y: v.y }, b: v };
    const a = arcFromBulge(v, { x: v.x + 10, y: v.y }, -0.5)!;
    const pts = intersectPrims(s, a);
    expect(pts).toEqual([v]);
    // Same with the arguments swapped.
    expect(intersectPrims(a, s)).toEqual([v]);
    checkParams(arc, seg(-2, 0.5, 2, 0.5));
  });

  it('zero-length segment on a circle', () => {
    const c = circle(0, 0, 1);
    expect(intersectPrims({ k: 'seg', a: { x: 1, y: 0 }, b: { x: 1, y: 0 } }, c)).toEqual([{ x: 1, y: 0 }]);
    expect(intersectPrims({ k: 'seg', a: { x: 2, y: 0 }, b: { x: 2, y: 0 } }, c)).toEqual([]);
    const arc: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 1, a0: Math.PI / 2, a1: Math.PI };
    expect(intersectPrims({ k: 'seg', a: { x: 1, y: 0 }, b: { x: 1, y: 0 } }, arc)).toEqual([]);
  });
});

describe('circle/arc–circle/arc', () => {
  it('two points, tangencies, containment, concentric', () => {
    const two = intersectPrims(circle(0, 0, 1), circle(1, 0, 1));
    expect(two).toHaveLength(2);
    for (const p of two) {
      expect(p.x).toBeCloseTo(0.5, 14);
      expect(Math.abs(p.y)).toBeCloseTo(Math.sqrt(3) / 2, 14);
    }
    const ext = intersectPrims(circle(0, 0, 1), circle(2, 0, 1));
    expect(ext).toHaveLength(1);
    expect(ext[0].x).toBeCloseTo(1, 14);
    const int = intersectPrims(circle(0, 0, 2), circle(1, 0, 1));
    expect(int).toHaveLength(1);
    expect(int[0].x).toBeCloseTo(2, 14);
    expect(intersectPrims(circle(0, 0, 1), circle(3, 0, 1))).toEqual([]);
    expect(intersectPrims(circle(0, 0, 3), circle(0.5, 0, 1))).toEqual([]);
    expect(intersectPrims(circle(0, 0, 1), circle(0, 0, 2))).toEqual([]);
    expect(intersectPrims(circle(0, 0, 1), circle(0, 0, 1))).toEqual([]);
    checkParams(circle(0, 0, 1), circle(1, 0.3, 0.8));
  });

  it('arcs filter by span; co-circular arcs report overlap ends', () => {
    const upper: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 1, a0: 0, a1: Math.PI };
    expect(intersectPrims(upper, circle(1, 0, 1))).toHaveLength(1);
    const a1: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 1, a0: 0, a1: Math.PI };
    const a2: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 1, a0: Math.PI / 2, a1: (3 * Math.PI) / 2 };
    const h = intersectPrimsParams(a1, a2);
    expect(h).toHaveLength(2);
    const xs = h.map((x) => Math.round(x.p.x * 1e9) / 1e9).sort();
    expect(xs).toEqual([-1, 0]);
    checkParams(a1, a2);
  });

  it('snaps to stored arc endpoints', () => {
    const p0 = { x: 10.123456789, y: 0 };
    const p1 = { x: 12.123456789, y: 0 };
    const a = arcFromBulge(p0, p1, 0.7)!;
    const b = arcFromBulge(p1, { x: 14.123456789, y: 0 }, 0.4)!;
    expect(intersectPrims(a, b)).toEqual([p1]);
  });
});

describe('ellipse intersections', () => {
  it('segment–ellipse (analytic in the unit frame)', () => {
    const e = ell(0, 0, 2, 0, 0.5);
    const pts = intersectPrims(seg(-3, 0, 3, 0), e);
    expect(pts).toHaveLength(2);
    expect(pts.map((p) => Math.round(p.x * 1e12) / 1e12).sort((a, b) => a - b)).toEqual([-2, 2]);
    const tilted = ell(5, -3, 3, 4, 0.4);
    const s = seg(0, -10, 10, 5);
    const hits = intersectPrims(s, tilted);
    expect(hits.length).toBe(2);
    for (const p of hits) {
      expect(onPrim(tilted, p, 1e-12)).toBe(true);
      expect(onPrim(s, p, 1e-9)).toBe(true);
    }
    checkParams(s, tilted);
    checkParams(tilted, s);
    // Tangent line at the minor axis end.
    expect(intersectPrims(seg(-3, 1, 3, 1), e)).toHaveLength(1);
    // Partial ellipse: only the upper half.
    expect(intersectPrims(seg(-3, -0.5, 3, -0.5), ell(0, 0, 2, 0, 0.5, 0, Math.PI))).toEqual([]);
    expect(intersectPrims(seg(-3, 0.5, 3, 0.5), ell(0, 0, 2, 0, 0.5, 0, Math.PI))).toHaveLength(2);
  });

  it('segment ending on a partial ellipse end returns that end exactly', () => {
    const e = ell(0, 0, 2, 0, 0.5, 0, Math.PI / 2);
    const end = primPointAt(e, 0);
    const s: Prim = { k: 'seg', a: { x: 5, y: 0 }, b: { x: 2, y: 0 } };
    const h = intersectPrimsParams(s, e);
    expect(h).toHaveLength(1);
    expect(h[0].p).toEqual({ x: 2, y: 0 });
    expect(h[0].tb).toBe(0);
    expect(end.x).toBeCloseTo(2, 14);
  });

  it('circle–ellipse: four crossings and tangencies', () => {
    const e = ell(0, 0, 2, 0, 0.5);
    const c = circle(0, 0, 1.5);
    const pts = intersectPrims(c, e);
    expect(pts).toHaveLength(4);
    for (const p of pts) {
      expect(onPrim(c, p, 1e-10)).toBe(true);
      expect(onPrim(e, p, 1e-10)).toBe(true);
    }
    checkParams(c, e);
    checkParams(e, c);
    // Tangent internally at the major axis ends (r = 2) and minor axis ends (r = 1).
    expect(intersectPrims(circle(0, 0, 2), e)).toHaveLength(2);
    expect(intersectPrims(circle(0, 0, 1), e)).toHaveLength(2);
    expect(intersectPrims(circle(0, 0, 0.5), e)).toEqual([]);
    // Arc span filtering.
    const arc: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 1.5, a0: 0, a1: Math.PI / 2 };
    expect(intersectPrims(arc, e)).toHaveLength(1);
    expect(intersectPrims(e, arc)).toHaveLength(1);
  });

  it('circle coinciding with a ratio-1 ellipse reports only span ends', () => {
    const e = ell(0, 0, 1, 0, 1, 0, Math.PI);
    const pts = intersectPrims(circle(0, 0, 1), e);
    expect(pts.length).toBe(2);
    const arc: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 1, a0: Math.PI / 2, a1: (3 * Math.PI) / 2 };
    const h = intersectPrims(arc, e);
    expect(h.length).toBe(2);
  });

  it('ellipse–ellipse: crossing, tangent, coincident', () => {
    const a = ell(0, 0, 2, 0, 0.5);
    const b = ell(0, 0, 0, 2, 0.5);
    const pts = intersectPrims(a, b);
    expect(pts).toHaveLength(4);
    for (const p of pts) {
      expect(onPrim(a, p, 1e-10)).toBe(true);
      expect(onPrim(b, p, 1e-10)).toBe(true);
    }
    checkParams(a, b);
    // Externally tangent at (2, 0).
    const t = intersectPrims(a, ell(4, 0, 2, 0, 0.5));
    expect(t).toHaveLength(1);
    expect(t[0].x).toBeCloseTo(2, 6);
    // Disjoint.
    expect(intersectPrims(a, ell(10, 0, 2, 0, 0.5))).toEqual([]);
    // Coincident partial ellipses: overlap ends.
    const h1 = ell(0, 0, 2, 0, 0.5, 0, Math.PI);
    const h2 = ell(0, 0, 2, 0, 0.5, Math.PI / 2, (3 * Math.PI) / 2);
    expect(intersectPrims(h1, h2)).toHaveLength(2);
    // Precision at UTM magnitude.
    const ua = ell(600000, 2500000, 20, 0, 0.5);
    const ub = ell(600000, 2500000, 0, 20, 0.5);
    for (const p of intersectPrims(ua, ub)) {
      expect(onPrim(ua, p, 1e-10)).toBe(true);
      expect(onPrim(ub, p, 1e-10)).toBe(true);
    }
  });
});

describe('misc', () => {
  it('points never intersect; tolerance helper', () => {
    expect(intersectPrims({ k: 'point', p: { x: 0, y: 0 } }, seg(-1, 0, 1, 0))).toEqual([]);
    expect(intersectPrims(seg(-1, 0, 1, 0), { k: 'point', p: { x: 0, y: 0 } })).toEqual([]);
    expect(primsTolerance()).toBe(1e-12);
    expect(primsTolerance(seg(0, 0, 1000, 0))).toBeCloseTo(1e-6, 15);
    expect(primsTolerance(seg(600000, 2500000, 600001, 2500000))).toBeGreaterThan(1e-9);
  });

  it('random segment pairs: hits lie on both segments', () => {
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 100;
    for (let i = 0; i < 500; i++) {
      const a = seg(rnd(), rnd(), rnd(), rnd());
      const b = seg(rnd(), rnd(), rnd(), rnd());
      for (const p of intersectPrims(a, b)) {
        expect(onPrim(a, p, 1e-9)).toBe(true);
        expect(onPrim(b, p, 1e-9)).toBe(true);
      }
      checkParams(a, b, 1e-8);
    }
  });
});
