import { describe, expect, it } from 'vitest';

import { apply, multiply, rotate, scale, translate } from '@/core/affine';
import type { Affine2D, Geometry, Pt, Vertex } from '@/core/types';

import {
  cloneGeometry,
  ellipseOfLinear,
  isClosed,
  mirrorGeometry,
  rectCorners,
  rotateGeometry,
  scaleGeometry,
  tessellateArc,
  tessellateEllipse,
  toPolyline,
  toRings,
  transformGeometry,
  translateGeometry,
} from './convert';
import { distanceToGeometry } from './hit';
import { area, perimeter, signedArea } from './measure';

const TOL = 0.005;

/** Every densely sampled point of `src`, mapped by `f`, must lie on `dst` (within eps). */
function expectMapsOnto(src: Geometry, dst: Geometry, f: (p: Pt) => Pt, eps = 1e-9): void {
  const samples = toRings(src, 1e-4).flat();
  for (const p of samples) expect(distanceToGeometry(f(p), dst)).toBeLessThan(eps);
}

const shapes: Geometry[] = [
  { type: 'circle', c: { x: 3, y: -2 }, r: 5 },
  { type: 'arc', c: { x: 1, y: 1 }, r: 4, a0: 0.3, a1: 2.2 },
  { type: 'arc', c: { x: 1, y: 1 }, r: 4, a0: 5.5, a1: 0.5 },
  { type: 'rect', c: { x: 2, y: 3 }, w: 6, h: 2, rot: 0.4 },
  { type: 'ellipse', c: { x: -1, y: 2 }, rx: 5, ry: 2, rot: 0.7 },
  {
    type: 'polyline',
    pts: [
      { x: 0, y: 0 },
      { x: 10, y: 0, bulge: 0.4 },
      { x: 10, y: 6 },
      { x: 0, y: 6, bulge: -0.3 },
    ],
    closed: true,
  },
  {
    type: 'polyline',
    pts: [
      { x: 0, y: 0, bulge: 0.8 },
      { x: 4, y: 1 },
      { x: 6, y: -2 },
    ],
    closed: false,
  },
  {
    type: 'multipolygon',
    rings: [
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      [
        { x: 5, y: 10, bulge: 1 },
        { x: 15, y: 10, bulge: 1 },
      ],
    ],
  },
];

describe('isClosed / clone', () => {
  it('classifies shapes', () => {
    expect(shapes.map(isClosed)).toEqual([true, false, false, true, true, true, false, true]);
    expect(isClosed({ type: 'point', p: { x: 0, y: 0 } })).toBe(false);
  });

  it('deep-copies geometry', () => {
    for (const g of [...shapes, { type: 'point', p: { x: 1, y: 2 } } as Geometry]) {
      const c = cloneGeometry(g);
      expect(c).toEqual(g);
      expect(c).not.toBe(g);
    }
    const pl = shapes[5] as Extract<Geometry, { type: 'polyline' }>;
    const copy = cloneGeometry(pl) as typeof pl;
    copy.pts[0].x = 99;
    expect(pl.pts[0].x).toBe(0);
  });
});

