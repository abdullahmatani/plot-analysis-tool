import { describe, expect, it } from 'vitest';

import { readPoly } from '@/underlay/entity-store';

import { interpolateFitPoints as dwgFit } from './dwg/spline';
import { parseDxf } from './dxf';
import { interpolateFitPoints as dxfFit, tessellateNurbs } from './dxf/spline';
import { fineEnough, SPLINE_TOL_METRES, splineTolerance, tolUnder } from './spline-tolerance';

/**
 * Splines are stored as polylines that snapping, measuring, tracing and offsets use, so NFR-7
 * (1 mm at site extents up to 10 km) applies to their tessellation: at most 0.5 mm from the true
 * curve when the drawing's units are known, so a distance between two snapped points stays within 1 mm.
 */

const X0 = 600_000;
const Y0 = 2_500_000;
const S = Math.SQRT1_2;

/** Largest distance from a circle of the chords between consecutive points (which lie on it). */
function chordDeviation(pts: { x: number; y: number }[], c: { x: number; y: number }, r: number): number {
  let worst = 0;
  for (let k = 1; k < pts.length; k++) {
    const mx = (pts[k - 1].x + pts[k].x) / 2 - c.x;
    const my = (pts[k - 1].y + pts[k].y) / 2 - c.y;
    worst = Math.max(worst, r - Math.hypot(mx, my));
  }
  return worst;
}

/** A SPLINE that is exactly a quarter circle of radius r around (cx, cy): rational quadratic. */
function quarterCircle(cx: number, cy: number, r: number): string {
  const lines = ['0', 'SPLINE', '8', '0', '70', '12', '71', '2', '72', '6', '73', '3'];
  for (const k of [0, 0, 0, 1, 1, 1]) lines.push('40', String(k));
  for (const w of [1, S, 1]) lines.push('41', String(w));
  for (const [x, y] of [
    [cx + r, cy],
    [cx + r, cy + r],
    [cx, cy + r],
  ])
    lines.push('10', String(x), '20', String(y), '30', '0');
  return lines.join('\n');
}

function dxf(insunits: number, entities: string, blocks = ''): Uint8Array {
  const parts = [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$ACADVER',
    '1',
    'AC1015',
    '9',
    '$INSUNITS',
    '70',
    String(insunits),
    '0',
    'ENDSEC',
  ];
  if (blocks) parts.push('0', 'SECTION', '2', 'BLOCKS', blocks, '0', 'ENDSEC');
  parts.push('0', 'SECTION', '2', 'ENTITIES', entities, '0', 'ENDSEC', '0', 'EOF');
  return new TextEncoder().encode(parts.join('\n'));
}

