import { describe, expect, it } from 'vitest';

import type { Geometry, Pt, Vertex } from '@/core/types';

import { bulgeToArc } from './bulge';
import {
  area,
  bounds,
  bulgeMidpoint,
  bulgeSegmentArea,
  centroid,
  diameterOf,
  distanceToBulgeSegment,
  distanceToRing,
  distanceToSegment,
  ellipsePerimeter,
  length,
  perimeter,
  pointInRing,
  polylineBounds,
  polylineLength,
  radiusOf,
  ringDepths,
  signedArea,
} from './measure';

const square = (x0: number, y0: number, s: number): Vertex[] => [
  { x: x0, y: y0 },
  { x: x0 + s, y: y0 },
  { x: x0 + s, y: y0 + s },
  { x: x0, y: y0 + s },
];

/** Polygon centroid by brute-force tessellation (reference). */
function polyCentroid(pts: Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const ox = pts[0].x;
  const oy = pts[0].y;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const x0 = p.x - ox;
    const y0 = p.y - oy;
    const x1 = q.x - ox;
    const y1 = q.y - oy;
    const cr = x0 * y1 - x1 * y0;
    a += cr;
    cx += (x0 + x1) * cr;
    cy += (y0 + y1) * cr;
  }
  return { x: ox + cx / (3 * a), y: oy + cy / (3 * a) };
}

/** Dense tessellation of a bulge ring (n points per arc, no segment cap) for reference values. */
function denseRing(ring: Vertex[], n = 100000): Pt[] {
  const out: Pt[] = [];
  ring.forEach((v, i) => {
    const q = ring[(i + 1) % ring.length];
    out.push({ x: v.x, y: v.y });
    const arc = v.bulge ? bulgeToArc(v, q, v.bulge) : null;
    if (!arc) return;
    for (let k = 1; k < n; k++) {
      const a = arc.a0 + (arc.sweep * k) / n;
      out.push({ x: arc.c.x + arc.r * Math.cos(a), y: arc.c.y + arc.r * Math.sin(a) });
    }
  });
  return out;
}

/** Numerical ellipse perimeter (midpoint rule; spectrally accurate for periodic integrands). */
function ellipsePerimeterNumeric(a: number, b: number, n = 20000): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * 2 * Math.PI;
    s += Math.hypot(a * Math.sin(t), b * Math.cos(t));
  }
  return (s * 2 * Math.PI) / n;
}

