import type { Bounds } from '@/core/types';

import type { HatchPatternName } from './scene';

/**
 * Hatch geometry shared by the PDF and canvas backends (SVG uses an equivalent `<pattern>`). Line
 * families are anchored at the paper origin so adjacent shapes' hatches line up and every backend
 * produces identical lines:
 *
 * - horizontal: y = k·s;  vertical: x = k·s
 * - diagonal ('/' on paper): (x + y)/√2 = k·s;  back-diagonal ('\'): (x − y)/√2 = k·s
 * - dots: grid points (i·s, j·s)
 */

export interface HatchGeometry {
  /** Line segments [x1, y1, x2, y2] in paper mm covering `bounds`. */
  lines: [number, number, number, number][];
  /** Dot centres in paper mm. */
  dots: [number, number][];
  /** Effective spacing (may be enlarged to respect the element budget). */
  spacing: number;
}

const SQRT1_2 = Math.SQRT1_2;

/** Unit normals of the line families of each pattern. */
export function hatchFamilies(pattern: HatchPatternName): [number, number][] {
  switch (pattern) {
    case 'horizontal':
      return [[0, 1]];
    case 'vertical':
      return [[1, 0]];
    case 'diagonal':
      return [[SQRT1_2, SQRT1_2]];
    case 'back-diagonal':
      return [[SQRT1_2, -SQRT1_2]];
    case 'cross':
      return [
        [0, 1],
        [1, 0],
      ];
    case 'diagonal-cross':
      return [
        [SQRT1_2, SQRT1_2],
        [SQRT1_2, -SQRT1_2],
      ];
    case 'dots':
      return [];
  }
}

/**
 * Hatch lines/dots covering `bounds`, to be clipped to the filled shape by the caller.
 * `maxElements` caps the output; the spacing is increased (doubled) until it fits.
 */
export function hatchGeometry(
  pattern: HatchPatternName,
  bounds: Bounds,
  spacing: number,
  maxElements = 20000,
): HatchGeometry {
  const out: HatchGeometry = { lines: [], dots: [], spacing };
  if (!(spacing > 0) || !Number.isFinite(spacing)) return out;
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  if (!(w >= 0 && h >= 0)) return out;
  let s = spacing;
  if (pattern === 'dots') {
    while ((Math.floor(w / s) + 2) * (Math.floor(h / s) + 2) > maxElements) s *= 2;
    out.spacing = s;
    for (let i = Math.ceil(bounds.minX / s); i * s <= bounds.maxX; i++) {
      for (let j = Math.ceil(bounds.minY / s); j * s <= bounds.maxY; j++) out.dots.push([i * s, j * s]);
    }
    return out;
  }
  const families = hatchFamilies(pattern);
  const diag = Math.hypot(w, h);
  while (families.length * (Math.ceil(diag / s) + 2) > maxElements) s *= 2;
  out.spacing = s;
  const corners: [number, number][] = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ];
  for (const [nx, ny] of families) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, y] of corners) {
      const d = x * nx + y * ny;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    // Direction along the line.
    const dx = -ny;
    const dy = nx;
    for (let k = Math.ceil(lo / s); k * s <= hi; k++) {
      const c = k * s;
      const seg = clipLine(c * nx, c * ny, dx, dy, bounds);
      if (seg) out.lines.push(seg);
    }
  }
  return out;
}

/** Liang–Barsky clip of the infinite line p0 + t·d to the box. */
function clipLine(
  px: number,
  py: number,
  dx: number,
  dy: number,
  b: Bounds,
): [number, number, number, number] | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  const test = (p: number, q: number) => {
    if (Math.abs(p) < 1e-15) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t0) t0 = r;
    } else if (r < t1) t1 = r;
    return true;
  };
  if (!test(-dx, px - b.minX) || !test(dx, b.maxX - px) || !test(-dy, py - b.minY) || !test(dy, b.maxY - py))
    return null;
  if (t0 > t1 || !Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return [px + t0 * dx, py + t0 * dy, px + t1 * dx, py + t1 * dy];
}
