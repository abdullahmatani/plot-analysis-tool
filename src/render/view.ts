import type { Affine2D, Bounds, Pt } from '@/core/types';
import type { ViewTransform } from '@/store/view';

/**
 * View transform helpers. World coordinates are metres (y up); screen coordinates are CSS pixels
 * (y down) relative to the canvas. `rotation` rotates the drawing counter-clockwise on screen.
 */

export const MIN_SCALE = 1e-6; // px per metre
export const MAX_SCALE = 2e5; // px per metre (0.005 mm per px)

export function worldToScreen(v: ViewTransform, w: number, h: number, p: Pt): Pt {
  const c = Math.cos(v.rotation);
  const s = Math.sin(v.rotation);
  const dx = p.x - v.cx;
  const dy = p.y - v.cy;
  return { x: w / 2 + v.scale * (c * dx - s * dy), y: h / 2 - v.scale * (s * dx + c * dy) };
}

export function screenToWorld(v: ViewTransform, w: number, h: number, p: Pt): Pt {
  const c = Math.cos(v.rotation);
  const s = Math.sin(v.rotation);
  const sx = (p.x - w / 2) / v.scale;
  const sy = -(p.y - h / 2) / v.scale;
  // Inverse rotation.
  return { x: v.cx + c * sx + s * sy, y: v.cy - s * sx + c * sy };
}

/** World → screen as a Canvas 2D matrix [a, b, c, d, e, f] (setTransform order). */
export function worldToScreenMatrix(v: ViewTransform, w: number, h: number): Affine2D {
  const c = Math.cos(v.rotation) * v.scale;
  const s = Math.sin(v.rotation) * v.scale;
  // x' = c·(x−cx) − s·(y−cy) + w/2 ; y' = −s·(x−cx) − c·(y−cy) + h/2
  return [c, -s, -s, -c, w / 2 - c * v.cx + s * v.cy, h / 2 + s * v.cx + c * v.cy];
}

/** Zooms by `factor` keeping the world point under `screenPt` fixed. */
export function zoomAt(v: ViewTransform, w: number, h: number, screenPt: Pt, factor: number): ViewTransform {
  const scale = clampScale(v.scale * factor);
  const before = screenToWorld(v, w, h, screenPt);
  const next = { ...v, scale };
  const after = screenToWorld(next, w, h, screenPt);
  return { ...next, cx: v.cx + (before.x - after.x), cy: v.cy + (before.y - after.y) };
}

export function panBy(v: ViewTransform, dxPx: number, dyPx: number): ViewTransform {
  const c = Math.cos(v.rotation);
  const s = Math.sin(v.rotation);
  const sx = -dxPx / v.scale;
  const sy = dyPx / v.scale;
  return { ...v, cx: v.cx + c * sx + s * sy, cy: v.cy - s * sx + c * sy };
}

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** View that fits world bounds into the canvas with a margin (in px), keeping rotation. */
export function fitBounds(b: Bounds, w: number, h: number, rotation = 0, margin = 24): ViewTransform {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  // Extent of the rotated box.
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  const bw = Math.max(b.maxX - b.minX, 1e-9);
  const bh = Math.max(b.maxY - b.minY, 1e-9);
  const rw = c * bw + s * bh;
  const rh = s * bw + c * bh;
  const scale = clampScale(Math.min((w - 2 * margin) / rw, (h - 2 * margin) / rh));
  return { cx, cy, scale: Number.isFinite(scale) && scale > 0 ? scale : 1, rotation };
}

/** World-space bounding box of the visible canvas (accounts for rotation). */
export function visibleWorldBounds(v: ViewTransform, w: number, h: number): Bounds {
  const pts = [
    screenToWorld(v, w, h, { x: 0, y: 0 }),
    screenToWorld(v, w, h, { x: w, y: 0 }),
    screenToWorld(v, w, h, { x: w, y: h }),
    screenToWorld(v, w, h, { x: 0, y: h }),
  ];
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/**
 * Batch → clip-space transform computed in float64 (row 18): for local float32 coordinates `l` of a
 * batch with origin `o` in drawing units, placed in the world by affine `A`, returns M (2×2,
 * column-major for GLSL mat2) and t such that clip = M·l + t.
 */
export function batchClipTransform(
  v: ViewTransform,
  w: number,
  h: number,
  A: Affine2D,
  ox: number,
  oy: number,
): { m: Float32Array; t: Float32Array } {
  const c = Math.cos(v.rotation) * v.scale;
  const s = Math.sin(v.rotation) * v.scale;
  // K: world-relative → clip (y up in clip space).
  const k00 = (2 / w) * c;
  const k01 = (2 / w) * -s;
  const k10 = (2 / h) * s;
  const k11 = (2 / h) * c;
  const [a, b, cc, d, e, f] = A;
  // World of batch origin relative to view centre (float64).
  const wx = a * ox + cc * oy + e - v.cx;
  const wy = b * ox + d * oy + f - v.cy;
  // M = K · L, L = [[a, cc], [b, d]]
  const m00 = k00 * a + k01 * b;
  const m01 = k00 * cc + k01 * d;
  const m10 = k10 * a + k11 * b;
  const m11 = k10 * cc + k11 * d;
  return {
    m: new Float32Array([m00, m10, m01, m11]),
    t: new Float32Array([k00 * wx + k01 * wy, k10 * wx + k11 * wy]),
  };
}
