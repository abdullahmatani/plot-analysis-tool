import { invert, multiply, transformBounds } from '@/core/affine';
import type { Affine2D, Bounds, Drawing } from '@/core/types';
import {
  arcToCubics,
  bulgePolylineToPath,
  circlePath,
  ellipseToCubics,
  transformPath,
  type FillStyle,
  type GroupItem,
  type PathCmd,
  type PathItem,
  type PdfPageItem,
  type SceneItem,
  type StrokeStyle,
  type TextAnchor,
  type TextBaseline,
  type TextItem,
} from '@/export/scene';
import { FLAG, GK, readPoly, readRings, type EntityStore } from '@/underlay/entity-store';
import { placementOf } from '@/underlay/models';

import type { DrawingSceneInput } from './types';

/**
 * CAD and PDF underlays on the sheet (row 77): CAD entities are drawn as vectors with their layer
 * visibility, colours (ACI 7 / white prints black, as on a light canvas), lineweights, linetypes,
 * solid and pattern hatches and text with the bundled fonts; PDF pages are embedded as vector pages
 * (the PDF backend copies the page content; raster backends use a rendered stand-in).
 */

/** Print width of entities with the default lineweight (mm). */
export const DEFAULT_LINEWEIGHT_MM = 0.18;
const MIN_LINEWEIGHT_MM = 0.05;
/** Em size of CAD text relative to its height (same factor as the on-screen text). */
export const CAD_TEXT_EM = 1.38;

export interface UnderlayContext {
  paperFromWorld: Affine2D;
  /** World bounds of the printed viewport (entities outside are skipped). */
  viewportWorld: Bounds;
}

export interface PdfItemRef {
  drawingId: string;
  item: PdfPageItem;
}

const hex = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

/** Entity colour on paper: near-white (ACI 7) prints black; ghosted drawings are greyed towards white. */
export function paperColor(rgb: number, ghost: boolean): string {
  let r = (rgb >> 16) & 255;
  let g = (rgb >> 8) & 255;
  let b = rgb & 255;
  if (r > 0.92 * 255 && g > 0.92 * 255 && b > 0.92 * 255) r = g = b = 0;
  if (ghost) {
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    r = g = b = Math.round(y + (255 - y) * 0.55);
  }
  return hex((r << 16) | (g << 8) | b);
}

/** Source layers drawn on paper: not hidden by the user and plottable. */
export function printableLayers(store: EntityStore, d: Drawing): Uint8Array {
  const hidden = new Set(d.hiddenSourceLayers);
  const out = new Uint8Array(Math.max(1, store.layers.length));
  store.layers.forEach((l, i) => {
    const off = hidden.has(l.ocgId ?? l.name) || hidden.has(l.name);
    out[i] = off || l.plot === false ? 0 : 1;
  });
  if (!store.layers.length) out[0] = 1;
  return out;
}

/** Linetype pattern (drawing units) → paper dash array (mm), or undefined for continuous. */
export function linetypeDash(
  pattern: readonly number[],
  unitMm: number,
  widthMm: number,
): number[] | undefined {
  if (!pattern.length) return undefined;
  const total = pattern.reduce((s, e) => s + Math.abs(e), 0) * unitMm;
  if (!(total > 0.5)) return undefined; // too fine to see: draw continuous (like the screen)
  // Alternating on, off, on, off … (even indices are dashes).
  const out: number[] = [];
  const push = (on: boolean, len: number) => {
    if (!out.length) {
      if (on) out.push(len);
      else out.push(0, len);
      return;
    }
    const lastOn = out.length % 2 === 1;
    if (lastOn === on) out[out.length - 1] += len;
    else out.push(len);
  };
  for (const e of pattern) {
    if (e > 0) push(true, e * unitMm);
    else if (e < 0) push(false, -e * unitMm);
    else push(true, Math.max(widthMm, 0.1)); // dot
  }
  if (out.length % 2) out.push(0);
  return out.some((v) => v > 0) && out.some((v, i) => i % 2 === 1 && v > 0) ? out : undefined;
}

