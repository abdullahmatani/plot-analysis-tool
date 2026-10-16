import { describe, expect, it } from 'vitest';

import type { Affine2D, Pt } from '@/core/types';
import type { ViewTransform } from '@/store/view';

import {
  MAX_SCALE,
  MIN_SCALE,
  batchClipTransform,
  clampScale,
  fitBounds,
  panBy,
  screenToWorld,
  visibleWorldBounds,
  worldToScreen,
  worldToScreenMatrix,
  zoomAt,
} from './view';

/** Viewer navigation maths (row 17) at plant/UTM-sized coordinates (row 18). */

const W = 1280;
const H = 720;
const ROTATIONS = [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI / 6, -2.5];
const P: Pt = { x: 612_345.678, y: 2_534_210.004 };
const view = (rotation: number, scale = 2.5): ViewTransform => ({
  cx: 612_300.25,
  cy: 2_534_190.5,
  scale,
  rotation,
});
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

describe('world ↔ screen', () => {
  it.each(ROTATIONS)('round-trips at rotation %f within a micrometre', (r) => {
    const v = view(r);
    expect(dist(screenToWorld(v, W, H, worldToScreen(v, W, H, P)), P)).toBeLessThan(1e-6);
  });

  it('puts the view centre at the canvas centre', () => {
    const v = view(0.7);
    const s = worldToScreen(v, W, H, { x: v.cx, y: v.cy });
    expect(s.x).toBeCloseTo(W / 2, 9);
    expect(s.y).toBeCloseTo(H / 2, 9);
  });

  it('rotates the drawing anticlockwise on screen (world +X points up at +90°)', () => {
    const v = view(Math.PI / 2, 1);
    const a = worldToScreen(v, W, H, { x: v.cx, y: v.cy });
    const b = worldToScreen(v, W, H, { x: v.cx + 10, y: v.cy });
    expect(b.x - a.x).toBeCloseTo(0, 9);
    expect(b.y - a.y).toBeCloseTo(-10, 9);
  });

  it.each(ROTATIONS)('the Canvas 2D matrix agrees with worldToScreen at rotation %f', (r) => {
    const v = view(r);
    const [a, b, c, d, e, f] = worldToScreenMatrix(v, W, H);
    const s = worldToScreen(v, W, H, P);
    expect(a * P.x + c * P.y + e).toBeCloseTo(s.x, 4);
    expect(b * P.x + d * P.y + f).toBeCloseTo(s.y, 4);
  });
});

describe('zoom and pan', () => {
  it.each(ROTATIONS)('wheel zoom keeps the world point under the cursor fixed (rotation %f)', (r) => {
    const v = view(r);
    const cursor = { x: 911.5, y: 203.25 };
    const before = screenToWorld(v, W, H, cursor);
    for (const factor of [1.5, 1 / 3, 40]) {
      const z = zoomAt(v, W, H, cursor, factor);
      expect(z.scale).toBeCloseTo(v.scale * factor, 9);
      expect(z.rotation).toBe(r);
      expect(dist(screenToWorld(z, W, H, cursor), before)).toBeLessThan(1e-6);
    }
  });

  it('clamps zoom to the scale limits', () => {
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(1e12)).toBe(MAX_SCALE);
    const v = zoomAt(view(0), W, H, { x: 100, y: 100 }, 1e12);
    expect(v.scale).toBe(MAX_SCALE);
  });

  it.each(ROTATIONS)('panning moves the drawing exactly with the pointer (rotation %f)', (r) => {
    const v = view(r);
    const s0 = worldToScreen(v, W, H, P);
    const moved = panBy(v, 37, -12.5);
    const s1 = worldToScreen(moved, W, H, P);
    expect(s1.x - s0.x).toBeCloseTo(37, 6);
    expect(s1.y - s0.y).toBeCloseTo(-12.5, 6);
    expect(moved.scale).toBe(v.scale);
    expect(moved.rotation).toBe(r);
  });
});