describe('spline tessellation accuracy (NFR-7)', () => {
  it('converts the tolerance to drawing units and scales it for block inserts', () => {
    expect(SPLINE_TOL_METRES).toBe(5e-4);
    expect(splineTolerance(6)).toBeCloseTo(5e-4, 15); // metres
    expect(splineTolerance(4)).toBeCloseTo(0.5, 12); // millimetres
    expect(splineTolerance(0)).toBeUndefined(); // unitless: relative tolerance only
    expect(splineTolerance(undefined)).toBeUndefined();
    expect(tolUnder(1, null)).toBe(1);
    expect(tolUnder(1, { m0: 10, m1: 0, m4: 0, m5: 2 })).toBeCloseTo(0.1, 15); // the larger stretch
    expect(tolUnder(undefined, { m0: 10, m1: 0, m4: 0, m5: 10 })).toBeUndefined();
    expect(fineEnough(0.1, 0.2)).toBe(true);
    expect(fineEnough(0.2, 0.1)).toBe(false);
    expect(fineEnough(undefined, 0.1)).toBe(false);
    expect(fineEnough(undefined, undefined)).toBe(true);
  });

  it('a 500 m spline in a metre drawing stays within 0.5 mm of the true curve; unitless, within its relative tolerance', () => {
    const c = { x: X0, y: Y0 };
    const metres = parseDxf(dxf(6, quarterCircle(X0, Y0, 500)));
    const pts = readPoly(metres.store, 0);
    expect(chordDeviation(pts, c, 500)).toBeLessThanOrEqual(5e-4);
    expect(pts.length).toBeLessThan(2_000);
    // Without units only the relative tolerance (5 × 10⁻⁵ of the 707 m control polygon) applies.
    const unitless = readPoly(parseDxf(dxf(0, quarterCircle(X0, Y0, 500))).store, 0);
    expect(chordDeviation(unitless, c, 500)).toBeGreaterThan(1e-3);
    expect(chordDeviation(unitless, c, 500)).toBeLessThanOrEqual(5e-5 * 500 * Math.SQRT2);
  });

  it('a spline in a block inserted at 10× is refined for its size in the drawing', () => {
    const blocks = [
      '0',
      'BLOCK',
      '8',
      '0',
      '2',
      'ARC50',
      '70',
      '0',
      '10',
      '0',
      '20',
      '0',
      '30',
      '0',
      '3',
      'ARC50',
      quarterCircle(0, 0, 50),
      '0',
      'ENDBLK',
      '8',
      '0',
    ].join('\n');
    const ins = (x: number, scale: number) =>
      [
        '0',
        'INSERT',
        '8',
        '0',
        '2',
        'ARC50',
        '10',
        String(x),
        '20',
        String(Y0),
        '30',
        '0',
        '41',
        String(scale),
        '42',
        String(scale),
        '43',
        '1',
      ].join('\n');
    const r = parseDxf(dxf(6, `${ins(X0, 10)}\n${ins(X0 + 2_000, 1)}`, blocks));
    // Scaled 10×: a 500 m arc in the drawing, still within 0.5 mm; at 1×, a 50 m arc likewise.
    expect(chordDeviation(readPoly(r.store, 0), { x: X0, y: Y0 }, 500)).toBeLessThanOrEqual(5e-4);
    expect(chordDeviation(readPoly(r.store, 1), { x: X0 + 2_000, y: Y0 }, 50)).toBeLessThanOrEqual(5e-4);
  });

  it('NURBS tessellation keeps the relative tolerance unless a smaller one is given', () => {
    const ctrl = [500, 0, 0, 500, 500, 0, 0, 500, 0];
    const at = (maxTol?: number) => {
      const p = tessellateNurbs(2, [0, 0, 0, 1, 1, 1], ctrl, [1, S, 1], undefined, maxTol);
      return Array.from({ length: p.length / 3 }, (_, k) => ({ x: p[k * 3], y: p[k * 3 + 1] }));
    };
    const o = { x: 0, y: 0 };
    expect(chordDeviation(at(), o, 500)).toBeGreaterThan(1e-3);
    expect(chordDeviation(at(1), o, 500)).toBeCloseTo(chordDeviation(at(), o, 500), 12); // larger: no effect
    expect(chordDeviation(at(5e-4), o, 500)).toBeLessThanOrEqual(5e-4);
  });

  it.each([
    ['DXF', dxfFit],
    ['DWG', dwgFit],
  ] as const)('%s fit-point splines are refined to the tolerance between fit points', (_, fit) => {
    // Fit points every 40° on a 200 m circle (140 m apart).
    const pts: number[] = [];
    for (let a = 0; a <= 160; a += 40)
      pts.push(200 * Math.cos((a * Math.PI) / 180), 200 * Math.sin((a * Math.PI) / 180), 0);
    const flat = (p: number[]) =>
      Array.from({ length: p.length / 3 }, (_, k) => ({ x: p[k * 3], y: p[k * 3 + 1] }));
    // 10 µm: fine enough as a reference and within the 20 000-point budget of one spline.
    const reference = flat(fit(pts, null, null, false, 1e-5));
    /** Largest distance of the chords' midpoints from the (finely tessellated) curve. */
    const gap = (poly: { x: number; y: number }[]) => {
      let worst = 0;
      for (let k = 1; k < poly.length; k++) {
        const m = { x: (poly[k - 1].x + poly[k].x) / 2, y: (poly[k - 1].y + poly[k].y) / 2 };
        let best = Infinity;
        for (let j = 1; j < reference.length; j++) {
          const a = reference[j - 1];
          const b = reference[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const t = Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / (dx * dx + dy * dy)));
          best = Math.min(best, Math.hypot(m.x - a.x - t * dx, m.y - a.y - t * dy));
        }
        worst = Math.max(worst, best);
      }
      return worst;
    };
    const plain = flat(fit(pts, null, null, false));
    const refined = flat(fit(pts, null, null, false, 5e-4));
    expect(gap(plain)).toBeGreaterThan(1e-3);
    expect(gap(refined)).toBeLessThanOrEqual(5e-4 + 1e-5);
    // The fit points themselves stay vertices.
    for (let k = 0; k < pts.length; k += 3)
      expect(refined.some((p) => Math.hypot(p.x - pts[k], p.y - pts[k + 1]) < 1e-9)).toBe(true);
  });
});