describe('toPolyline / toRings', () => {
  it('represents circles and arcs exactly with bulges', () => {
    const circle = toPolyline(shapes[0], TOL);
    expect(circle).toHaveLength(1);
    expect(circle[0]).toHaveLength(2);
    expect(circle[0].every((v) => v.bulge === 1)).toBe(true);
    expect(signedArea(circle[0])).toBeCloseTo(Math.PI * 25, 12);

    const arc = shapes[1] as Extract<Geometry, { type: 'arc' }>;
    const pl = toPolyline(arc, TOL)[0];
    expect(pl).toHaveLength(2);
    expect(perimeter({ type: 'polyline', pts: pl, closed: false })).toBeCloseTo(perimeter(arc), 12);
    expectMapsOnto({ type: 'polyline', pts: pl, closed: false }, arc, (p) => p);

    const big: Geometry = { type: 'arc', c: { x: 0, y: 0 }, r: 2, a0: 0, a1: 1.9 * Math.PI };
    const bigPl = toPolyline(big, TOL)[0];
    expect(bigPl).toHaveLength(3);
    expect(perimeter({ type: 'polyline', pts: bigPl, closed: false })).toBeCloseTo(perimeter(big), 12);
    const full = toPolyline({ type: 'arc', c: { x: 0, y: 0 }, r: 2, a0: 1, a1: 1 }, TOL)[0];
    expect(perimeter({ type: 'polyline', pts: full, closed: false })).toBeCloseTo(4 * Math.PI, 12);
  });

  it('converts rects, ellipses, polylines, multipolygons and points', () => {
    const rect = toPolyline(shapes[3], TOL)[0];
    expect(rect).toHaveLength(4);
    expect(signedArea(rect)).toBeCloseTo(12, 12);
    const ell = shapes[4] as Extract<Geometry, { type: 'ellipse' }>;
    const ring = toPolyline(ell, TOL)[0];
    expect(signedArea(ring)).toBeGreaterThan(0);
    // Chord midpoints stay within the chord tolerance of the true ellipse.
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      expect(distanceToGeometry({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ell)).toBeLessThanOrEqual(
        TOL + 1e-12,
      );
      expect(distanceToGeometry(a, ell)).toBeLessThan(1e-9);
    }
    expect(toPolyline(shapes[5], TOL)[0]).toEqual((shapes[5] as Extract<Geometry, { type: 'polyline' }>).pts);
    expect(toPolyline(shapes[7], TOL)).toHaveLength(2);
    expect(toPolyline({ type: 'point', p: { x: 1, y: 2 } }, TOL)).toEqual([[{ x: 1, y: 2 }]]);
  });

  it('flattens to straight rings within the chord tolerance', () => {
    const rings = toRings(shapes[0], TOL);
    expect(rings).toHaveLength(1);
    for (const p of rings[0]) expect(Math.hypot(p.x - 3, p.y + 2)).toBeCloseTo(5, 12);
    expect(Math.PI * 25 - signedArea(rings[0])).toBeLessThan(TOL * perimeter(shapes[0]));
    const arcPts = toRings(shapes[1], TOL)[0];
    expect(arcPts[0].x).toBeCloseTo(1 + 4 * Math.cos(0.3), 12);
    expect(arcPts[arcPts.length - 1].y).toBeCloseTo(1 + 4 * Math.sin(2.2), 12);
    expect(toRings(shapes[3], TOL)[0]).toHaveLength(4);
    expect(toRings(shapes[4], TOL)[0].length).toBeGreaterThan(8);
    const open = toRings(shapes[6], TOL)[0];
    expect(open[open.length - 1]).toEqual({ x: 6, y: -2 });
    expect(toRings(shapes[7], TOL)).toHaveLength(2);
    expect(toRings({ type: 'point', p: { x: 1, y: 2 } }, TOL)).toEqual([[{ x: 1, y: 2 }]]);
  });

  it('tessellates arcs and ellipses', () => {
    const pts = tessellateArc({ x: 0, y: 0 }, 10, 0, Math.PI / 2, 0.001);
    expect(pts[0]).toEqual({ x: 10, y: 0 });
    expect(pts[pts.length - 1].x).toBeCloseTo(0, 12);
    expect(tessellateEllipse({ x: 0, y: 0 }, 0, 0, 0, TOL)).toHaveLength(8);
  });

  it('orders rect corners counter-clockwise', () => {
    const c = rectCorners({ type: 'rect', c: { x: 0, y: 0 }, w: 2, h: 1, rot: Math.PI / 2 });
    expect(c[0].x).toBeCloseTo(0.5, 12);
    expect(c[0].y).toBeCloseTo(-1, 12);
    expect(signedArea(c)).toBeCloseTo(2, 12);
  });
});

