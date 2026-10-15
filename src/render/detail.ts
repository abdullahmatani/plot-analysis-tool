import { invert, transformBounds } from '@/core/affine';
import type { Affine2D, Bounds } from '@/core/types';
import type { ViewTransform } from '@/store/view';

import { visibleWorldBounds } from './view';

/**
 * When to draw a drawing from detail batches (row 18). The full batches store float32 offsets from
 * each batch origin, so a vertex far from its origin (a long line, or any line on a 10 km site)
 * lands up to about 2 × radius × px per unit × 2⁻²⁴ pixels off on screen, and moves by that much
 * while the view pans. Past `DETAIL_THRESHOLD_PX` the renderer draws detail batches instead: the
 * float64 entities around the view, cut to a window and stored relative to its centre, which
 * keeps every vertex within a few screen sizes of its origin at any zoom.
 */

/** On-screen error (CSS px) the full batches may have before detail batches take over. */
export const DETAIL_THRESHOLD_PX = 0.25;

/**
 * Worst on-screen error (CSS px) of float32 batches whose vertices lie up to `radius` drawing units
 * from their origin. The factor 2.5 covers the error measured by emulating the vertex shader
 * (detail.test.ts: up to 2 × radius × px per unit × 2⁻²⁴).
 */
export function batchErrorPx(radius: number, pxPerUnit: number): number {
  return 2.5 * radius * pxPerUnit * 2 ** -24;
}

/** Largest stretch of the placement (screen px per drawing unit at view scale 1). */
export function placementStretch(m: Affine2D): number {
  const [a, b, c, d] = m;
  const s = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  return Math.sqrt((s + Math.sqrt(Math.max(0, s * s - 4 * det * det))) / 2);
}

/** The visible canvas in drawing units: the bounding box of the view mapped through the placement. */
export function viewInDrawing(view: ViewTransform, w: number, h: number, placement: Affine2D): Bounds {
  return transformBounds(invert(placement), visibleWorldBounds(view, w, h));
}

/** A detail window: the area its batches cover and the zoom they were built for. */
export interface DetailWindow {
  rect: Bounds;
  pxPerUnit: number;
  /** Model version the batches were built from. */
  version: number;
}

/** The view and one view size around it on each side, so panning rebuilds only now and then. */
export function windowAround(view: Bounds): Bounds {
  const w = view.maxX - view.minX;
  const h = view.maxY - view.minY;
  return { minX: view.minX - w, minY: view.minY - h, maxX: view.maxX + w, maxY: view.maxY + h };
}

/**
 * Whether a window still serves the view: it covers it, and the view has not zoomed in so far
 * (16×) that the window would hold far more than is visible.
 */
export function windowServes(win: DetailWindow, view: Bounds, pxPerUnit: number, version: number): boolean {
  return (
    win.version === version &&
    pxPerUnit <= win.pxPerUnit * 16 &&
    view.minX >= win.rect.minX &&
    view.minY >= win.rect.minY &&
    view.maxX <= win.rect.maxX &&
    view.maxY <= win.rect.maxY
  );
}
