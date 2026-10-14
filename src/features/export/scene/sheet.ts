import type { Affine2D, Bounds, PaperSize, Pt, SheetLayout } from '@/core/types';

/**
 * Sheet geometry for exports (row 76): paper sizes, standard print scales, the map viewport and the
 * world → paper transform. Paper coordinates are millimetres from the sheet's top-left corner,
 * y pointing down (the export scene convention).
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Portrait sizes (w ≤ h) in millimetres. ANSI sizes are exact inch conversions. */
export const PAPER_MM: Record<Exclude<PaperSize, 'custom'>, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  A2: { w: 420, h: 594 },
  A1: { w: 594, h: 841 },
  A0: { w: 841, h: 1189 },
  'ANSI A': { w: 215.9, h: 279.4 },
  'ANSI B': { w: 279.4, h: 431.8 },
  'ANSI C': { w: 431.8, h: 558.8 },
  'ANSI D': { w: 558.8, h: 863.6 },
  'ANSI E': { w: 863.6, h: 1117.6 },
};

export const PAPER_SIZES: PaperSize[] = [
  'A4',
  'A3',
  'A2',
  'A1',
  'A0',
  'ANSI A',
  'ANSI B',
  'ANSI C',
  'ANSI D',
  'ANSI E',
  'custom',
];

/** Paper size in mm with the sheet orientation applied. */
export function paperSizeMm(sheet: Pick<SheetLayout, 'paper' | 'customMm' | 'orientation'>): {
  w: number;
  h: number;
} {
  const base =
    sheet.paper === 'custom'
      ? {
          w: Math.max(10, sheet.customMm?.w ?? 297),
          h: Math.max(10, sheet.customMm?.h ?? 210),
        }
      : PAPER_MM[sheet.paper];
  if (sheet.paper === 'custom') return base;
  const long = Math.max(base.w, base.h);
  const short = Math.min(base.w, base.h);
  return sheet.orientation === 'landscape' ? { w: long, h: short } : { w: short, h: long };
}

/** Common engineering print scales (denominators). */
export const STANDARD_SCALES = [
  1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000, 20000, 25000, 50000,
  100000, 200000, 250000, 500000, 1000000,
];

/** Smallest "nice" scale denominator ≥ n (standard list, then 1/2/2.5/5 × 10ᵏ). */
export function niceScaleAtLeast(n: number): number {
  if (!(n > 0) || !Number.isFinite(n)) return 1000;
  const eps = n * 1e-9;
  for (const s of STANDARD_SCALES) if (s >= n - eps) return s;
  const exp = Math.floor(Math.log10(n));
  for (const k of [1, 2, 2.5, 5, 10]) {
    const v = k * 10 ** exp;
    if (v >= n - eps) return v;
  }
  return 10 ** (exp + 1);
}

/** Paper millimetres per world metre at 1:N. */
export function mmPerMetre(scale: number): number {
  return 1000 / scale;
}

/**
 * World → paper affine for a viewport centred at `vc` (paper mm), world centre `wc`, print scale
 * 1:`scale` and view rotation `rotation` (radians, CCW as seen on paper). Mirrors the screen view
 * transform (`worldToScreenMatrix`), so a sheet set up from the current view looks the same.
 */
export function paperFromWorld(vc: Pt, wc: Pt, scale: number, rotation: number): Affine2D {
  const k = mmPerMetre(scale);
  const c = Math.cos(rotation) * k;
  const s = Math.sin(rotation) * k;
  return [c, -s, -s, -c, vc.x - c * wc.x + s * wc.y, vc.y + s * wc.x + c * wc.y];
}

/** World extent (metres, rotated by `rotation`) that a paper rectangle covers at 1:scale. */
export function rotatedExtent(b: Bounds, rotation: number): { w: number; h: number } {
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  const bw = Math.max(b.maxX - b.minX, 1e-9);
  const bh = Math.max(b.maxY - b.minY, 1e-9);
  return { w: c * bw + s * bh, h: s * bw + c * bh };
}

/** Exact (non-rounded) scale denominator that fits world bounds into a paper rectangle. */
export function fitScale(b: Bounds, rotation: number, viewport: { w: number; h: number }): number {
  const e = rotatedExtent(b, rotation);
  const k = Math.min(viewport.w / e.w, viewport.h / e.h); // mm per metre
  return k > 0 && Number.isFinite(k) ? 1000 / k : 1000;
}

export function boundsCentre(b: Bounds): Pt {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** UI scale factor for decorations: 1 on A1/A0, smaller on small sheets (text stays legible). */
export function decorationScale(paper: { w: number; h: number }): number {
  const short = Math.min(paper.w, paper.h);
  return Math.max(0.62, Math.min(1, short / 594));
}

export interface SheetFrame {
  paper: { w: number; h: number };
  /** Drawing frame (inside the margins). */
  frame: Rect;
  /** Map viewport (equals the frame; the title block and legend sit on top of it). */
  viewport: Rect;
  /** Title block box, when shown. */
  titleBlock?: Rect;
  /** Scale for decoration sizes (text heights, boxes). */
  ui: number;
}

/** Title block width in mm for a frame. */
export function titleBlockWidth(frame: Rect, ui: number): number {
  return Math.min(180 * ui, frame.w * 0.6);
}

export function rectCentre(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function rectToBounds(r: Rect): Bounds {
  return { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
}

export function insetRect(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) };
}

/** Sheet frame for a layout; the title block height is decided by the decoration builder. */
export function sheetFrame(sheet: SheetLayout): SheetFrame {
  const paper = paperSizeMm(sheet);
  const m = Math.max(0, Math.min(sheet.marginsMm, Math.min(paper.w, paper.h) / 4));
  const frame: Rect = { x: m, y: m, w: paper.w - 2 * m, h: paper.h - 2 * m };
  return { paper, frame, viewport: { ...frame }, ui: decorationScale(paper) };
}

/** Standard scale label, e.g. "1:500". */
export function scaleLabel(scale: number): string {
  const n = Math.round(scale);
  const exact = Math.abs(n - scale) < 1e-6 * scale;
  const v = exact ? n : Number(scale.toPrecision(5));
  return `1:${v.toLocaleString('en-US').replace(/,/g, ' ')}`;
}

/** Paper size name for statements ("A1", "ANSI D", "420 × 297 mm"). */
export function paperName(sheet: SheetLayout): string {
  if (sheet.paper !== 'custom') return sheet.paper;
  const p = paperSizeMm(sheet);
  return `${Number(p.w.toFixed(1))} × ${Number(p.h.toFixed(1))} mm`;
}
