import { FillRule } from '@countertype/clipper2-ts';
import { describe, expect, it } from 'vitest';

import type { Pt } from '@/core/types';

import {
  CLIPPER_MAX_COORD,
  CLIPPER_MAX_SCALE,
  booleanPolygons,
  clipFillRule,
  clipToTree,
  countRings,
  createFrame,
  frameMaxError,
  fromPaths64,
  normalizePaths,
  polyTreeToPolygons,
  polygonsArea,
  polygonsToGeometry,
  toPaths64,
} from './clipper';
import { signedArea } from './measure';

const sq = (x0: number, y0: number, s: number): Pt[] => [
  { x: x0, y: y0 },
  { x: x0 + s, y: y0 },
  { x: x0 + s, y: y0 + s },
  { x: x0, y: y0 + s },
];

describe('clipper frame', () => {
  it('uses a local origin and keeps |X|, |Y| ≤ 2^25 so cross products are exact', () => {
    const ring = sq(600_000, 2_500_000, 10_000); // 10 km site at UTM coordinates
    const f = createFrame([ring], 50);
    expect(f.ox).toBe(605_000);
    expect(f.oy).toBe(2_505_000);
    const ints = toPaths64([ring], f)[0];
    const max = Math.max(...ints.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
    expect(max).toBeLessThanOrEqual(CLIPPER_MAX_COORD);
    // Largest possible cross-product term: (2·2^25)² · 2 = 2^53.
    expect((2 * CLIPPER_MAX_COORD) ** 2 * 2).toBeLessThanOrEqual(2 ** 53);
    // ≤ 0.1 mm quantisation at 10 km extents (NFR-7 / row 61).
    expect(frameMaxError(f)).toBeLessThan(1e-4);
    // The offset margin is reserved too; the scale is rounded down to two significant digits.
    expect(f.scale).toBe(6600);
    expect((5000 + 50) * f.scale).toBeLessThanOrEqual(CLIPPER_MAX_COORD);
  });

  it('round-trips within the quantisation error', () => {
    const ring: Pt[] = [
      { x: 600_123.456789, y: 2_500_987.654321 },
      { x: 600_223.1, y: 2_500_990.2 },
      { x: 600_150.3, y: 2_501_050.9 },
    ];
    const f = createFrame([ring]);
    const back = fromPaths64(toPaths64([ring], f), f)[0];
    back.forEach((p, i) => {
      expect(Math.abs(p.x - ring[i].x)).toBeLessThanOrEqual(frameMaxError(f) + 1e-9);
      expect(Math.abs(p.y - ring[i].y)).toBeLessThanOrEqual(frameMaxError(f) + 1e-9);
    });
  });

  it('caps the scale for tiny or empty inputs', () => {
    expect(createFrame([])).toEqual({ ox: 0, oy: 0, scale: CLIPPER_MAX_SCALE });
    expect(createFrame([[{ x: 5, y: 5 }]]).scale).toBe(CLIPPER_MAX_SCALE);
    expect(createFrame([sq(0, 0, 0.001)]).scale).toBe(CLIPPER_MAX_SCALE);
    expect(createFrame([sq(0, 0, 100)]).scale).toBe(670_000);
    expect(createFrame([sq(0, 0, 1000)]).scale).toBe(67_000);
  });

  it('maps fill rules', () => {
    expect(clipFillRule('evenodd')).toBe(FillRule.EvenOdd);
    expect(clipFillRule('nonzero')).toBe(FillRule.NonZero);
    expect(clipFillRule('positive')).toBe(FillRule.Positive);
    expect(clipFillRule('negative')).toBe(FillRule.Negative);
  });
});

describe('clipper polygons', () => {
  it('normalises orientation and nests holes and islands', () => {
    const rings = [sq(0, 0, 100), sq(10, 10, 80).reverse(), sq(20, 20, 20), sq(200, 0, 10)];
    const f = createFrame(rings);
    const norm = normalizePaths(toPaths64(rings, f), 'evenodd');
    expect(norm).toHaveLength(4);
    const polys = polyTreeToPolygons(clipToTree('union', norm, null, 'nonzero'), f);
    expect(polys).toHaveLength(3);
    expect(countRings(polys)).toBe(4);
    for (const p of polys) {
      expect(signedArea(p.outer)).toBeGreaterThan(0);
      for (const h of p.holes) expect(signedArea(h)).toBeLessThan(0);
    }
    expect(polygonsArea(polys)).toBe(10_000 - 6_400 + 400 + 100); // whole-metre inputs are exact
    const g = polygonsToGeometry(polys);
    expect(g?.type).toBe('multipolygon');
  });

  it('runs boolean operations on float rings', () => {
    const a = [sq(0, 0, 10)];
    const b = [sq(5, 5, 10)];
    expect(polygonsArea(booleanPolygons('union', [...a, ...b], null, 'nonzero'))).toBeCloseTo(175, 9);
    expect(polygonsArea(booleanPolygons('intersection', a, b, 'nonzero'))).toBeCloseTo(25, 9);
    expect(polygonsArea(booleanPolygons('difference', a, b, 'nonzero'))).toBeCloseTo(75, 9);
    expect(polygonsArea(booleanPolygons('xor', a, b, 'nonzero'))).toBeCloseTo(150, 9);
    expect(polygonsArea(booleanPolygons('union', [...a, ...a], null, 'evenodd'))).toBe(0);
  });

  it('converts polygons to geometry', () => {
    expect(polygonsToGeometry([])).toBeNull();
    const single = polygonsToGeometry([{ outer: sq(0, 0, 1), holes: [] }]);
    expect(single).toEqual({ type: 'polyline', pts: sq(0, 0, 1), closed: true });
    const holed = polygonsToGeometry([{ outer: sq(0, 0, 4), holes: [sq(1, 1, 1)] }]);
    expect(holed?.type === 'multipolygon' && holed.rings.length).toBe(2);
  });
});
