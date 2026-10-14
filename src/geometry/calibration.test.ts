import { describe, expect, it } from 'vitest';

import { apply, similarity } from '@/core/affine';
import type { Affine2D, Pt } from '@/core/types';
import { METRES_PER_PT } from '@/core/units';

import {
  fitAffine,
  fitDistanceScale,
  fitDistanceScaleXY,
  fitScaleXYTranslation,
  fitSimilarity,
  ratioScale,
  ratioTransform,
  scaleFromTwoPoints,
  uniformScaleTransform,
  type DistanceRef,
  type PointPair,
} from './calibration';

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Deterministic pseudo-random numbers in [−1, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

describe('two-point and ratio scale (rows 28, 30)', () => {
  it('re-measuring the calibrated dimension returns the entered value', () => {
    const a = { x: 123.456, y: 789.012 };
    const b = { x: 987.654, y: 321.098 };
    const k = scaleFromTwoPoints(a, b, 37.5);
    const m = uniformScaleTransform(k);
    expect(dist(apply(m, a), apply(m, b))).toBeCloseTo(37.5, 12);
    expect(() => scaleFromTwoPoints(a, a, 10)).toThrow();
    expect(() => scaleFromTwoPoints(a, b, 0)).toThrow();
    expect(() => scaleFromTwoPoints(a, b, Infinity)).toThrow();
  });

  it('a 1:500 PDF measures correctly without picking points', () => {
    const m = ratioTransform(500, METRES_PER_PT);
    expect(m[0]).toBeCloseTo((0.0254 / 72) * 500, 15);
    // 100 m on site is 0.2 m on paper = 0.2 / (0.0254/72) pt.
    const pts = (0.2 / 0.0254) * 72;
    expect(dist(apply(m, { x: 10, y: 20 }), apply(m, { x: 10 + pts, y: 20 }))).toBeCloseTo(100, 10);
    // A1 sheet width (841 mm) at 1:500 = 420.5 m.
    expect(ratioScale(500, METRES_PER_PT) * ((0.841 / 0.0254) * 72)).toBeCloseTo(420.5, 9);
    expect(ratioTransform(1, 0.001)).toEqual([0.001, 0, 0, 0.001, 0, 0]);
    expect(() => ratioScale(0, 1)).toThrow();
  });
});

describe('multi-reference distance calibration (row 29)', () => {
  it('least-squares fits a uniform scale and reports residuals', () => {
    const k = 0.05;
    const refs: DistanceRef[] = [
      { a: { x: 0, y: 0 }, b: { x: 2000, y: 0 }, distance: 100 },
      { a: { x: 0, y: 0 }, b: { x: 0, y: 1000 }, distance: 50 },
      { a: { x: 100, y: 100 }, b: { x: 700, y: 900 }, distance: 50 },
    ];
    const fit = fitDistanceScale(refs);
    expect(fit.k).toBeCloseTo(k, 14);
    expect(fit.rms).toBeLessThan(1e-12);
    expect(fit.transform).toEqual([fit.k, 0, 0, fit.k, 0, 0]);
  });

  it('flags a deliberately bad reference as worst', () => {
    const refs: DistanceRef[] = [
      { a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, distance: 50.01 },
      { a: { x: 0, y: 0 }, b: { x: 0, y: 1500 }, distance: 74.99 },
      { a: { x: 0, y: 0 }, b: { x: 600, y: 800 }, distance: 58 }, // should be 50
      { a: { x: 50, y: 50 }, b: { x: 1250, y: 50 }, distance: 60.02 },
    ];
    const fit = fitDistanceScale(refs);
    expect(fit.worst).toBe(2);
    expect(fit.residuals).toHaveLength(4);
    expect(Math.abs(fit.residuals[2])).toBeGreaterThan(5);
    const ss = fit.residuals.reduce((s, r) => s + r * r, 0);
    expect(fit.rms).toBeCloseTo(Math.sqrt(ss / 4), 12);
    expect(() => fitDistanceScale([])).toThrow();
    expect(() => fitDistanceScale([{ a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, distance: -1 }])).toThrow();
    expect(() => fitDistanceScale([{ a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, distance: 1 }])).toThrow();
  });

  it('fits separate X/Y scales for distorted scans (Gauss–Newton)', () => {
    const kx = 0.0502;
    const ky = 0.0497;
    const real = (a: Pt, b: Pt): number => Math.hypot(kx * (b.x - a.x), ky * (b.y - a.y));
    const pairs: [Pt, Pt][] = [
      [
        { x: 0, y: 0 },
        { x: 2000, y: 0 },
      ],
      [
        { x: 0, y: 0 },
        { x: 0, y: 1800 },
      ],
      [
        { x: 100, y: 0 },
        { x: 900, y: 1300 },
      ],
      [
        { x: 2000, y: 0 },
        { x: 500, y: 1500 },
      ],
    ];
    const refs = pairs.map(([a, b]) => ({ a, b, distance: real(a, b) }));
    const fit = fitDistanceScaleXY(refs);
    expect(fit.kx).toBeCloseTo(kx, 12);
    expect(fit.ky).toBeCloseTo(ky, 12);
    expect(fit.k).toBeCloseTo(Math.sqrt(kx * ky), 12);
    expect(fit.rms).toBeLessThan(1e-9);
    expect(fit.transform).toEqual([fit.kx, 0, 0, fit.ky, 0, 0]);
    // With noise and one bad reference, the bad one is still flagged.
    const noisy = refs.map((r, i) => ({ ...r, distance: r.distance + (i === 3 ? 2 : 0.002 * (i - 1)) }));
    const nf = fitDistanceScaleXY([
      ...noisy,
      { a: { x: 0, y: 0 }, b: { x: 1000, y: 1000 }, distance: real({ x: 0, y: 0 }, { x: 1000, y: 1000 }) },
    ]);
    expect(nf.worst).toBe(3);
    // Inconsistent references (the diagonal is shorter than the horizontal) and a zero-length reference
    // still give finite, non-negative scales; the zero-length one is the worst.
    const odd = fitDistanceScaleXY([
      { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, distance: 1 },
      { a: { x: 0, y: 0 }, b: { x: 10, y: 10 }, distance: 0.9 },
      { a: { x: 0, y: 0 }, b: { x: 20, y: 0 }, distance: 2 },
      { a: { x: 5, y: 5 }, b: { x: 5, y: 5 }, distance: 3 },
    ]);
    expect(Number.isFinite(odd.kx) && odd.kx >= 0 && Number.isFinite(odd.ky) && odd.ky >= 0).toBe(true);
    expect(odd.worst).toBe(3);
    expect(() =>
      fitDistanceScaleXY([
        { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, distance: 1 },
        { a: { x: 0, y: 5 }, b: { x: 30, y: 5 }, distance: 3 },
      ]),
    ).toThrow();
  });
});

describe('point-pair calibration (row 31)', () => {
  // Drawing in mm, world in UTM metres, rotated by 12.5° (plant north vs grid).
  const truth = similarity(0.001, (12.5 * Math.PI) / 180, 604_321.123, 2_503_456.789);
  const drawing: Pt[] = [
    { x: 0, y: 0 },
    { x: 841_000, y: 0 },
    { x: 841_000, y: 594_000 },
    { x: 0, y: 594_000 },
    { x: 420_500, y: 297_000 },
  ];
  const pairsFor = (m: Affine2D, pts: Pt[]): PointPair[] =>
    pts.map((d) => ({ drawing: d, world: apply(m, d) }));

  it('fits a similarity exactly and stably at UTM coordinates', () => {
    const fit = fitSimilarity(pairsFor(truth, drawing));
    expect(fit.scale).toBeCloseTo(0.001, 15);
    expect(fit.rotation).toBeCloseTo((12.5 * Math.PI) / 180, 12);
    expect(fit.rms).toBeLessThan(1e-8);
    // A grid intersection maps to its labelled coordinate within NFR-7 (here ~1e-9 m).
    const p = apply(fit.transform, { x: 123_456, y: 234_567 });
    const q = apply(truth, { x: 123_456, y: 234_567 });
    expect(dist(p, q)).toBeLessThan(1e-6);
    // Two pairs are enough.
    expect(fitSimilarity(pairsFor(truth, drawing.slice(0, 2))).rms).toBeLessThan(1e-8);
    expect(() => fitSimilarity(pairsFor(truth, drawing.slice(0, 1)))).toThrow();
    expect(() =>
      fitSimilarity([
        { drawing: { x: 1, y: 1 }, world: { x: 0, y: 0 } },
        { drawing: { x: 1, y: 1 }, world: { x: 5, y: 0 } },
      ]),
    ).toThrow();
  });

  it('reports residuals and the worst point', () => {
    const pairs = pairsFor(truth, drawing);
    pairs[2] = { ...pairs[2], world: { x: pairs[2].world.x + 0.8, y: pairs[2].world.y - 0.3 } };
    const fit = fitSimilarity(pairs);
    expect(fit.worst).toBe(2);
    expect(fit.residuals[2]).toBeGreaterThan(0.3);
    expect(fit.rms).toBeGreaterThan(0);
  });

  it('optionally detects mirrored drawings (downward y axis)', () => {
    const flip: Affine2D = [0.002, 0, 0, -0.002, 500, 800];
    const pairs = pairsFor(flip, drawing.slice(0, 4));
    expect(fitSimilarity(pairs).rms).toBeGreaterThan(1);
    const fit = fitSimilarity(pairs, { allowReflection: true });
    expect(fit.rms).toBeLessThan(1e-9);
    expect(fit.transform[3]).toBeCloseTo(-0.002, 15);
    // A proper similarity is kept when it fits better.
    expect(fitSimilarity(pairsFor(truth, drawing), { allowReflection: true }).transform[3]).toBeGreaterThan(
      0,
    );
  });

  it('fits general affine transforms for distorted scans', () => {
    const m: Affine2D = [0.0021, 0.0001, -0.00015, 0.0019, 604_000, 2_503_000];
    const fit = fitAffine(pairsFor(m, drawing));
    fit.transform.forEach((v, i) => expect(v).toBeCloseTo(m[i], i < 4 ? 15 : 6));
    expect(fit.rms).toBeLessThan(1e-8);
    expect(fit.scale).toBeCloseTo(Math.sqrt(0.0021 * 0.0019 + 0.0001 * 0.00015), 15);
    expect(() => fitAffine(pairsFor(m, drawing.slice(0, 2)))).toThrow();
    expect(() =>
      fitAffine(
        pairsFor(m, [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ]),
      ),
    ).toThrow(/collinear/);
  });

  it('fits separate X/Y scales with rotation and translation (closed form)', () => {
    const rnd = rng(42);
    for (let trial = 0; trial < 20; trial++) {
      const kx = 0.001 * (1 + 0.05 * rnd());
      const ky = 0.001 * (1 + 0.05 * rnd()) * (trial % 5 === 0 ? -1 : 1);
      const th = Math.PI * rnd();
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const m: Affine2D = [
        cs * kx,
        sn * kx,
        -sn * ky,
        cs * ky,
        600_000 + 1000 * rnd(),
        2_500_000 + 1000 * rnd(),
      ];
      const fit = fitScaleXYTranslation(pairsFor(m, drawing));
      expect(fit.kx).toBeCloseTo(kx, 12);
      expect(fit.ky).toBeCloseTo(ky, 12);
      expect(Math.cos(fit.rotation - th)).toBeCloseTo(1, 12);
      expect(fit.rms).toBeLessThan(1e-7);
      expect(fit.scale).toBeCloseTo(Math.sqrt(Math.abs(kx * ky)), 12);
    }
    // Least squares with noise: the outlier is worst.
    const m: Affine2D = [0.001, 0, 0, 0.0011, 600_000, 2_500_000];
    const pairs = pairsFor(m, drawing);
    pairs[1] = { ...pairs[1], world: { x: pairs[1].world.x + 0.5, y: pairs[1].world.y } };
    expect(fitScaleXYTranslation(pairs).worst).toBe(1);
    expect(() => fitScaleXYTranslation(pairs.slice(0, 2))).toThrow();
  });
});
