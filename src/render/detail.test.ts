import { describe, expect, it } from 'vitest';

import type { Affine2D, Bounds, Pt } from '@/core/types';
import type { ViewTransform } from '@/store/view';
import { ET, EntityStoreBuilder, FLAG, GK, storeExtents, type EntityStore } from '@/underlay/entity-store';
import {
  SEG_STRIDE,
  TRI_STRIDE,
  buildDetailData,
  buildRenderData,
  clipPolygon,
  clipSegment,
  precisionRadius,
  type SegmentBatch,
} from '@/underlay/render-data';

import {
  DETAIL_THRESHOLD_PX,
  batchErrorPx,
  placementStretch,
  viewInDrawing,
  windowAround,
  windowServes,
} from './detail';
import { MAX_SCALE, batchClipTransform, worldToScreen } from './view';

/**
 * Precise underlay rendering at any zoom (row 18): on a 10 km site, or along a long line, the full
 * batches' float32 offsets put lines visibly off at high zoom; the detail batches do not.
 */

const W = 1280;
const H = 720;
const I: Affine2D = [1, 0, 0, 1, 0, 0];
const f = Math.fround;

/** Screen position (CSS px) of a vertex as the segment vertex shader computes it in float32. */
function shaderScreen(v: ViewTransform, A: Affine2D, b: SegmentBatch, lx: number, ly: number): Pt {
  const { m, t } = batchClipTransform(v, W, H, A, b.ox, b.oy);
  const cx = f(f(f(m[0] * lx) + f(m[2] * ly)) + t[0]);
  const cy = f(f(f(m[1] * lx) + f(m[3] * ly)) + t[1]);
  return { x: (f(f(cx * W) * 0.5) + W / 2) as number, y: H / 2 - f(f(cy * H) * 0.5) };
}

/** Segments of the batches as drawn: screen endpoints from the shader emulation. */
function drawnSegments(v: ViewTransform, A: Affine2D, batches: SegmentBatch[]): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (const b of batches) {
    const f32 = new Float32Array(b.data);
    for (let k = 0; k < b.count; k++) {
      const o = (k * SEG_STRIDE) / 4;
      out.push([shaderScreen(v, A, b, f32[o], f32[o + 1]), shaderScreen(v, A, b, f32[o + 2], f32[o + 3])]);
    }
  }
  return out;
}

/** Distance (px) from screen point `p` to the nearest drawn line (as infinite lines through segments). */
function offsetFromLines(segs: [Pt, Pt][], p: Pt): number {
  let best = Infinity;
  for (const [a, b] of segs) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    // Only segments that pass the point (within the segment's span).
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (len * len);
    if (t < 0 || t > 1) continue;
    best = Math.min(best, Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / len);
  }
  return best;
}

const meta = { type: ET.LINE, layer: 0, color: 0xffffff };
function line(b: EntityStoreBuilder, x0: number, y0: number, x1: number, y1: number, flags = 0) {
  b.add({ ...meta, flags }, GK.LINE, [x0, y0, x1, y1], {
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1),
    maxY: Math.max(y0, y1),
  });
}

/** A site of `size` metres at UTM-sized coordinates: a grid of short lines plus one diagonal across it. */
function site(size: number): { store: EntityStore; extents: Bounds; diagonal: [Pt, Pt] } {
  const b = new EntityStoreBuilder();
  const x0 = 600_000;
  const y0 = 2_500_000;
  for (let i = 0; i <= 20; i++)
    for (let j = 0; j <= 20; j++) {
      const x = x0 + (i * size) / 20;
      const y = y0 + (j * size) / 20;
      line(b, x, y, x + 5, y + 3);
    }
  const diagonal: [Pt, Pt] = [
    { x: x0 + 0.123, y: y0 + 0.456 },
    { x: x0 + size - 0.789, y: y0 + size * 0.97 + 0.321 },
  ];
  line(b, diagonal[0].x, diagonal[0].y, diagonal[1].x, diagonal[1].y);
  const store = b.finish();
  return { store, extents: storeExtents(store), diagonal };
}

