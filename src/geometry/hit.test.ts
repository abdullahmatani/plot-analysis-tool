import { describe, expect, it } from 'vitest';

import type { Bounds, Geometry, Pt, Vertex } from '@/core/types';

import {
  distanceToGeometry,
  geometryInsidePolygon,
  geometryInsideRect,
  geometryIntersectsPolygon,
  geometryIntersectsRect,
  pointInGeometry,
} from './hit';

const square = (x0: number, y0: number, s: number): Vertex[] => [
  { x: x0, y: y0 },
  { x: x0 + s, y: y0 },
  { x: x0 + s, y: y0 + s },
  { x: x0, y: y0 + s },
];

const box = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({ minX, minY, maxX, maxY });

/** Brute-force distance to an ellipse by dense sampling + local refinement. */
function ellipseDistanceRef(p: Pt, c: Pt, rx: number, ry: number, rot: number): number {
  const at = (t: number): Pt => {
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    return { x: c.x + x * Math.cos(rot) - y * Math.sin(rot), y: c.y + x * Math.sin(rot) + y * Math.cos(rot) };
  };
  const f = (t: number): number => Math.hypot(at(t).x - p.x, at(t).y - p.y);
  const n = 20000;
  let bestT = 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const d = f(t);
    if (d < best) {
      best = d;
      bestT = t;
    }
  }
  // Golden-section refinement around the best sample.
  let a = bestT - (2 * Math.PI) / n;
  let b = bestT + (2 * Math.PI) / n;
  for (let i = 0; i < 100; i++) {
    const m1 = a + (b - a) * 0.382;
    const m2 = a + (b - a) * 0.618;
    if (f(m1) < f(m2)) b = m2;
    else a = m1;
  }
  return Math.min(best, f((a + b) / 2));
}

const lasso: Pt[] = [
  // U-shaped (concave) lasso: notch between x = 40 and x = 60 above y = 30.
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 60, y: 100 },
  { x: 60, y: 30 },
  { x: 40, y: 30 },
  { x: 40, y: 100 },
  { x: 0, y: 100 },
];

