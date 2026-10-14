import type { Affine2D, Bounds } from '@/core/types';
import {
  EntityStoreBuilder,
  ET,
  FLAG,
  GK,
  emptyReport,
  storeExtents,
  type DrawingParseResult,
} from '@/underlay/entity-store';

/**
 * PDF vector extraction (row 16). Walks a page operator list (pdf.js), tracks the graphics state
 * (save/restore, transforms, form XObjects, optional-content groups) and converts painted paths into
 * EntityStore entities in drawing coordinates (PDF points, y up, page rotation applied). Cubic curves
 * are tessellated (endpoints exact); 4-curve closed subpaths that approximate circles become CIRCLE
 * entities so centre snaps work. Pages with an image but almost no vector paths are flagged raster.
 */

/** Subset of pdf.js OPS codes used here (values are stable across pdf.js 4–6). */
export interface PdfOps {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  beginMarkedContentProps: number;
  beginMarkedContent: number;
  endMarkedContent: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
  setStrokeRGBColor: number;
  setFillRGBColor: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  endPath: number;
  showText: number;
}

export interface PdfOperatorList {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

const DRAW_MOVE = 0;
const DRAW_LINE = 1;
const DRAW_CURVE = 2;
const DRAW_QUAD = 3;
const DRAW_CLOSE = 4;

function mul(m1: Affine2D, m2: Affine2D): Affine2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export interface ExtractOptions {
  ops: PdfOps;
  /** PDF user space → drawing coordinates (points, y up). */
  pageTransform: Affine2D;
  /** Page size in drawing units (points). */
  width: number;
  height: number;
  rotation: number;
  /** Optional content groups: id → name, and initial visibility. */
  ocgs: { id: string; name: string; visible: boolean }[];
  /** Max curve tessellation steps per cubic. */
  curveSteps?: number;
  onProgress?: (f: number) => void;
}

const rgbToNum = (r: number, g: number, b: number) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);

function parseColor(args: unknown): number | null {
  const a = args as unknown[];
  if (!a) return null;
  if (typeof a[0] === 'string') {
    const m = /^#([0-9a-f]{6})$/i.exec(a[0]);
    return m ? parseInt(m[1], 16) : null;
  }
  if (typeof a[0] === 'number' && a.length >= 3)
    return rgbToNum(a[0] as number, a[1] as number, a[2] as number);
  return null;
}

