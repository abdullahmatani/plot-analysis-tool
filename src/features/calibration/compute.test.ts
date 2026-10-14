import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { apply, multiply, scale as scaleM } from '@/core/affine';
import type { Drawing, Pt } from '@/core/types';
import { METRES_PER_PT } from '@/core/units';
import { parseDxf } from '@/import/dxf';
import { GK } from '@/underlay/entity-store';
import { placementOf } from '@/underlay/models';

import {
  cadUnitsCalibration,
  composeAlignment,
  describeSimilarity,
  distanceCalibration,
  equivalentRatio,
  metresPerUnit,
  minPoints,
  paperName,
  pointCalibration,
  ratioCalibration,
  sharedCoordinates,
  sheetFactor,
  twoPointAlignment,
  twoPointCalibration,
} from './compute';

const AT = '2026-10-14T00:00:00.000Z';
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const MM = 72 / 25.4;
const A1 = { w: 841 * MM, h: 594 * MM };

function drawing(over: Partial<Drawing> = {}): Drawing {
  return {
    id: 'd1',
    name: 'Plan',
    source: { kind: 'dxf', fileName: 'plan.dxf', sha256: 'x', blobKey: 'x', size: 1 },
    nativeUnits: 'm',
    opacity: 1,
    ghost: false,
    visible: true,
    hiddenSourceLayers: [],
    order: 0,
    ...over,
  };
}

describe('two-point scale (row 28)', () => {
  it('re-measuring the calibrated dimension returns the entered value exactly', () => {
    // The 100 m reference dimension of the 1:500 PDF fixture, in points.
    const a = { x: 300 * MM, y: 110 * MM };
    const b = { x: 500 * MM, y: 110 * MM };
    const c = twoPointCalibration(a, b, 100, AT);
    expect(c.method).toBe('two-point');
    expect(dist(apply(c.transform, a), apply(c.transform, b))).toBeCloseTo(100, 12);
    expect(equivalentRatio(metresPerUnit(c.transform))).toBeCloseTo(500, 9);
    expect(c.references).toHaveLength(2);
    expect(c.references[0]).toMatchObject({ drawing: a, distance: 100, pair: 1 });
  });

  it('rejects coincident points and non-positive lengths', () => {
    expect(() => twoPointCalibration({ x: 1, y: 1 }, { x: 1, y: 1 }, 5, AT)).toThrow();
    expect(() => twoPointCalibration({ x: 0, y: 0 }, { x: 1, y: 1 }, 0, AT)).toThrow();
  });
});

describe('multi-reference calibration (row 29)', () => {
  const k = (0.0254 / 72) * 500;
  const ref = (a: Pt, b: Pt, extra = 0) => ({ a, b, distance: dist(a, b) * k + extra });

  it('least-squares scale with residuals, RMS and the worst reference', () => {
    const refs = [
      ref({ x: 0, y: 0 }, { x: 1000, y: 0 }),
      ref({ x: 0, y: 0 }, { x: 0, y: 700 }),
      ref({ x: 100, y: 100 }, { x: 900, y: 650 }),
      ref({ x: 50, y: 400 }, { x: 650, y: 400 }, 5), // deliberately 5 m off
    ];
    const { calibration, fit } = distanceCalibration(refs, false, AT);
    expect(calibration.method).toBe('multi-point');
    expect(fit.worst).toBe(3);
    expect(fit.residuals).toHaveLength(4);
    expect(fit.rms).toBeGreaterThan(0.5);
    expect(calibration.residualRms).toBe(fit.rms);
    // Residuals are stored on both ends of each distance reference.
    expect(calibration.references).toHaveLength(8);
    expect(calibration.references[6].residual).toBe(fit.residuals[3]);
    const exact = distanceCalibration(refs.slice(0, 3), false, AT);
    expect(exact.fit.rms).toBeLessThan(1e-12);
    expect(exact.fit.scale).toBeCloseTo(k, 14);
  });

  it('separate X/Y scales for distorted scans', () => {
    const kx = 0.2;
    const ky = 0.19;
    const r = (a: Pt, b: Pt) => ({ a, b, distance: Math.hypot((b.x - a.x) * kx, (b.y - a.y) * ky) });
    const refs = [
      r({ x: 0, y: 0 }, { x: 1000, y: 0 }),
      r({ x: 0, y: 0 }, { x: 0, y: 800 }),
      r({ x: 0, y: 0 }, { x: 600, y: 500 }),
    ];
    const { calibration, fit } = distanceCalibration(refs, true, AT);
    expect(calibration.separateXY).toBe(true);
    expect(fit.kx).toBeCloseTo(kx, 10);
    expect(fit.ky).toBeCloseTo(ky, 10);
    expect(fit.rms).toBeLessThan(1e-9);
  });
});