describe('distanceToGeometry', () => {
  it('handles points, circles and arcs exactly', () => {
    expect(distanceToGeometry({ x: 3, y: 4 }, { type: 'point', p: { x: 0, y: 0 } })).toBe(5);
    const c: Geometry = { type: 'circle', c: { x: 0, y: 0 }, r: 10 };
    expect(distanceToGeometry({ x: 3, y: 4 }, c)).toBe(5);
    expect(distanceToGeometry({ x: 0, y: 15 }, c)).toBe(5);
    expect(distanceToGeometry({ x: 0, y: 0 }, c)).toBe(10);
    const arc: Geometry = { type: 'arc', c: { x: 0, y: 0 }, r: 10, a0: 0, a1: Math.PI / 2 };
    expect(distanceToGeometry({ x: 10, y: 10 }, arc)).toBeCloseTo(Math.SQRT2 * 10 - 10, 12);
    expect(distanceToGeometry({ x: -10, y: 0 }, arc)).toBeCloseTo(Math.SQRT2 * 10, 12);
    expect(distanceToGeometry({ x: 15, y: -1 }, arc)).toBeCloseTo(Math.hypot(5, 1), 12);
    const full: Geometry = { type: 'arc', c: { x: 0, y: 0 }, r: 10, a0: 1, a1: 1 };
    expect(distanceToGeometry({ x: -12, y: 0 }, full)).toBeCloseTo(2, 12);
  });

  it('handles rotated rectangles (inside and outside)', () => {
    const r: Geometry = { type: 'rect', c: { x: 600_000, y: 2_500_000 }, w: 20, h: 10, rot: Math.PI / 2 };
    expect(distanceToGeometry({ x: 600_000, y: 2_500_000 }, r)).toBeCloseTo(5, 9);
    expect(distanceToGeometry({ x: 600_000, y: 2_500_013 }, r)).toBeCloseTo(3, 9);
    expect(distanceToGeometry({ x: 600_008, y: 2_500_014 }, r)).toBeCloseTo(5, 9);
  });

  it('computes exact distances to ellipses (Eberly)', () => {
    const shapes = [
      { c: { x: 0, y: 0 }, rx: 10, ry: 4, rot: 0 },
      { c: { x: 600_000, y: 2_500_000 }, rx: 30, ry: 50, rot: 0.7 },
      { c: { x: 0, y: 0 }, rx: 5, ry: 5, rot: 0 },
    ];
    const probes: Pt[] = [
      { x: 0, y: 0 },
      { x: 3, y: 1 },
      { x: 20, y: 0 },
      { x: 0, y: 30 },
      { x: -7, y: 2.5 },
      { x: 1, y: 0 },
      { x: 9, y: 0 },
      { x: 0, y: 1 },
      { x: 12, y: -9 },
    ];
    for (const e of shapes) {
      const g: Geometry = { type: 'ellipse', ...e };
      for (const q of probes) {
        const p = { x: e.c.x + q.x, y: e.c.y + q.y };
        expect(distanceToGeometry(p, g)).toBeCloseTo(ellipseDistanceRef(p, e.c, e.rx, e.ry, e.rot), 7);
      }
    }
    const flat: Geometry = { type: 'ellipse', c: { x: 0, y: 0 }, rx: 10, ry: 0, rot: 0 };
    expect(distanceToGeometry({ x: 0, y: 3 }, flat)).toBe(3);
    expect(distanceToGeometry({ x: 13, y: 4 }, flat)).toBe(5);
  });

  it('handles bulge polylines and multipolygons', () => {
    const pl: Geometry = {
      type: 'polyline',
      pts: [
        { x: 0, y: 0, bulge: 1 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      closed: false,
    };
    expect(distanceToGeometry({ x: 5, y: -8 }, pl)).toBeCloseTo(3, 12);
    expect(distanceToGeometry({ x: 0, y: 10 }, pl)).toBe(10);
    expect(distanceToGeometry({ x: 0, y: 10 }, { ...pl, closed: true })).toBeCloseTo(Math.SQRT2 * 5, 12);
    expect(
      distanceToGeometry({ x: 3, y: 4 }, { type: 'polyline', pts: [{ x: 0, y: 0 }], closed: false }),
    ).toBe(5);
    const mp: Geometry = { type: 'multipolygon', rings: [square(0, 0, 10), square(20, 0, 10)] };
    expect(distanceToGeometry({ x: 15, y: 5 }, mp)).toBe(5);
  });
});

describe('pointInGeometry', () => {
  it('tests filled interiors of analytic shapes', () => {
    expect(pointInGeometry({ x: 3, y: 4 }, { type: 'circle', c: { x: 0, y: 0 }, r: 5 })).toBe(true);
    expect(pointInGeometry({ x: 3, y: 4.1 }, { type: 'circle', c: { x: 0, y: 0 }, r: 5 })).toBe(false);
    const r: Geometry = { type: 'rect', c: { x: 0, y: 0 }, w: 20, h: 2, rot: Math.PI / 4 };
    expect(pointInGeometry({ x: 5, y: 5 }, r)).toBe(true);
    expect(pointInGeometry({ x: 5, y: -5 }, r)).toBe(false);
    const e: Geometry = { type: 'ellipse', c: { x: 0, y: 0 }, rx: 10, ry: 2, rot: Math.PI / 2 };
    expect(pointInGeometry({ x: 0, y: 9 }, e)).toBe(true);
    expect(pointInGeometry({ x: 3, y: 0 }, e)).toBe(false);
    expect(
      pointInGeometry({ x: 0, y: 0 }, { type: 'ellipse', c: { x: 0, y: 0 }, rx: 10, ry: 0, rot: 0 }),
    ).toBe(false);
    expect(pointInGeometry({ x: 0, y: 0 }, { type: 'point', p: { x: 0, y: 0 } })).toBe(false);
    expect(pointInGeometry({ x: 0, y: 0 }, { type: 'arc', c: { x: 0, y: 0 }, r: 1, a0: 0, a1: 3 })).toBe(
      false,
    );
  });

  it('is bulge-aware and respects holes', () => {
    const d: Geometry = {
      type: 'polyline',
      pts: [
        { x: -5, y: 0 },
        { x: 5, y: 0, bulge: 1 },
      ],
      closed: true,
    };
    // Positive bulge from (5,0) back to (−5,0) arcs to the right of travel = upwards.
    expect(pointInGeometry({ x: 0, y: 4.9 }, d)).toBe(true);
    expect(pointInGeometry({ x: 0, y: -0.1 }, d)).toBe(false);
    expect(pointInGeometry({ x: 0, y: 4.9 }, { ...d, closed: false })).toBe(false);
    const mp: Geometry = {
      type: 'multipolygon',
      rings: [square(0, 0, 100), square(20, 20, 60), square(40, 40, 20)],
    };
    expect(pointInGeometry({ x: 10, y: 10 }, mp)).toBe(true);
    expect(pointInGeometry({ x: 30, y: 30 }, mp)).toBe(false);
    expect(pointInGeometry({ x: 50, y: 50 }, mp)).toBe(true);
  });
});

describe('rectangle selection', () => {
  const circle: Geometry = { type: 'circle', c: { x: 0, y: 0 }, r: 10 };

  it('crossing selects outlines that cross or lie inside', () => {
    expect(geometryIntersectsRect(circle, box(5, -2, 20, 2))).toBe(true);
    expect(geometryIntersectsRect(circle, box(-20, -20, 20, 20))).toBe(true);
    expect(geometryIntersectsRect(circle, box(-2, -2, 2, 2))).toBe(false); // inside the disc, outline only
    expect(geometryIntersectsRect(circle, box(-2, -2, 2, 2), { filled: true })).toBe(true);
    expect(geometryIntersectsRect(circle, box(8, 8, 12, 12))).toBe(false); // bbox overlaps, outline does not
    expect(geometryIntersectsRect(circle, box(30, 30, 40, 40))).toBe(false);
    const arc: Geometry = { type: 'arc', c: { x: 0, y: 0 }, r: 10, a0: 0, a1: Math.PI / 2 };
    expect(geometryIntersectsRect(arc, box(-11, -1, -9, 1))).toBe(false);
    expect(geometryIntersectsRect(arc, box(6, 6, 9, 9))).toBe(true);
    expect(geometryIntersectsRect(arc, box(9, -1, 11, 0.5))).toBe(true);
    const full: Geometry = { type: 'arc', c: { x: 0, y: 0 }, r: 10, a0: 2, a1: 2 };
    expect(geometryIntersectsRect(full, box(-11, -1, -9, 1))).toBe(true);
    const ell: Geometry = { type: 'ellipse', c: { x: 0, y: 0 }, rx: 20, ry: 5, rot: 0 };
    expect(geometryIntersectsRect(ell, box(15, -1, 25, 1))).toBe(true);
    expect(geometryIntersectsRect(ell, box(-2, -2, 2, 2))).toBe(false);
    expect(geometryIntersectsRect(ell, box(-2, -2, 2, 2), { filled: true })).toBe(true);
    const pt: Geometry = { type: 'point', p: { x: 1, y: 1 } };
    expect(geometryIntersectsRect(pt, box(0, 0, 2, 2))).toBe(true);
    expect(geometryIntersectsRect(pt, box(1, 1, 2, 2))).toBe(true);
    expect(geometryIntersectsRect(pt, box(1.5, 1.5, 2, 2))).toBe(false);
  });

  it('crossing handles bulge arcs and straight segments', () => {
    const pl: Geometry = {
      type: 'polyline',
      pts: [
        { x: 0, y: 0, bulge: -1 },
        { x: 10, y: 0 },
      ],
      closed: false,
    };
    // Negative bulge: the semicircle arcs upwards (to the left of travel), up to y = 5.
    expect(geometryIntersectsRect(pl, box(4, 4, 6, 6))).toBe(true);
    expect(geometryIntersectsRect(pl, box(4, -6, 6, -4))).toBe(false);
    expect(geometryIntersectsRect(pl, box(4, 1, 6, 3))).toBe(false);
    const seg: Geometry = {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      closed: false,
    };
    expect(geometryIntersectsRect(seg, box(4, 4, 20, 5))).toBe(true);
    expect(geometryIntersectsRect(seg, box(6, 0, 20, 5))).toBe(false);
    expect(geometryIntersectsRect(seg, box(10, 10, 20, 20))).toBe(true); // touching an end point
  });

  it('window selection requires the exact bounds inside', () => {
    const arc: Geometry = { type: 'arc', c: { x: 0, y: 0 }, r: 10, a0: -0.5, a1: 0.5 };
    // Endpoints are at x ≈ 8.78 but the arc reaches x = 10.
    expect(geometryInsideRect(arc, box(0, -6, 9, 6))).toBe(false);
    expect(geometryInsideRect(arc, box(0, -6, 10, 6))).toBe(true);
    expect(geometryInsideRect({ type: 'circle', c: { x: 0, y: 0 }, r: 1 }, box(-1, -1, 1, 1))).toBe(true);
  });
});

describe('lasso selection', () => {
  it('detects shapes inside a concave lasso', () => {
    const inLeft: Geometry = { type: 'circle', c: { x: 20, y: 60 }, r: 10 };
    const inNotch: Geometry = { type: 'circle', c: { x: 50, y: 70 }, r: 5 };
    const crossing: Geometry = { type: 'rect', c: { x: 40, y: 60 }, w: 10, h: 10, rot: 0.2 };
    expect(geometryInsidePolygon(inLeft, lasso)).toBe(true);
    expect(geometryInsidePolygon(inNotch, lasso)).toBe(false);
    expect(geometryInsidePolygon(crossing, lasso)).toBe(false);
    expect(geometryIntersectsPolygon(inLeft, lasso)).toBe(true);
    expect(geometryIntersectsPolygon(inNotch, lasso)).toBe(false);
    expect(geometryIntersectsPolygon(crossing, lasso)).toBe(true);
    const multi: Geometry = { type: 'multipolygon', rings: [square(5, 5, 20), square(70, 70, 20)] };
    expect(geometryInsidePolygon(multi, lasso)).toBe(true);
    const spanning: Geometry = { type: 'multipolygon', rings: [square(5, 5, 20), square(45, 50, 10)] };
    expect(geometryInsidePolygon(spanning, lasso)).toBe(false);
    expect(geometryIntersectsPolygon(spanning, lasso)).toBe(true);
    const ell: Geometry = { type: 'ellipse', c: { x: 80, y: 50 }, rx: 15, ry: 40, rot: 0 };
    expect(geometryInsidePolygon(ell, lasso)).toBe(true);
    const bigEll: Geometry = { type: 'ellipse', c: { x: 50, y: 50 }, rx: 60, ry: 10, rot: 0 };
    expect(geometryInsidePolygon(bigEll, lasso)).toBe(false);
    expect(geometryIntersectsPolygon(bigEll, lasso)).toBe(true);
    const arc: Geometry = { type: 'arc', c: { x: 50, y: 15 }, r: 10, a0: Math.PI, a1: 0 };
    expect(geometryInsidePolygon(arc, lasso)).toBe(true);
    expect(geometryInsidePolygon({ type: 'point', p: { x: 50, y: 50 } }, lasso)).toBe(false);
    expect(geometryInsidePolygon({ type: 'point', p: { x: 50, y: 10 } }, lasso)).toBe(true);
  });

  it('treats filled shapes containing the lasso as hit only when asked', () => {
    const big: Geometry = { type: 'polyline', pts: square(-100, -100, 400), closed: true };
    expect(geometryIntersectsPolygon(big, lasso)).toBe(false);
    expect(geometryIntersectsPolygon(big, lasso, { filled: true })).toBe(true);
    const open: Geometry = { ...big, closed: false };
    expect(geometryIntersectsPolygon(open, lasso, { filled: true })).toBe(false);
  });

  it('handles degenerate lassos', () => {
    const c: Geometry = { type: 'circle', c: { x: 0, y: 0 }, r: 1 };
    expect(geometryIntersectsPolygon(c, [])).toBe(false);
    expect(geometryInsidePolygon(c, [{ x: 0, y: 0 }])).toBe(false);
    expect(
      geometryIntersectsPolygon(c, [
        { x: -5, y: 0 },
        { x: 5, y: 0 },
      ]),
    ).toBe(true);
  });
});