describe('signedArea', () => {
  it('is positive for CCW and negative for CW rings', () => {
    expect(signedArea(square(0, 0, 10))).toBeCloseTo(100, 12);
    expect(signedArea([...square(0, 0, 10)].reverse())).toBeCloseTo(-100, 12);
    expect(signedArea([{ x: 1, y: 1 }])).toBe(0);
    expect(signedArea([])).toBe(0);
  });

  it('is exact at UTM coordinates (local origin)', () => {
    const ring = square(600_000.123, 2_500_000.456, 0.01);
    expect(signedArea(ring)).toBeCloseTo(1e-4, 10);
  });

  it('adds circular segments for bulges', () => {
    // Full circle of radius 5 as two semicircular bulges.
    const circle: Vertex[] = [
      { x: 0, y: 0, bulge: 1 },
      { x: 10, y: 0, bulge: 1 },
    ];
    expect(signedArea(circle)).toBeCloseTo(Math.PI * 25, 12);
    expect(signedArea(circle.map((v) => ({ ...v, bulge: -1 })).reverse())).toBeCloseTo(-Math.PI * 25, 12);
    // Square with its right side bulging inward (CCW ring, negative bulge on the side going up).
    const notched: Vertex[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0, bulge: -1 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(signedArea(notched)).toBeCloseTo(100 - (Math.PI * 25) / 2, 12);
  });

  it('uses the small-angle series without loss of accuracy', () => {
    const b = 1e-4;
    const c = 10;
    const theta = 4 * Math.atan(b);
    const r = c / (2 * Math.sin(theta / 2));
    // Reference via the parabolic approximation with the next-order correction: exact for this size to ~1e-12.
    const s = (b * c) / 2;
    const parabola = (2 / 3) * c * s;
    const a = bulgeSegmentArea({ x: 0, y: 0 }, { x: c, y: 0 }, b);
    expect(a).toBeGreaterThan(0);
    expect(Math.abs(a - parabola) / parabola).toBeLessThan(1e-6);
    expect(Math.abs(a - 0.5 * r * r * (theta - Math.sin(theta)))).toBeLessThan(1e-9);
    expect(bulgeSegmentArea({ x: 0, y: 0 }, { x: 0, y: 0 }, 0.5)).toBe(0);
    expect(bulgeSegmentArea({ x: 0, y: 0 }, { x: 1, y: 0 }, 0)).toBe(0);
  });
});

describe('area', () => {
  it('handles analytic shapes', () => {
    expect(area({ type: 'circle', c: { x: 3, y: 4 }, r: 15 })).toBeCloseTo(Math.PI * 225, 9);
    expect(area({ type: 'rect', c: { x: 0, y: 0 }, w: 4, h: -3, rot: 1 })).toBeCloseTo(12, 12);
    expect(area({ type: 'ellipse', c: { x: 0, y: 0 }, rx: 4, ry: 3, rot: 0.3 })).toBeCloseTo(
      Math.PI * 12,
      12,
    );
    expect(area({ type: 'arc', c: { x: 0, y: 0 }, r: 1, a0: 0, a1: 1 })).toBe(0);
    expect(area({ type: 'point', p: { x: 0, y: 0 } })).toBe(0);
    expect(area({ type: 'polyline', pts: square(0, 0, 2), closed: false })).toBe(0);
    expect(area({ type: 'polyline', pts: [...square(0, 0, 2)].reverse(), closed: true })).toBeCloseTo(4, 12);
  });

  it('combines multipolygon rings by containment depth (even–odd)', () => {
    const g: Geometry = {
      type: 'multipolygon',
      rings: [square(0, 0, 100), square(10, 10, 50), square(20, 20, 10), square(200, 0, 10)],
    };
    // 10 000 − 2 500 + 100 + 100
    expect(area(g)).toBeCloseTo(7700, 9);
    expect(ringDepths(g.type === 'multipolygon' ? g.rings : [])).toEqual([0, 1, 2, 0]);
  });

  it('cancels coincident rings and handles touching holes and bulge holes', () => {
    expect(area({ type: 'multipolygon', rings: [square(0, 0, 10), square(0, 0, 10)] })).toBeCloseTo(0, 12);
    // Hole sharing the outer's bottom-left corner and edges.
    expect(area({ type: 'multipolygon', rings: [square(0, 0, 10), square(0, 0, 5)] })).toBeCloseTo(75, 12);
    const hole: Vertex[] = [
      { x: 4, y: 5, bulge: 1 },
      { x: 6, y: 5, bulge: 1 },
    ];
    expect(area({ type: 'multipolygon', rings: [square(0, 0, 10), hole] })).toBeCloseTo(100 - Math.PI, 12);
  });
});

describe('perimeter and length', () => {
  it('handles analytic shapes', () => {
    expect(perimeter({ type: 'circle', c: { x: 0, y: 0 }, r: 15 })).toBeCloseTo(30 * Math.PI, 12);
    expect(
      perimeter({ type: 'arc', c: { x: 0, y: 0 }, r: 2, a0: (3 * Math.PI) / 2, a1: Math.PI / 2 }),
    ).toBeCloseTo(2 * Math.PI, 12);
    expect(perimeter({ type: 'rect', c: { x: 0, y: 0 }, w: 4, h: 3, rot: 0.2 })).toBe(14);
    expect(perimeter({ type: 'point', p: { x: 0, y: 0 } })).toBe(0);
    expect(length({ type: 'arc', c: { x: 0, y: 0 }, r: 10, a0: 0, a1: Math.PI / 2 })).toBeCloseTo(
      5 * Math.PI,
      12,
    );
  });

  it('computes ellipse perimeters to machine precision', () => {
    expect(ellipsePerimeter(2, 1)).toBeCloseTo(9.688448220547675, 13);
    for (const [a, b] of [
      [5, 3],
      [10, 0.1],
      [1, 1],
      [3, 7],
      [1000, 999],
    ]) {
      const ref = ellipsePerimeterNumeric(a, b);
      expect(Math.abs(ellipsePerimeter(a, b) - ref) / ref).toBeLessThan(1e-12);
    }
    expect(ellipsePerimeter(4, 0)).toBe(16);
    expect(ellipsePerimeter(0, 0)).toBe(0);
    expect(perimeter({ type: 'ellipse', c: { x: 0, y: 0 }, rx: 1, ry: 1, rot: 0 })).toBeCloseTo(
      2 * Math.PI,
      14,
    );
  });

  it('measures polylines with bulges, open and closed', () => {
    const pts: Vertex[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0, bulge: 1 },
      { x: 10, y: 10 },
    ];
    expect(polylineLength(pts, false)).toBeCloseTo(10 + 5 * Math.PI, 12);
    expect(perimeter({ type: 'polyline', pts, closed: true })).toBeCloseTo(
      10 + 5 * Math.PI + Math.hypot(10, 10),
      12,
    );
    expect(polylineLength([{ x: 1, y: 1 }], true)).toBe(0);
    expect(perimeter({ type: 'multipolygon', rings: [square(0, 0, 10), square(2, 2, 1)] })).toBeCloseTo(
      44,
      12,
    );
  });
});