function textAnchor(h: number): TextAnchor {
  return h === 1 ? 'middle' : h === 2 ? 'end' : 'start';
}

function textBaseline(v: number): TextBaseline {
  return v === 3 ? 'top' : v === 2 ? 'middle' : v === 1 ? 'bottom' : 'alphabetic';
}

interface LayerBuckets {
  fills: SceneItem[];
  strokes: SceneItem[];
  /** Pending merged stroke batch. */
  batch: { key: string; item: PathItem } | null;
}

/** Adds a CAD drawing's entities as vector groups (one optional-content layer per source layer). */
export function cadDrawingGroup(
  d: Drawing,
  input: DrawingSceneInput,
  ctx: UnderlayContext,
): GroupItem | null {
  const store = input.store;
  if (!store) return null;
  const placement = placementOf(d, input.insunits);
  const M = multiply(ctx.paperFromWorld, placement);
  const unitMm = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
  if (!(unitMm > 0) || !Number.isFinite(unitMm)) return null;
  let cull: Bounds | null = null;
  try {
    cull = transformBounds(invert(placement), ctx.viewportWorld);
  } catch {
    cull = null;
  }
  const flags = printableLayers(store, d);
  const ghost = d.ghost;
  const colours = new Map<number, string>();
  const colourOf = (rgb: number) => {
    let c = colours.get(rgb);
    if (!c) {
      c = paperColor(rgb, ghost);
      colours.set(rgb, c);
    }
    return c;
  };
  const dashes = new Map<string, number[] | undefined>();
  const dashOf = (lt: number, lts: number, width: number) => {
    const key = `${lt}|${lts}|${width}`;
    if (!dashes.has(key)) {
      const pattern = store.linetypes[lt]?.pattern ?? [];
      dashes.set(key, linetypeDash(pattern, unitMm * lts, width));
    }
    return dashes.get(key);
  };
  const toPaper = (p: { x: number; y: number }): [number, number] => [
    M[0] * p.x + M[2] * p.y + M[4],
    M[1] * p.x + M[3] * p.y + M[5],
  ];
  const textRot = Math.atan2(-M[1], M[0]);
  const buckets = new Map<number, LayerBuckets>();
  const bucket = (layer: number) => {
    let b = buckets.get(layer);
    if (!b) {
      b = { fills: [], strokes: [], batch: null };
      buckets.set(layer, b);
    }
    return b;
  };
  const addStroke = (layer: number, d: PathCmd[], stroke: StrokeStyle) => {
    const b = bucket(layer);
    const key = `${stroke.color}|${stroke.width}|${stroke.dash?.join(',') ?? ''}`;
    if (b.batch && b.batch.key === key && b.batch.item.d.length < 20000) {
      b.batch.item.d.push(...d);
      return;
    }
    const item: PathItem = { kind: 'path', d, stroke };
    b.strokes.push(item);
    b.batch = { key, item };
  };
  const g = store.geom;
  for (let i = 0; i < store.count; i++) {
    const fl = store.flags[i];
    if (fl & FLAG.HIDDEN) continue;
    const layer = store.layer[i];
    if (!flags[layer]) continue;
    const o4 = i * 4;
    if (
      cull &&
      (store.bbox[o4] > cull.maxX ||
        store.bbox[o4 + 2] < cull.minX ||
        store.bbox[o4 + 1] > cull.maxY ||
        store.bbox[o4 + 3] < cull.minY)
    )
      continue;
    const color = colourOf(store.color[i]);
    const lw = store.lineweight[i];
    const width = lw < 0 ? DEFAULT_LINEWEIGHT_MM : Math.max(MIN_LINEWEIGHT_MM, lw / 100);
    const o = store.geomStart[i];
    const stroke = (): StrokeStyle => {
      const s: StrokeStyle = { color, width, cap: 'round', join: 'round' };
      const dash = dashOf(store.linetype[i], store.ltscale[i] || 1, width);
      if (dash) {
        s.dash = dash;
        s.cap = 'butt';
      }
      return s;
    };
    switch (store.geomKind[i]) {
      case GK.LINE: {
        const [x1, y1] = toPaper({ x: g[o], y: g[o + 1] });
        const [x2, y2] = toPaper({ x: g[o + 2], y: g[o + 3] });
        addStroke(
          layer,
          [
            { op: 'M', x: x1, y: y1 },
            { op: 'L', x: x2, y: y2 },
          ],
          stroke(),
        );
        break;
      }
      case GK.CIRCLE:
        addStroke(layer, transformPath(circlePath(g[o], g[o + 1], g[o + 2]), M), stroke());
        break;
      case GK.ARC: {
        const [cx, cy, r, a0, a1] = [g[o], g[o + 1], g[o + 2], g[o + 3], g[o + 4]];
        const d: PathCmd[] = [
          { op: 'M', x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) },
          ...arcToCubics(cx, cy, r, a0, a1, true),
        ];
        addStroke(layer, transformPath(d, M), stroke());
        break;
      }
      case GK.ELLIPSE: {
        const [cx, cy, mx, my, ratio, t0, t1] = [
          g[o],
          g[o + 1],
          g[o + 2],
          g[o + 3],
          g[o + 4],
          g[o + 5],
          g[o + 6],
        ];
        const rx = Math.hypot(mx, my);
        const rot = Math.atan2(my, mx);
        const ry = rx * ratio;
        const full = Math.abs(t1 - t0) >= Math.PI * 2 - 1e-9 || t1 === t0;
        const c = Math.cos(rot);
        const s = Math.sin(rot);
        const start = {
          x: cx + rx * Math.cos(t0) * c - ry * Math.sin(t0) * s,
          y: cy + rx * Math.cos(t0) * s + ry * Math.sin(t0) * c,
        };
        const d: PathCmd[] = [
          { op: 'M', x: start.x, y: start.y },
          ...ellipseToCubics(cx, cy, rx, ry, rot, t0, full ? t0 + Math.PI * 2 : t1, true),
        ];
        if (full) d.push({ op: 'Z' });
        addStroke(layer, transformPath(d, M), stroke());
        break;
      }
      case GK.POLY: {
        const pts = readPoly(store, i);
        if (pts.length < 2) break;
        addStroke(layer, bulgePolylineToPath(pts, (fl & FLAG.CLOSED) !== 0, toPaper), stroke());
        break;
      }
      case GK.POINT: {
        const [x, y] = toPaper({ x: g[o], y: g[o + 1] });
        const r = 0.5;
        addStroke(
          layer,
          [
            { op: 'M', x: x - r, y },
            { op: 'L', x: x + r, y },
            { op: 'M', x, y: y - r },
            { op: 'L', x, y: y + r },
          ],
          { color, width: Math.min(width, 0.18), cap: 'butt' },
        );
        break;
      }
      case GK.FILL: {
        const rings = readRings(store, i);
        const d: PathCmd[] = [];
        for (const ring of rings) if (ring.length >= 2) d.push(...bulgePolylineToPath(ring, true, toPaper));
        if (!d.length) break;
        if (fl & FLAG.PATTERN) {
          // Pattern hatch: the boundary here; pattern lines are separate (DERIVED) line entities.
          addStroke(layer, d, stroke());
        } else {
          const fill: FillStyle = { color, rule: 'evenodd' };
          bucket(layer).fills.push({ kind: 'path', d, fill });
        }
        break;
      }
      case GK.TEXT: {
        const ti = store.textIndex[i];
        const text = ti >= 0 ? store.texts[ti] : '';
        if (!text || !text.trim()) break;
        const h = g[o + 2] * unitMm;
        if (!(h > 0.01)) break;
        const [x, y] = toPaper({ x: g[o], y: g[o + 1] });
        const item: TextItem = {
          kind: 'text',
          text,
          x,
          y,
          size: h * CAD_TEXT_EM,
          font: 'sans',
          color,
          anchor: textAnchor(g[o + 5]),
          baseline: textBaseline(g[o + 6]),
        };
        const rot = g[o + 3] + textRot;
        if (Math.abs(rot) > 1e-12) item.rotation = rot;
        const b = bucket(layer);
        b.strokes.push(item);
        b.batch = null;
        break;
      }
    }
  }
  if (!buckets.size) return null;
  const layerName = (i: number) => store.layers[i]?.name ?? `Layer ${i}`;
  const layerIds = [...buckets.keys()].sort((a, b) => a - b);
  const children: SceneItem[] = [];
  // Fills first (under every line, as on screen), then lines and text, each per source layer.
  for (const l of layerIds) {
    const b = buckets.get(l)!;
    if (b.fills.length) children.push({ kind: 'group', name: layerName(l), layer: true, children: b.fills });
  }
  for (const l of layerIds) {
    const b = buckets.get(l)!;
    if (b.strokes.length)
      children.push({ kind: 'group', name: layerName(l), layer: true, children: b.strokes });
  }
  const group: GroupItem = { kind: 'group', name: d.name, layer: true, children };
  if (d.opacity < 1) group.opacity = Math.max(0, d.opacity);
  return group;
}