export function extractPdfVectors(opList: PdfOperatorList, opts: ExtractOptions): DrawingParseResult {
  const { ops } = opts;
  const b = new EntityStoreBuilder();
  const report = emptyReport();
  // Layer 0 = content outside optional-content groups.
  b.layers.push({
    name: 'Page content',
    color: 0x808080,
    linetype: 'CONTINUOUS',
    lineweight: -3,
    off: false,
    frozen: false,
    plot: true,
  });
  const ocgLayer = new Map<string, number>();
  for (const g of opts.ocgs) {
    ocgLayer.set(g.id, b.layers.length);
    b.layers.push({
      name: g.name,
      color: 0x808080,
      linetype: 'CONTINUOUS',
      lineweight: -3,
      off: !g.visible,
      frozen: false,
      plot: true,
      ocgId: g.id,
    });
  }
  const steps = opts.curveSteps ?? 8;
  let ctm: Affine2D = [...opts.pageTransform] as Affine2D;
  const stack: Affine2D[] = [];
  const mcStack: number[] = [];
  let currentLayer = 0;
  let stroke = 0x404040;
  let fill = 0x808080;
  let images = 0;
  let pathCount = 0;
  let textOps = 0;
  const n = opList.fnArray.length;
  const progressEvery = Math.max(1, Math.floor(n / 50));

  const emitSubpath = (
    pts: number[],
    closed: boolean,
    color: number,
    filled: boolean,
    circle: { cx: number; cy: number; r: number } | null,
  ) => {
    const meta = {
      type: filled ? ET.PDF_FILL : ET.PDF_PATH,
      layer: currentLayer,
      color,
      flags: closed ? FLAG.CLOSED : 0,
    };
    if (circle) {
      b.add({ ...meta, type: ET.CIRCLE }, GK.CIRCLE, [circle.cx, circle.cy, circle.r], {
        minX: circle.cx - circle.r,
        minY: circle.cy - circle.r,
        maxX: circle.cx + circle.r,
        maxY: circle.cy + circle.r,
      });
      return;
    }
    const k = pts.length / 2;
    if (k < 2) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i];
      if (pts[i] > maxX) maxX = pts[i];
      if (pts[i + 1] < minY) minY = pts[i + 1];
      if (pts[i + 1] > maxY) maxY = pts[i + 1];
    }
    const bounds: Bounds = { minX, minY, maxX, maxY };
    if (k === 2 && !closed) {
      b.add(meta, GK.LINE, [pts[0], pts[1], pts[2], pts[3]], bounds);
      return;
    }
    const vals = new Array(1 + k * 3);
    vals[0] = k;
    for (let i = 0; i < k; i++) {
      vals[1 + i * 3] = pts[i * 2];
      vals[2 + i * 3] = pts[i * 2 + 1];
      vals[3 + i * 3] = 0;
    }
    if (filled && closed && k >= 3) {
      b.add(meta, GK.FILL, [1, ...vals], bounds);
    } else {
      b.add(meta, GK.POLY, vals, bounds);
    }
  };

  for (let i = 0; i < n; i++) {
    if (i % progressEvery === 0) opts.onProgress?.(i / n);
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as unknown[];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? ctm;
    else if (fn === ops.transform) ctm = mul(ctm, args as unknown as Affine2D);
    else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0] as Affine2D | null;
      if (m && m.length === 6) ctm = mul(ctm, m);
    } else if (fn === ops.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === ops.beginMarkedContentProps) {
      mcStack.push(currentLayer);
      const tag = args?.[0];
      const props = args?.[1] as { type?: string; id?: string } | null;
      if (tag === 'OC' && props?.id && ocgLayer.has(props.id)) currentLayer = ocgLayer.get(props.id)!;
    } else if (fn === ops.beginMarkedContent) mcStack.push(currentLayer);
    else if (fn === ops.endMarkedContent) currentLayer = mcStack.pop() ?? 0;
    else if (fn === ops.setStrokeRGBColor) stroke = parseColor(args) ?? stroke;
    else if (fn === ops.setFillRGBColor) fill = parseColor(args) ?? fill;
    else if (
      fn === ops.paintImageXObject ||
      fn === ops.paintInlineImageXObject ||
      fn === ops.paintImageMaskXObject
    )
      images++;
    else if (fn === ops.showText) textOps++;
    else if (fn === ops.constructPath) {
      const paint = args[0] as number;
      if (paint === ops.endPath) continue; // clipping path only
      const filled = paint !== ops.stroke && paint !== ops.closeStroke;
      const stroked = paint !== ops.fill && paint !== ops.eoFill;
      const data = (args[1] as unknown[])?.[0] as ArrayLike<number> | null;
      if (!data || typeof data.length !== 'number') continue;
      const color = stroked ? stroke : fill;
      const [a, bb, c, d, e, f] = ctm;
      const tx = (x: number, y: number) => [a * x + c * y + e, bb * x + d * y + f] as const;
      let pts: number[] = [];
      let curves = 0;
      let curveCtrl: number[] = [];
      let sx = 0;
      let sy = 0;
      let cx = 0;
      let cy = 0;
      const flushSub = (explicitClose: boolean) => {
        const m = pts.length;
        // A subpath ending exactly where it started is closed even without a closePath operator.
        const closed =
          explicitClose ||
          (m >= 6 && Math.abs(pts[0] - pts[m - 2]) < 1e-6 && Math.abs(pts[1] - pts[m - 1]) < 1e-6);
        if (pts.length >= 4) {
          let circle: { cx: number; cy: number; r: number } | null = null;
          if (closed && curves === 4 && pts.length / 2 === 4 * steps + 1) circle = detectCircle(curveCtrl);
          if (closed && pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1])
            pts.length -= 2;
          emitSubpath(pts, closed, color, filled, circle);
          pathCount++;
        }
        pts = [];
        curves = 0;
        curveCtrl = [];
      };
      let j = 0;
      while (j < data.length) {
        const op = data[j++];
        if (op === DRAW_MOVE) {
          flushSub(false);
          cx = sx = data[j++];
          cy = sy = data[j++];
          const [X, Y] = tx(cx, cy);
          pts.push(X, Y);
        } else if (op === DRAW_LINE) {
          cx = data[j++];
          cy = data[j++];
          const [X, Y] = tx(cx, cy);
          pts.push(X, Y);
        } else if (op === DRAW_CURVE || op === DRAW_QUAD) {
          const quad = op === DRAW_QUAD;
          const x1 = data[j++];
          const y1 = data[j++];
          const x2 = quad ? x1 : data[j++];
          const y2 = quad ? y1 : data[j++];
          const x3 = data[j++];
          const y3 = data[j++];
          const p0 = tx(cx, cy);
          const p1 = tx(x1, y1);
          const p2 = tx(x2, y2);
          const p3 = tx(x3, y3);
          curves++;
          curveCtrl.push(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const u = 1 - t;
            if (s === steps) {
              pts.push(p3[0], p3[1]);
            } else if (quad) {
              pts.push(
                u * u * p0[0] + 2 * u * t * p1[0] + t * t * p3[0],
                u * u * p0[1] + 2 * u * t * p1[1] + t * t * p3[1],
              );
            } else {
              const b0 = u * u * u;
              const b1 = 3 * u * u * t;
              const b2 = 3 * u * t * t;
              const b3 = t * t * t;
              pts.push(
                b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0],
                b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1],
              );
            }
          }
          cx = x3;
          cy = y3;
        } else if (op === DRAW_CLOSE) {
          const [X, Y] = tx(sx, sy);
          if (pts.length >= 2 && (pts[pts.length - 2] !== X || pts[pts.length - 1] !== Y)) pts.push(X, Y);
          flushSub(true);
          cx = sx;
          cy = sy;
          const [X2, Y2] = tx(sx, sy);
          pts.push(X2, Y2);
        } else {
          break; // unknown op: stop reading this path
        }
      }
      // A filled path that was not explicitly closed is implicitly closed.
      flushSub(filled && pts.length >= 6);
    }
  }
  opts.onProgress?.(1);
  const store = b.finish();
  const raster = images > 0 && pathCount < 20;
  report.counts['PATH'] = pathCount;
  if (images) report.counts['IMAGE'] = images;
  if (textOps) report.counts['TEXT'] = textOps;
  if (raster)
    report.warnings.push(
      'This page is a raster (scanned) image: snapping and tracing to drawing geometry are unavailable on it.',
    );
  const extents: Bounds = store.count
    ? storeExtents(store)
    : { minX: 0, minY: 0, maxX: opts.width, maxY: opts.height };
  // The drawing extent is the page, so that "zoom extents" shows the whole sheet.
  const pageExtents: Bounds = {
    minX: Math.min(0, extents.minX),
    minY: Math.min(0, extents.minY),
    maxX: Math.max(opts.width, extents.maxX),
    maxY: Math.max(opts.height, extents.maxY),
  };
  return {
    store,
    extents: clampTo(pageExtents, opts),
    insunits: -1,
    layouts: [],
    layout: '',
    report,
    page: { width: opts.width, height: opts.height, rotation: opts.rotation, raster, ocgs: opts.ocgs },
  };
}