describe('ellipseOfLinear', () => {
  it('returns singular values and the major-axis direction', () => {
    expect(ellipseOfLinear(2, 0, 0, 1)).toEqual({ rx: 2, ry: 1, rot: 0 });
    const e = ellipseOfLinear(1, 0, 0, 2);
    expect(e.rx).toBe(2);
    expect(e.ry).toBe(1);
    expect(Math.abs(Math.cos(e.rot))).toBeCloseTo(0, 12);
    const r = ellipseOfLinear(0, 2, -1, 0); // rotate 90° ∘ diag(2, 1)
    expect(r.rx).toBeCloseTo(2, 12);
    expect(Math.abs(Math.sin(r.rot))).toBeCloseTo(1, 12);
  });
});

describe('transformGeometry', () => {
  const sim: Affine2D = multiply(translate(600_000, 2_500_000), multiply(rotate(0.9), scale(2.5)));
  const mirror: Affine2D = multiply(translate(-50, 20), multiply(rotate(0.3), scale(1.5, -1.5)));
  const stretch: Affine2D = [3, 0, 0, 1, 10, -4];
  const shear: Affine2D = [1, 0.2, 0.7, 1.1, 0, 0];

  it('keeps shapes analytic under similarity transforms', () => {
    for (const g of shapes) {
      const t = transformGeometry(g, sim, TOL);
      expect(t.type).toBe(g.type);
      expectMapsOnto(g, t, (p) => apply(sim, p), 1e-7);
      expect(area(t)).toBeCloseTo(area(g) * 6.25, 6);
      expect(perimeter(t)).toBeCloseTo(perimeter(g) * 2.5, 6);
    }
  });

  it('handles mirrored similarities (bulge signs and arc direction flip)', () => {
    for (const g of shapes) {
      const t = transformGeometry(g, mirror, TOL);
      expect(t.type).toBe(g.type);
      expectMapsOnto(g, t, (p) => apply(mirror, p), 1e-7);
      expect(area(t)).toBeCloseTo(area(g) * 2.25, 6);
      expect(perimeter(t)).toBeCloseTo(perimeter(g) * 1.5, 6);
    }
    const pl = transformGeometry(shapes[5], mirror, TOL) as Extract<Geometry, { type: 'polyline' }>;
    expect(pl.pts[1].bulge).toBe(-0.4);
    expect(signedArea(pl.pts)).toBeLessThan(0);
  });

  it('converts under non-uniform transforms', () => {
    for (const m of [stretch, shear]) {
      for (const g of shapes) {
        const t = transformGeometry(g, m, TOL);
        // Analytic results are exact; tessellated ones within the chord tolerance.
        expectMapsOnto(g, t, (p) => apply(m, p), TOL + 1e-9);
        const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
        expect(Math.abs(area(t) - area(g) * det)).toBeLessThan(TOL * perimeter(t) + 1e-9);
      }
    }
    expect(transformGeometry(shapes[0], stretch, TOL).type).toBe('ellipse');
    expect(transformGeometry(shapes[1], stretch, TOL).type).toBe('polyline');
    expect(transformGeometry(shapes[4], shear, TOL).type).toBe('ellipse');
    const axisRect: Geometry = { type: 'rect', c: { x: 0, y: 0 }, w: 4, h: 2, rot: 0 };
    expect(transformGeometry(axisRect, stretch, TOL)).toEqual({
      type: 'rect',
      c: { x: 10, y: -4 },
      w: 12,
      h: 2,
      rot: 0,
    });
    expect(transformGeometry(shapes[3], stretch, TOL).type).toBe('polyline');
    expect(transformGeometry({ type: 'point', p: { x: 1, y: 1 } }, stretch, TOL)).toEqual({
      type: 'point',
      p: { x: 13, y: -3 },
    });
  });

  it('tessellates bulges so that the transformed curve is within the chord tolerance', () => {
    const g: Geometry = {
      type: 'polyline',
      pts: [
        { x: 0, y: 0, bulge: 1 },
        { x: 100, y: 0, bulge: 1 },
      ],
      closed: true,
    };
    const t = transformGeometry(g, stretch, TOL) as Extract<Geometry, { type: 'polyline' }>;
    const ell: Geometry = { type: 'ellipse', c: { x: 160, y: -4 }, rx: 150, ry: 50, rot: 0 };
    for (let i = 0; i < t.pts.length; i++) {
      const a = t.pts[i];
      const b = t.pts[(i + 1) % t.pts.length];
      expect(distanceToGeometry(a, ell)).toBeLessThan(1e-9);
      expect(distanceToGeometry({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ell)).toBeLessThanOrEqual(
        TOL + 1e-9,
      );
    }
  });
});

describe('transform helpers', () => {
  it('translates exactly', () => {
    const g = translateGeometry(shapes[5], 600_000, 2_500_000) as Extract<Geometry, { type: 'polyline' }>;
    expect(g.pts[1]).toEqual({ x: 600_010, y: 2_500_000, bulge: 0.4 });
  });

  it('rotates about a pivot at UTM coordinates without precision loss', () => {
    const about = { x: 600_000.25, y: 2_500_000.75 };
    const g: Geometry = { type: 'circle', c: { x: about.x + 10, y: about.y }, r: 3 };
    const r = rotateGeometry(g, Math.PI / 2, about) as Extract<Geometry, { type: 'circle' }>;
    expect(Math.abs(r.c.x - about.x)).toBeLessThan(1e-9);
    expect(Math.abs(r.c.y - (about.y + 10))).toBeLessThan(1e-9);
    const arc = rotateGeometry(shapes[1], 1) as Extract<Geometry, { type: 'arc' }>;
    expect(arc.a0).toBeCloseTo(1.3, 12);
    expect(arc.a1 - arc.a0).toBeCloseTo(1.9, 12);
    const rect = rotateGeometry(shapes[3], 0.5, { x: 2, y: 3 }) as Extract<Geometry, { type: 'rect' }>;
    expect(rect.rot).toBeCloseTo(0.9, 12);
  });

  it('scales about a pivot (negative k is a point reflection)', () => {
    const c = scaleGeometry(shapes[0], 2, { x: 3, y: -2 }) as Extract<Geometry, { type: 'circle' }>;
    expect(c).toEqual({ type: 'circle', c: { x: 3, y: -2 }, r: 10 });
    const r = scaleGeometry(shapes[5], -1) as Extract<Geometry, { type: 'polyline' }>;
    expect(r.pts[1]).toEqual({ x: -10, y: 0, bulge: 0.4 });
    expect(area(r)).toBeCloseTo(area(shapes[5]), 9);
    const e = scaleGeometry(shapes[4], 0.5) as Extract<Geometry, { type: 'ellipse' }>;
    expect(e.rx).toBe(2.5);
    expect(e.ry).toBe(1);
  });

  it('mirrors across a line', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 1, y: 1 };
    const arc: Geometry = { type: 'arc', c: { x: 0, y: 0 }, r: 1, a0: 0, a1: Math.PI / 2 };
    const m = mirrorGeometry(arc, a, b) as Extract<Geometry, { type: 'arc' }>;
    // The quarter arc from +x to +y is symmetric about y = x.
    expect(Math.cos(m.a0)).toBeCloseTo(1, 12);
    expect(m.a1 - m.a0).toBeCloseTo(Math.PI / 2, 12);
    const pl: Vertex[] = [
      { x: 2, y: 0, bulge: 0.5 },
      { x: 4, y: 0 },
    ];
    const mp = mirrorGeometry({ type: 'polyline', pts: pl, closed: false }, a, b) as Extract<
      Geometry,
      { type: 'polyline' }
    >;
    expect(mp.pts[0].x).toBeCloseTo(0, 12);
    expect(mp.pts[0].y).toBeCloseTo(2, 12);
    expect(mp.pts[0].bulge).toBe(-0.5);
    const mpoly = mirrorGeometry(shapes[7], { x: 0, y: 10 }, { x: 1, y: 10 });
    expect(area(mpoly)).toBeCloseTo(area(shapes[7]), 9);
  });
});