describe('fit (zoom extents, zoom window, zoom to selection)', () => {
  const b = { minX: 612_000, minY: 2_534_000, maxX: 612_900, maxY: 2_534_300 };
  const corners = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];

  it.each(ROTATIONS)('fits the bounds inside the margins and fills one direction (rotation %f)', (r) => {
    const margin = 24;
    const v = fitBounds(b, W, H, r, margin);
    expect(v.rotation).toBe(r);
    const s = corners.map((p) => worldToScreen(v, W, H, p));
    const xs = s.map((p) => p.x);
    const ys = s.map((p) => p.y);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(margin - 1e-6);
    for (const x of xs) expect(x).toBeLessThanOrEqual(W - margin + 1e-6);
    for (const y of ys) expect(y).toBeGreaterThanOrEqual(margin - 1e-6);
    for (const y of ys) expect(y).toBeLessThanOrEqual(H - margin + 1e-6);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    expect(Math.max(spanX / (W - 2 * margin), spanY / (H - 2 * margin))).toBeCloseTo(1, 6);
  });

  it('keeps a usable view for degenerate bounds', () => {
    const v = fitBounds({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, W, H);
    expect(Number.isFinite(v.scale) && v.scale > 0).toBe(true);
    expect(v.cx).toBe(5);
  });

  it.each(ROTATIONS)('the visible bounds contain the whole canvas (rotation %f)', (r) => {
    const v = view(r);
    const vis = visibleWorldBounds(v, W, H);
    for (const s of [
      { x: 0, y: 0 },
      { x: W, y: H },
      { x: W, y: 0 },
      { x: 0, y: H },
    ]) {
      const p = screenToWorld(v, W, H, s);
      expect(p.x).toBeGreaterThanOrEqual(vis.minX - 1e-6);
      expect(p.x).toBeLessThanOrEqual(vis.maxX + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(vis.minY - 1e-6);
      expect(p.y).toBeLessThanOrEqual(vis.maxY + 1e-6);
    }
  });
});

describe('GPU transform at plant coordinates (row 18)', () => {
  const f = Math.fround;
  /** What the vertex shader computes in float32: clip = M·local + t, with local stored as float32. */
  function gpuScreen(v: ViewTransform, A: Affine2D, origin: Pt, p: Pt): Pt {
    const { m, t } = batchClipTransform(v, W, H, A, origin.x, origin.y);
    const lx = f(p.x - origin.x);
    const ly = f(p.y - origin.y);
    const cx = f(f(f(m[0] * lx) + f(m[2] * ly)) + t[0]);
    const cy = f(f(f(m[1] * lx) + f(m[3] * ly)) + t[1]);
    return { x: ((cx + 1) / 2) * W, y: ((1 - cy) / 2) * H };
  }

  /**
   * Largest on-screen error of a vertex while the view pans in sub-pixel steps around it. A 2 km plot
   * plan in UTM metres is batched on a 16 × 16 grid (render-data.ts), so a vertex lies at most about
   * 62.5 m from its batch origin, at the cell centre.
   */
  function maxError(r: number, scale: number, A: Affine2D = [1, 0, 0, 1, 0, 0]): number {
    const origin = { x: 612_062.5, y: 2_534_062.5 };
    const p = { x: origin.x + 50, y: origin.y + 37.5 };
    const world = { x: A[0] * p.x + A[2] * p.y + A[4], y: A[1] * p.x + A[3] * p.y + A[5] };
    let worst = 0;
    for (let k = 0; k < 100; k++) {
      const v: ViewTransform = {
        cx: world.x + (k * 0.37) / scale,
        cy: world.y - (k * 0.23) / scale,
        scale,
        rotation: r,
      };
      worst = Math.max(worst, dist(gpuScreen(v, A, origin, p), worldToScreen(v, W, H, world)));
    }
    return worst;
  }

  it.each(ROTATIONS)('stays within a tenth of a pixel at 0.1 mm per pixel (rotation %f)', (r) => {
    expect(maxError(r, 10_000)).toBeLessThan(0.1);
  });

  it.each(ROTATIONS)('stays within one pixel at the maximum zoom, 0.005 mm per pixel (rotation %f)', (r) => {
    expect(maxError(r, MAX_SCALE)).toBeLessThan(1);
  });

  it('applies the drawing placement in float64 (a millimetre drawing placed in metres)', () => {
    const A: Affine2D = [0.001, 0, 0, 0.001, 0, 0];
    // The same 2 km plan drawn in millimetres: origin and offsets scale by 1 000, the error does not.
    const origin = { x: 612_062_500, y: 2_534_062_500 };
    const p = { x: origin.x + 50_000, y: origin.y + 37_500 };
    const world = { x: 0.001 * p.x, y: 0.001 * p.y };
    const v: ViewTransform = { cx: world.x, cy: world.y, scale: 10_000, rotation: 0.4 };
    expect(dist(gpuScreen(v, A, origin, p), worldToScreen(v, W, H, world))).toBeLessThan(0.05);
  });
});