describe('centroid', () => {
  it('returns centres and points', () => {
    expect(centroid({ type: 'point', p: { x: 1, y: 2 } })).toEqual({ x: 1, y: 2 });
    expect(centroid({ type: 'circle', c: { x: 1, y: 2 }, r: 3 })).toEqual({ x: 1, y: 2 });
    expect(centroid({ type: 'rect', c: { x: 1, y: 2 }, w: 3, h: 1, rot: 1 })).toEqual({ x: 1, y: 2 });
    expect(centroid({ type: 'ellipse', c: { x: 1, y: 2 }, rx: 3, ry: 1, rot: 1 })).toEqual({ x: 1, y: 2 });
  });

  it('uses the length centroid of arcs', () => {
    const c = centroid({ type: 'arc', c: { x: 0, y: 0 }, r: 3, a0: 0, a1: Math.PI });
    expect(c.x).toBeCloseTo(0, 12);
    expect(c.y).toBeCloseTo(6 / Math.PI, 12);
  });

  it('computes area centroids of polygons and bulge rings', () => {
    const L: Vertex[] = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
    ];
    const c = centroid({ type: 'polyline', pts: L, closed: true });
    expect(c.x).toBeCloseTo(5 / 6, 12);
    expect(c.y).toBeCloseTo(5 / 6, 12);
    // Half disc (D shape): centroid 4r/(3π) above the diameter.
    const d: Vertex[] = [
      { x: 5, y: 0, bulge: 1 },
      { x: -5, y: 0 },
    ];
    const cd = centroid({ type: 'polyline', pts: d, closed: true });
    expect(cd.x).toBeCloseTo(0, 12);
    expect(cd.y).toBeCloseTo(20 / (3 * Math.PI), 12);
  });

  it('matches tessellated references for general bulges (large and small angles)', () => {
    for (const b of [0.7, -0.4, 2.5, 0.01, -0.003]) {
      const ring: Vertex[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0, bulge: b },
        { x: 12, y: 8 },
        { x: -1, y: 6, bulge: 0.3 },
      ];
      const ref = polyCentroid(denseRing(ring));
      const c = centroid({ type: 'polyline', pts: ring, closed: true });
      expect(c.x).toBeCloseTo(ref.x, 6);
      expect(c.y).toBeCloseTo(ref.y, 6);
    }
  });

  it('is accurate at UTM coordinates', () => {
    const X = 600_000;
    const Y = 2_500_000;
    const ring: Vertex[] = [
      { x: X, y: Y },
      { x: X + 10, y: Y, bulge: 0.5 },
      { x: X + 10, y: Y + 10 },
      { x: X, y: Y + 10 },
    ];
    const local = centroid({
      type: 'polyline',
      pts: ring.map((v) => ({ ...v, x: v.x - X, y: v.y - Y })),
      closed: true,
    });
    const world = centroid({ type: 'polyline', pts: ring, closed: true });
    expect(Math.abs(world.x - X - local.x)).toBeLessThan(1e-8);
    expect(Math.abs(world.y - Y - local.y)).toBeLessThan(1e-8);
  });

  it('weights multipolygon holes negatively', () => {
    const c = centroid({ type: 'multipolygon', rings: [square(0, 0, 10), square(5, 0, 5)] });
    // 100 at (5,5) − 25 at (7.5,2.5) → (375 − 187.5)/75 = 2.5·…
    expect(c.x).toBeCloseTo((500 - 187.5) / 75, 12);
    expect(c.y).toBeCloseTo((500 - 62.5) / 75, 12);
  });

  it('uses length centroids for open and degenerate shapes', () => {
    const open = centroid({
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      closed: false,
    });
    expect(open).toEqual({ x: 5, y: 0 });
    // Semicircular arc segment: centroid 2r/π from the centre.
    const arc = centroid({
      type: 'polyline',
      pts: [
        { x: 5, y: 0, bulge: 1 },
        { x: -5, y: 0 },
      ],
      closed: false,
    });
    expect(arc.x).toBeCloseTo(0, 12);
    expect(arc.y).toBeCloseTo(10 / Math.PI, 12);
    // Small-angle arc segment (series branch) against tessellation.
    const flat: Vertex[] = [
      { x: 0, y: 0, bulge: 0.01 },
      { x: 10, y: 0 },
    ];
    const alpha = 2 * Math.atan(0.01);
    const r = 5 / Math.sin(alpha);
    const cFlat = centroid({ type: 'polyline', pts: flat, closed: false });
    expect(cFlat.x).toBeCloseTo(5, 12);
    expect(cFlat.y).toBeCloseTo(r * (Math.cos(alpha) - Math.sin(alpha) / alpha), 12);
    // Zero-area closed polyline falls back to the length centroid.
    const line = centroid({
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ],
      closed: true,
    });
    expect(line).toEqual({ x: 2, y: 0 });
    expect(centroid({ type: 'polyline', pts: [{ x: 3, y: 3 }], closed: false })).toEqual({ x: 3, y: 3 });
    expect(Number.isNaN(centroid({ type: 'polyline', pts: [], closed: false }).x)).toBe(true);
    const flatMulti = centroid({
      type: 'multipolygon',
      rings: [
        [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
      ],
    });
    expect(flatMulti).toEqual({ x: 1, y: 0 });
    expect(
      centroid({
        type: 'polyline',
        pts: [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
        closed: false,
      }),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe('bounds', () => {
  it('is exact for circles, arcs, rects and ellipses', () => {
    expect(bounds({ type: 'circle', c: { x: 1, y: 2 }, r: 3 })).toEqual({
      minX: -2,
      minY: -1,
      maxX: 4,
      maxY: 5,
    });
    const arc = bounds({ type: 'arc', c: { x: 0, y: 0 }, r: 2, a0: Math.PI / 4, a1: (3 * Math.PI) / 4 });
    expect(arc.maxY).toBeCloseTo(2, 12);
    expect(arc.minY).toBeCloseTo(Math.SQRT2, 12);
    expect(arc.minX).toBeCloseTo(-Math.SQRT2, 12);
    const wrap = bounds({ type: 'arc', c: { x: 0, y: 0 }, r: 1, a0: -0.1, a1: 0.1 });
    expect(wrap.maxX).toBeCloseTo(1, 12);
    const rect = bounds({ type: 'rect', c: { x: 0, y: 0 }, w: 2, h: 2, rot: Math.PI / 4 });
    expect(rect.maxX).toBeCloseTo(Math.SQRT2, 12);
    const ell = bounds({ type: 'ellipse', c: { x: 0, y: 0 }, rx: 5, ry: 2, rot: 0.6 });
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 100000; i++) {
      const t = (i / 100000) * 2 * Math.PI;
      const x = 5 * Math.cos(t);
      const y = 2 * Math.sin(t);
      maxX = Math.max(maxX, x * Math.cos(0.6) - y * Math.sin(0.6));
      maxY = Math.max(maxY, x * Math.sin(0.6) + y * Math.cos(0.6));
    }
    expect(ell.maxX).toBeCloseTo(maxX, 6);
    expect(ell.maxY).toBeCloseTo(maxY, 6);
    expect(bounds({ type: 'point', p: { x: 1, y: 2 } })).toEqual({ minX: 1, minY: 2, maxX: 1, maxY: 2 });
  });

  it('includes bulge extremes', () => {
    const pts: Vertex[] = [
      { x: 0, y: 0, bulge: 1 },
      { x: 10, y: 0, bulge: -1 },
      { x: 20, y: 0 },
    ];
    const b = bounds({ type: 'polyline', pts, closed: false });
    expect(b.minY).toBeCloseTo(-5, 12);
    expect(b.maxY).toBeCloseTo(5, 12);
    // The last vertex's bulge is ignored on open polylines.
    const open = polylineBounds(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0, bulge: 1 },
      ],
      false,
    );
    expect(open.minY).toBe(0);
    const mp = bounds({ type: 'multipolygon', rings: [square(0, 0, 1), square(5, 5, 1)] });
    expect(mp).toEqual({ minX: 0, minY: 0, maxX: 6, maxY: 6 });
  });
});

describe('radius and diameter', () => {
  it('reports radii where meaningful', () => {
    expect(radiusOf({ type: 'circle', c: { x: 0, y: 0 }, r: 15 })).toBe(15);
    expect(diameterOf({ type: 'circle', c: { x: 0, y: 0 }, r: 15 })).toBe(30);
    expect(radiusOf({ type: 'arc', c: { x: 0, y: 0 }, r: 4, a0: 0, a1: 1 })).toBe(4);
    expect(radiusOf({ type: 'ellipse', c: { x: 0, y: 0 }, rx: 4, ry: 4, rot: 0 })).toBe(4);
    expect(radiusOf({ type: 'ellipse', c: { x: 0, y: 0 }, rx: 4, ry: 3, rot: 0 })).toBeNull();
    const circlePl: Vertex[] = [
      { x: 0, y: 0, bulge: 1 },
      { x: 10, y: 0, bulge: 1 },
    ];
    expect(radiusOf({ type: 'polyline', pts: circlePl, closed: true })).toBeCloseTo(5, 12);
    expect(radiusOf({ type: 'multipolygon', rings: [circlePl] })).toBeCloseTo(5, 12);
    expect(radiusOf({ type: 'multipolygon', rings: [circlePl, circlePl] })).toBeNull();
    expect(radiusOf({ type: 'polyline', pts: square(0, 0, 1), closed: true })).toBeNull();
    expect(radiusOf({ type: 'polyline', pts: [{ x: 0, y: 0 }], closed: false })).toBeNull();
    const mixed: Vertex[] = [
      { x: 0, y: 0, bulge: 1 },
      { x: 10, y: 0, bulge: 0.5 },
    ];
    expect(radiusOf({ type: 'polyline', pts: mixed, closed: true })).toBeNull();
    expect(diameterOf({ type: 'point', p: { x: 0, y: 0 } })).toBeNull();
    expect(radiusOf({ type: 'rect', c: { x: 0, y: 0 }, w: 1, h: 1, rot: 0 })).toBeNull();
  });
});

describe('ring helpers', () => {
  it('tests points against bulge rings', () => {
    const ring: Vertex[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0, bulge: 1 }, // bulges outward to the right (x up to 15)
      { x: 10, y: 10 },
      { x: 0, y: 10, bulge: -1 }, // notch into the square from the left (x down to 5... reaching x = 5 at y = 5)
    ];
    // Segment 3 goes from (0,10) to (0,0); a negative bulge arcs to its left = into the square.
    expect(pointInRing({ x: 14, y: 5 }, ring)).toBe(true);
    expect(pointInRing({ x: 16, y: 5 }, ring)).toBe(false);
    expect(pointInRing({ x: 2, y: 5 }, ring)).toBe(false);
    expect(pointInRing({ x: 7, y: 5 }, ring)).toBe(true);
    expect(pointInRing({ x: 4, y: 0.5 }, ring)).toBe(true);
    expect(pointInRing({ x: 1, y: 0.5 }, ring)).toBe(false);
  });

  it('measures distances to bulge segments and rings', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distanceToBulgeSegment({ x: 5, y: -8 }, a, b, 1)).toBeCloseTo(3, 12);
    expect(distanceToBulgeSegment({ x: 5, y: 8 }, a, b, 1)).toBeCloseTo(Math.hypot(5, 8), 12);
    expect(distanceToBulgeSegment({ x: 5, y: 8 }, a, b, -1)).toBeCloseTo(3, 12);
    expect(distanceToBulgeSegment({ x: 5, y: 3 }, a, b, 0)).toBe(3);
    expect(distanceToSegment({ x: -3, y: 4 }, a, b)).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, a, a)).toBe(5);
    expect(distanceToRing({ x: 5, y: 5 }, square(0, 0, 10))).toBe(5);
    expect(distanceToRing({ x: 5, y: 5 }, square(0, 0, 10), false)).toBe(5);
    expect(distanceToRing({ x: 5, y: 5 }, [])).toBe(Infinity);
    expect(distanceToRing({ x: 3, y: 4 }, [{ x: 0, y: 0 }])).toBe(5);
  });

  it('computes bulge midpoints', () => {
    const m = bulgeMidpoint({ x: 0, y: 0 }, { x: 10, y: 0 }, 1);
    expect(m.x).toBeCloseTo(5, 12);
    expect(m.y).toBeCloseTo(-5, 12);
    expect(bulgeMidpoint({ x: 0, y: 0 }, { x: 10, y: 0 }, undefined)).toEqual({ x: 5, y: 0 });
  });
});