/** Embedded PDF page of a PDF drawing (vector in the PDF backend; rasterised elsewhere). */
export function pdfDrawingGroup(
  d: Drawing,
  input: DrawingSceneInput,
  ctx: UnderlayContext,
): { group: GroupItem; item: PdfPageItem } | null {
  const pdf = input.pdf;
  if (!pdf) return null;
  const placement = placementOf(d, input.insunits);
  const M = multiply(ctx.paperFromWorld, placement);
  const transform = multiply(M, pdf.userToDrawing);
  const item: PdfPageItem = {
    kind: 'pdfPage',
    bytes: pdf.bytes ?? new Uint8Array(0),
    pageIndex: pdf.pageIndex,
    transform,
  };
  if (d.opacity < 1) item.opacity = Math.max(0, d.opacity);
  const hidden = d.hiddenSourceLayers
    .map((id) => pdf.ocgNames?.[id] ?? id)
    .filter((n, i, a) => n && a.indexOf(n) === i);
  if (hidden.length) item.hiddenLayers = hidden;
  const children: SceneItem[] = [item];
  if (d.ghost) {
    // Ghosted page: wash towards white (as on a light canvas).
    const corners: [number, number][] = [
      [0, 0],
      [pdf.widthPt, 0],
      [pdf.widthPt, pdf.heightPt],
      [0, pdf.heightPt],
    ].map(([x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]);
    children.push({
      kind: 'path',
      d: [
        { op: 'M', x: corners[0][0], y: corners[0][1] },
        ...corners.slice(1).map(([x, y]) => ({ op: 'L' as const, x, y })),
        { op: 'Z' },
      ],
      fill: { color: '#ffffff', opacity: 0.55 * Math.max(0, Math.min(1, d.opacity)) },
    });
  }
  return { group: { kind: 'group', name: d.name, layer: true, children }, item };
}

/** World bounds of a drawing (extents through its placement). */
export function drawingWorldBounds(d: Drawing, input: DrawingSceneInput): Bounds | null {
  const placement = placementOf(d, input.insunits);
  if (input.pdf)
    return transformBounds(placement, {
      minX: 0,
      minY: 0,
      maxX: input.pdf.widthPt,
      maxY: input.pdf.heightPt,
    });
  if (input.extents && Number.isFinite(input.extents.minX)) return transformBounds(placement, input.extents);
  return null;
}
