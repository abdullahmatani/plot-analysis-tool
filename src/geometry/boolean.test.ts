import { describe, expect, it } from 'vitest';

import type { Geometry, Vertex } from '@/core/types';

import {
  differenceGeometries,
  intersectGeometries,
  unionArea,
  unionGeometries,
  unionPolygons,
} from './boolean';
import { offsetGeometry } from './offset';
import { area, perimeter } from './measure';

const TOL = 0.005;

/** Lens (intersection) area of two circles of radius r with centre distance d. */
const lens = (r: number, d: number): number =>
  2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);

const square = (x0: number, y0: number, s: number): Vertex[] => [
  { x: x0, y: y0 },
  { x: x0 + s, y: y0 },
  { x: x0 + s, y: y0 + s },
  { x: x0, y: y0 + s },
];

describe('boolean operations (rows 60, 74)', () => {
  const r = 50;
  const dc = 60;
  const a: Geometry = { type: 'circle', c: { x: 600_000, y: 2_500_000 }, r };
  const b: Geometry = { type: 'circle', c: { x: 600_000 + dc, y: 2_500_000 }, r };
  // Tessellation with vertices on the curve under-estimates areas by < chordTol × perimeter.
  const tolArea = TOL * (perimeter(a) + perimeter(b));

  it('merged envelope area equals the Clipper union area and the analytic lens formula', () => {
    const env = unionGeometries([a, b], TOL)!;
    expect(env.type).toBe('polyline');
    const exact = 2 * Math.PI * r * r - lens(r, dc);
    expect(Math.abs(unionArea([a, b], TOL) - exact)).toBeLessThan(tolArea);
    expect(area(env)).toBeCloseTo(unionArea([a, b], TOL), 6);
    const inter = intersectGeometries(a, b, TOL)!;
    expect(Math.abs(area(inter) - lens(r, dc))).toBeLessThan(tolArea);
    const diff = differenceGeometries(a, b, TOL)!;
    expect(Math.abs(area(diff) - (Math.PI * r * r - lens(r, dc)))).toBeLessThan(tolArea);
  });

  it('merges batch offsets into one envelope (row 60)', () => {
    const sources: Geometry[] = [
      { type: 'rect', c: { x: 0, y: 0 }, w: 20, h: 10, rot: 0.3 },
      { type: 'polyline', pts: square(25, -5, 10), closed: true },
      { type: 'circle', c: { x: 100, y: 0 }, r: 5 },
    ];
    const offsets = sources.map((g) => offsetGeometry(g, 8, { join: 'round', chordTol: TOL }).geometry!);
    const env = unionGeometries(offsets, TOL)!;
    expect(env.type).toBe('multipolygon'); // the circle stays separate
    expect(area(env)).toBeCloseTo(unionArea(offsets, TOL), 6);
    expect(area(env)).toBeLessThan(offsets.reduce((s, g) => s + area(g), 0));
  });

  it('respects holes and even–odd multipolygons', () => {
    const holed: Geometry = { type: 'multipolygon', rings: [square(0, 0, 100), square(25, 25, 50)] };
    expect(unionArea([holed], TOL)).toBeCloseTo(7500, 6);
    const plug: Geometry = { type: 'rect', c: { x: 50, y: 50 }, w: 60, h: 60, rot: 0 };
    const filled = unionGeometries([holed, plug], TOL)!;
    expect(filled.type).toBe('polyline');
    expect(area(filled)).toBeCloseTo(10_000, 6);
    const partial = unionPolygons([holed, { type: 'rect', c: { x: 50, y: 50 }, w: 20, h: 20, rot: 0 }], TOL);
    expect(partial).toHaveLength(2); // the island inside the hole is its own polygon
  });

  it('ignores open shapes and handles empty results', () => {
    const line: Geometry = {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      closed: false,
    };
    expect(unionGeometries([line, { type: 'point', p: { x: 0, y: 0 } }], TOL)).toBeNull();
    expect(unionArea([], TOL)).toBe(0);
    const far: Geometry = { type: 'circle', c: { x: 1000, y: 0 }, r: 1 };
    expect(intersectGeometries(a, far, TOL)).toBeNull();
    expect(differenceGeometries(far, { type: 'circle', c: { x: 1000, y: 0 }, r: 2 }, TOL)).toBeNull();
    expect(intersectGeometries(a, line, TOL)).toBeNull();
    const ell: Geometry = { type: 'ellipse', c: { x: 0, y: 0 }, rx: 10, ry: 5, rot: 0 };
    expect(Math.abs(unionArea([ell], TOL) - Math.PI * 50)).toBeLessThan(TOL * perimeter(ell));
  });
});