/** A point on the diagonal near its far end, and a view at the maximum zoom centred on it. */
function viewOnDiagonal(d: [Pt, Pt], t: number, rotation: number): { p: Pt; v: ViewTransform } {
  const p = { x: d[0].x + (d[1].x - d[0].x) * t, y: d[0].y + (d[1].y - d[0].y) * t };
  return { p, v: { cx: p.x, cy: p.y, scale: MAX_SCALE, rotation } };
}

describe('precise underlay rendering at high zoom (row 18)', () => {
  it.each([
    [10_000, 0],
    [10_000, 0.7],
    [2_000, -2.1],
  ])(
    'a %i m site: the full batches put a long line off at the maximum zoom; the detail batch does not (rotation %f)',
    (size, rotation) => {
      const { store, extents, diagonal } = site(size);
      const full = buildRenderData(store, extents);
      for (const t of [0.03, 0.5, 0.96]) {
        const { p, v } = viewOnDiagonal(diagonal, t, rotation);
        const centre = worldToScreen(v, W, H, p);
        // Full batches: the line misses the point it passes through by several pixels.
        const fullErr = offsetFromLines(drawnSegments(v, I, full.segments), centre);
        if (t !== 0.5) expect(fullErr).toBeGreaterThan(size >= 10_000 ? 5 : 1);
        // Detail batch around the view: exact to a small fraction of a pixel.
        const rect = windowAround(viewInDrawing(v, W, H, I));
        const ids = Array.from({ length: store.count }, (_, i) => i);
        const detail = buildDetailData(store, extents, ids, rect);
        expect(detail.segmentCount).toBeGreaterThan(0);
        expect(offsetFromLines(drawnSegments(v, I, detail.segments), centre)).toBeLessThan(0.01);
      }
    },
  );

  it('switches to detail batches before the full batches err by a quarter pixel, and not before it is needed', () => {
    const { store, extents, diagonal } = site(10_000);
    const full = buildRenderData(store, extents);
    const radius = precisionRadius(full);
    // The diagonal is batched with the cell at its middle, so its ends lie about 7 km from the origin.
    expect(radius).toBeGreaterThan(6_500);
    // Emulated error at several zooms never exceeds the bound the renderer switches on.
    for (const scale of [10, 100, 1_000, 10_000, MAX_SCALE]) {
      let worst = 0;
      for (const t of [0.02, 0.2, 0.8, 0.98]) {
        const { p, v } = viewOnDiagonal(diagonal, t, 0.3);
        const view = { ...v, scale };
        worst = Math.max(
          worst,
          offsetFromLines(drawnSegments(view, I, full.segments), worldToScreen(view, W, H, p)),
        );
      }
      expect(worst).toBeLessThanOrEqual(batchErrorPx(radius, scale));
      if (batchErrorPx(radius, scale) <= DETAIL_THRESHOLD_PX) expect(worst).toBeLessThan(DETAIL_THRESHOLD_PX);
    }
    // Viewing the whole site needs no detail batches; 1 mm per pixel does.
    expect(batchErrorPx(radius, 0.1)).toBeLessThan(DETAIL_THRESHOLD_PX);
    expect(batchErrorPx(radius, 1_000)).toBeGreaterThan(DETAIL_THRESHOLD_PX);
  });

  it('a millimetre drawing placed in metres switches at the same on-screen zoom', () => {
    const A: Affine2D = [0.001, 0, 0, 0.001, 0, 0];
    expect(placementStretch(A)).toBeCloseTo(0.001, 15);
    expect(placementStretch([0, 2, -2, 0, 5, 5])).toBeCloseTo(2, 12);
    expect(placementStretch([1, 0, 0, 3, 0, 0])).toBeCloseTo(3, 12); // affine: the larger stretch
    // The same radius in millimetres at the same metres-per-pixel gives the same error.
    expect(batchErrorPx(7_000_000, 1_000 * placementStretch(A))).toBeCloseTo(batchErrorPx(7_000, 1_000), 9);
  });
});