describe('plant coordinates (row 31)', () => {
  // Local mm drawing rotated 15° against plant north, origin at E 600 160 / N 2 500 100.
  const theta = (15 * Math.PI) / 180;
  const truth = multiply(
    [1, 0, 0, 1, 600160, 2500100],
    multiply([Math.cos(theta), Math.sin(theta), -Math.sin(theta), Math.cos(theta), 0, 0], scaleM(0.001)),
  );
  const local = [
    { x: -9659.258, y: 2588.19 },
    { x: 128000.5, y: 61000.25 },
    { x: 40000, y: 90000 },
    { x: 100000, y: -5000 },
  ];

  it('two points define translation, rotation and scale; world = plant E/N', () => {
    const refs = local.slice(0, 2).map((p) => ({ drawing: p, world: apply(truth, p) }));
    const { calibration, fit } = pointCalibration(refs, 'similarity', 'coordinates', AT);
    expect(calibration.method).toBe('coordinates');
    expect(fit.rotation).toBeCloseTo(theta, 12);
    expect(fit.scale).toBeCloseTo(0.001, 15);
    for (const p of local) {
      const w = apply(calibration.transform, p);
      const t = apply(truth, p);
      expect(dist(w, t)).toBeLessThan(1e-6);
    }
  });

  it('three or more points report residuals and the worst point', () => {
    const refs = local.map((p) => ({ drawing: p, world: apply(truth, p) }));
    refs[2] = { ...refs[2], world: { x: refs[2].world.x + 0.3, y: refs[2].world.y } };
    const { calibration, fit } = pointCalibration(refs, 'similarity', 'coordinates', AT);
    expect(fit.worst).toBe(2);
    expect(fit.rms).toBeGreaterThan(0.05);
    expect(calibration.references.map((r) => r.residual)).toEqual(fit.residuals);
    expect(minPoints('affine')).toBe(3);
    const aff = pointCalibration(refs, 'affine', 'coordinates', AT);
    expect(aff.calibration.separateXY).toBe(true);
    expect(aff.fit.rms).toBeLessThan(fit.rms + 1e-12);
  });
});

describe('ratio and units (row 30)', () => {
  it('a 1:500 A1 PDF measures correctly without picking points', () => {
    expect(paperName(A1.w, A1.h)).toBe('A1');
    expect(paperName(A1.h, A1.w)).toBe('A1');
    const c = ratioCalibration(500, METRES_PER_PT, AT);
    expect(c.ratio).toBe(500);
    // Sheet width 841 mm at 1:500 = 420.5 m; the 100 m dimension (200 mm on paper) measures 100 m.
    expect(apply(c.transform, { x: A1.w, y: 0 }).x).toBeCloseTo(420.5, 9);
    expect(
      dist(
        apply(c.transform, { x: 300 * MM, y: 110 * MM }),
        apply(c.transform, { x: 500 * MM, y: 110 * MM }),
      ),
    ).toBeCloseTo(100, 9);
    // Tank T-101 (r = 15 m) is a 30 mm radius circle on paper.
    expect(apply(c.transform, { x: 30 * MM, y: 0 }).x).toBeCloseTo(15, 9);
  });

  it('a stated scale for another sheet size uses the true paper size', () => {
    // An A1 drawing plotted onto an A3 page: everything is half size.
    const A3 = { w: 420 * MM, h: 297 * MM };
    expect(sheetFactor(A3.w, A3.h, 'A1')).toBeCloseTo(841 / 420, 12);
    expect(sheetFactor(A3.w, A3.h, null)).toBe(1);
  });

  it('CAD unit factor', () => {
    const c = cadUnitsCalibration(0.001, AT);
    expect(c.method).toBe('cad-units');
    expect(c.transform).toEqual([0.001, 0, 0, 0.001, 0, 0]);
    expect(() => cadUnitsCalibration(0, AT)).toThrow();
  });
});