function clampTo(b: Bounds, opts: { width: number; height: number }): Bounds {
  // Ignore stray geometry far outside the page (e.g. off-page clipping artefacts).
  return {
    minX: Math.max(b.minX, -opts.width),
    minY: Math.max(b.minY, -opts.height),
    maxX: Math.min(b.maxX, opts.width * 2),
    maxY: Math.min(b.maxY, opts.height * 2),
  };
}

/** Detects a circle drawn as 4 cubic Béziers (control points ≈ κ·r). Returns null if not circular. */
export function detectCircle(ctrl: number[]): { cx: number; cy: number; r: number } | null {
  if (ctrl.length !== 32) return null;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < 4; k++) {
    cx += ctrl[k * 8];
    cy += ctrl[k * 8 + 1];
  }
  cx /= 4;
  cy /= 4;
  const radii: number[] = [];
  for (let k = 0; k < 4; k++) radii.push(Math.hypot(ctrl[k * 8] - cx, ctrl[k * 8 + 1] - cy));
  const r = radii.reduce((s, v) => s + v, 0) / 4;
  if (r <= 0) return null;
  for (const v of radii) if (Math.abs(v - r) > r * 0.01) return null;
  // Mid-curve point of each Bézier must also be at distance r.
  for (let k = 0; k < 4; k++) {
    const o = k * 8;
    const mx = 0.125 * ctrl[o] + 0.375 * ctrl[o + 2] + 0.375 * ctrl[o + 4] + 0.125 * ctrl[o + 6];
    const my = 0.125 * ctrl[o + 1] + 0.375 * ctrl[o + 3] + 0.375 * ctrl[o + 5] + 0.125 * ctrl[o + 7];
    if (Math.abs(Math.hypot(mx - cx, my - cy) - r) > r * 0.01) return null;
  }
  return { cx, cy, r };
}