describe('detail batches (row 18)', () => {
  const rect: Bounds = { minX: 10, minY: 20, maxX: 30, maxY: 30 };

  it('clips segments to the window (Liang–Barsky)', () => {
    expect(clipSegment(0, 25, 40, 25, rect)).toEqual([0.25, 0.75]);
    expect(clipSegment(15, 22, 25, 28, rect)).toEqual([0, 1]);
    expect(clipSegment(0, 0, 5, 50, rect)).toBeNull();
    expect(clipSegment(0, 35, 40, 35, rect)).toBeNull();
    const [t0, t1] = clipSegment(0, 10, 40, 40, rect)!;
    expect(0 + 40 * t0).toBeCloseTo(13.333333333, 6); // enters through y = 20
    expect(10 + 30 * t1).toBeCloseTo(30, 9); // leaves through y = 30
  });

  it('clips polygons to the window (Sutherland–Hodgman)', () => {
    const area = (p: number[]) => {
      let a = 0;
      for (let i = 0; i < p.length / 2; i++) {
        const j = (i + 1) % (p.length / 2);
        a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
      }
      return Math.abs(a / 2);
    };
    expect(area(clipPolygon([0, 0, 100, 0, 0, 100], rect))).toBeCloseTo(200, 9); // the whole window
    expect(clipPolygon([0, 0, 5, 0, 0, 5], rect)).toEqual([]);
    expect(area(clipPolygon([20, 25, 40, 25, 20, 45], rect))).toBeCloseTo(50, 9);
  });

  it('cuts lines and fills to the window, relative to its centre, keeping linetype phase', () => {
    const b = new EntityStoreBuilder();
    const X = 600_000;
    const Y = 2_500_000;
    // A dashed polyline crossing the window, a hidden line, a large solid fill and a point.
    b.add(
      { ...meta, type: ET.LWPOLYLINE, linetype: 1 },
      GK.POLY,
      [3, X - 100, Y + 25, 0, X + 20, Y + 25, 0, X + 20, Y + 100, 0],
      {
        minX: X - 100,
        minY: Y + 25,
        maxX: X + 20,
        maxY: Y + 100,
      },
    );
    line(b, X, Y + 22, X + 40, Y + 22, FLAG.HIDDEN);
    b.add(
      { ...meta, type: ET.SOLID },
      GK.FILL,
      [1, 4, X - 1000, Y - 1000, 0, X + 1000, Y - 1000, 0, X + 1000, Y + 1000, 0, X - 1000, Y + 1000, 0],
      {
        minX: X - 1000,
        minY: Y - 1000,
        maxX: X + 1000,
        maxY: Y + 1000,
      },
    );
    b.add({ ...meta, type: ET.POINT }, GK.POINT, [X + 15, Y + 27], {
      minX: X + 15,
      minY: Y + 27,
      maxX: X + 15,
      maxY: Y + 27,
    });
    const store = b.finish();
    const win = { minX: X + 10, minY: Y + 20, maxX: X + 30, maxY: Y + 30 };
    const d = buildDetailData(store, storeExtents(store), [3, 2, 1, 0], win);
    const segs: number[][] = [];
    for (const batch of d.segments) {
      expect([batch.ox, batch.oy]).toEqual([X + 20, Y + 25]);
      const f32 = new Float32Array(batch.data);
      for (let k = 0; k < batch.count; k++) {
        const o = (k * SEG_STRIDE) / 4;
        segs.push([f32[o], f32[o + 1], f32[o + 2], f32[o + 3], f32[o + 6]]);
      }
    }
    // Polyline: the first leg cut at x = X + 10, its linetype distance continuing from the true start
    // (110 units in); the second leg cut at y = Y + 30. Then the point's cross (± diagonal × 10⁻⁴). The
    // hidden line is left out.
    const c = Math.hypot(2000, 2000) * 1e-4;
    const expected = [
      [-10, 0, 0, 0, 110],
      [0, 0, 0, 5, 120],
      [-5 - c, 2, -5 + c, 2, 0],
      [-5, 2 - c, -5, 2 + c, 0],
    ];
    expect(segs).toHaveLength(expected.length);
    segs.forEach((sg, k) => sg.forEach((v, j) => expect(v).toBeCloseTo(expected[k][j], 5)));
    // The fill is cut to exactly the window: 20 × 10, every vertex within it.
    let area = 0;
    for (const batch of d.triangles) {
      const f32 = new Float32Array(batch.data);
      for (let k = 0; k < batch.count; k += 3) {
        const v = [0, 1, 2].map((j) => [
          f32[((k + j) * TRI_STRIDE) / 4],
          f32[((k + j) * TRI_STRIDE) / 4 + 1],
        ]);
        for (const [x, y] of v) {
          expect(Math.abs(x)).toBeLessThanOrEqual(10);
          expect(Math.abs(y)).toBeLessThanOrEqual(5);
        }
        area +=
          Math.abs((v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[2][0] - v[0][0]) * (v[1][1] - v[0][1])) / 2;
      }
    }
    expect(area).toBeCloseTo(200, 6);
  });

  it('reuses fill triangulations between windows', () => {
    const b = new EntityStoreBuilder();
    const ring = [4, 0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0];
    b.add({ ...meta, type: ET.SOLID }, GK.FILL, [1, ...ring], { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const store = b.finish();
    const fills = new Map<number, { coords: number[]; idx: number[] }>();
    const area = (r: Bounds) => {
      const d = buildDetailData(store, storeExtents(store), [0], r, {}, fills);
      return d.triangles.reduce((n, t) => n + t.count, 0);
    };
    expect(area({ minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBeGreaterThan(0);
    const cached = fills.get(0)!;
    expect(cached.idx).toHaveLength(6);
    expect(area({ minX: 50, minY: 50, maxX: 60, maxY: 70 })).toBeGreaterThan(0);
    expect(fills.get(0)).toBe(cached);
  });

  it('a window serves the view until the view leaves it or zooms 16× further in', () => {
    const view: ViewTransform = { cx: 600_000, cy: 2_500_000, scale: 1_000, rotation: 0.5 };
    const A: Affine2D = [0.001, 0, 0, 0.001, 0, 0]; // millimetre drawing placed in metres
    const v = viewInDrawing(view, W, H, A);
    // The view in drawing units covers the rotated canvas: about (W cos + H sin) / scale metres wide.
    const wide = ((W * Math.cos(0.5) + H * Math.sin(0.5)) / 1_000) * 1_000;
    expect(v.maxX - v.minX).toBeCloseTo(wide, 3);
    expect((v.minX + v.maxX) / 2).toBeCloseTo(600_000_000, 3);
    const rect = windowAround(v);
    expect(rect.maxX - rect.minX).toBeCloseTo(3 * wide, 3);
    const win = { rect, pxPerUnit: 1, version: 3 };
    expect(windowServes(win, v, 1, 3)).toBe(true);
    expect(windowServes(win, v, 1, 4)).toBe(false); // the drawing was reloaded
    expect(windowServes(win, v, 16, 3)).toBe(true);
    expect(windowServes(win, v, 17, 3)).toBe(false);
    const panned = { ...v, minX: v.minX + 1.01 * wide, maxX: v.maxX + 1.01 * wide };
    expect(windowServes(win, panned, 1, 3)).toBe(false);
    const nearly = { ...v, minX: v.minX + 0.99 * wide, maxX: v.maxX + 0.99 * wide };
    expect(windowServes(win, nearly, 1, 3)).toBe(true);
  });
});