describe('sub-drawing alignment (row 34)', () => {
  it('two-point alignment maps both pairs exactly (move, rotate, scale)', () => {
    const src: [Pt, Pt] = [
      { x: 10, y: 5 },
      { x: 60, y: 20 },
    ];
    const s = [0.5, 0.3, -0.3, 0.5, 600000, 2500000] as const;
    const dst: [Pt, Pt] = [apply([...s], src[0]), apply([...s], src[1])];
    const m = twoPointAlignment(src, dst, false);
    expect(dist(apply(m, src[0]), dst[0])).toBeLessThan(1e-9);
    expect(dist(apply(m, src[1]), dst[1])).toBeLessThan(1e-9);
    expect(describeSimilarity(m).scale).toBeCloseTo(Math.hypot(0.5, 0.3), 12);
  });

  it('keep scale: rigid transform with coinciding midpoints', () => {
    const src: [Pt, Pt] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const dst: [Pt, Pt] = [
      { x: 100, y: 100 },
      { x: 100, y: 110.02 },
    ];
    const m = twoPointAlignment(src, dst, true);
    expect(describeSimilarity(m).scale).toBeCloseTo(1, 14);
    expect(describeSimilarity(m).rotation).toBeCloseTo(Math.PI / 2, 12);
    const mid = apply(m, { x: 5, y: 0 });
    expect(mid.x).toBeCloseTo(100, 12);
    expect(mid.y).toBeCloseTo(105.01, 12);
    expect(composeAlignment(m, undefined)).toBe(m);
  });

  it('shared coordinates give the sub-drawing the placement of the base', () => {
    const calibrated = drawing({ calibration: ratioCalibration(2, 0.5, AT), alignment: [1, 0, 0, 1, 5, 5] });
    const patch = sharedCoordinates(calibrated, 6, AT);
    const sub = drawing({ id: 'd2', nativeUnits: 'mm', ...patch });
    expect(placementOf(sub)).toEqual(placementOf(calibrated));
    const base = drawing({ nativeUnits: 'm' });
    const p2 = sharedCoordinates(base, 6, AT);
    expect(p2).toMatchObject({ calibration: undefined, unitsOverride: 'm' });
    expect(placementOf(drawing({ nativeUnits: 'mm', ...p2 }))).toEqual(placementOf(base, 6));
  });

  it('aligns the generated local-mm area layout onto the plot plan within NFR-7', () => {
    const dir = fileURLToPath(new URL('../../../tests/fixtures/dxf/', import.meta.url));
    const exp = JSON.parse(readFileSync(dir + 'subdrawings.json', 'utf8')) as {
      tanks: { plant: [number, number]; r: number }[];
      bundEnds: { plant: [number, number]; local: [number, number] }[];
    };
    const r = parseDxf(new Uint8Array(readFileSync(dir + 'area_layout_local_mm.dxf')));
    expect(r.insunits).toBe(4);
    const s = r.store;
    const circles: { c: Pt; r: number }[] = [];
    for (let i = 0; i < s.count; i++) {
      if (s.geomKind[i] !== GK.CIRCLE) continue;
      const o = s.geomStart[i];
      circles.push({ c: { x: s.geom[o], y: s.geom[o + 1] }, r: s.geom[o + 2] });
    }
    // Tank shells (r = 15 m and 20 m) at the default mm placement.
    const place = placementOf(drawing({ nativeUnits: 'mm' }), 4);
    const shell = (rm: number) => circles.find((c) => Math.abs(c.r - rm * 1000) < 1e-6)!;
    const src = [apply(place, shell(15).c), apply(place, shell(20).c)] as [Pt, Pt];
    const dst = exp.tanks.map((t) => ({ x: t.plant[0], y: t.plant[1] })) as [Pt, Pt];
    const m = twoPointAlignment(src, dst, false);
    const full = multiply(m, place);
    for (const e of exp.bundEnds) {
      const w = apply(full, { x: e.local[0], y: e.local[1] });
      expect(dist(w, { x: e.plant[0], y: e.plant[1] })).toBeLessThan(1e-6);
    }
    // Radii scale exactly too: the 15 m shell measures 15 m after alignment.
    expect(shell(15).r * metresPerUnit(full)).toBeCloseTo(15, 9);
  });
});
