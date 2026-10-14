import { apply } from '@/core/affine';
import type { AnalysisObject, Geometry, Pt, Style } from '@/core/types';
import { circlePath, type PathCmd, type SceneItem, type TextItem } from '@/export/scene';
import { centroid } from '@/geometry/measure';
import { layerOf } from '@/features/objects/style';
import { annotationLines, modeForGeometry } from '@/features/measure/compute';

import {
  exportKindRenderers,
  geometryPaperPath,
  labelHalo,
  labelSizeMm,
  type ObjectItems,
  type ObjectSceneContext,
} from './objects';

/**
 * Export drawing of annotation kinds — free text, leader callouts and bubble tags (row 41) and
 * measurement annotations (row 35) — matching their canvas renderers. Text widths are estimated
 * from the font size (the backends shape and place the actual glyphs).
 */

const LINE_MM = 0.25;
/** Average advance of the bundled sans font as a fraction of the font size. */
const CHAR_EM = 0.56;

function textWidthMm(text: string, size: number): number {
  return Math.max(...text.split('\n').map((l) => l.length), 1) * size * CHAR_EM;
}

function textItem(text: string, p: Pt, s: Style, size: number, extra: Partial<TextItem> = {}): TextItem {
  const t: TextItem = {
    kind: 'text',
    text,
    x: p.x,
    y: p.y,
    size,
    font: s.labelFont,
    color: s.labelColor,
    anchor: 'start',
    baseline: 'top',
    ...extra,
  };
  if (s.labelBold) t.bold = true;
  if (s.labelHalo && !extra.halo) t.halo = labelHalo(size);
  return t;
}

const line = (a: Pt, b: Pt): PathCmd[] => [
  { op: 'M', x: a.x, y: a.y },
  { op: 'L', x: b.x, y: b.y },
];

function arrowHead(tip: Pt, from: Pt, len: number): PathCmd[] {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  return [
    { op: 'M', x: tip.x, y: tip.y },
    { op: 'L', x: tip.x - len * Math.cos(a - 0.4), y: tip.y - len * Math.sin(a - 0.4) },
    { op: 'L', x: tip.x - len * Math.cos(a + 0.4), y: tip.y - len * Math.sin(a + 0.4) },
    { op: 'Z' },
  ];
}

const boxFill = (s: Style) => (s.hatch !== 'none' && s.fillOpacity > 0 ? s.fill : '#ffffff');

function text(o: AnalysisObject, s: Style, ctx: ObjectSceneContext): ObjectItems | null {
  if (o.geometry.type !== 'point' || !o.text) return null;
  const size = labelSizeMm(s, ctx.mmPerMetre);
  const p = apply(ctx.paperFromWorld, o.geometry.p);
  const out: ObjectItems = { shapes: [], labels: [] };
  if (s.hatch !== 'none' && s.fillOpacity > 0) {
    const pad = size * 0.3;
    const w = textWidthMm(o.text, size) + 2 * pad;
    const h = o.text.split('\n').length * size * 1.2 + 2 * pad;
    out.labels.push({
      kind: 'path',
      d: rect(p.x - pad, p.y - pad, w, h),
      fill: { color: boxFill(s), opacity: s.fillOpacity },
    });
  }
  out.labels.push(textItem(o.text, p, s, size));
  return out;
}

function rect(x: number, y: number, w: number, h: number): PathCmd[] {
  return [
    { op: 'M', x, y },
    { op: 'L', x: x + w, y },
    { op: 'L', x: x + w, y: y + h },
    { op: 'L', x, y: y + h },
    { op: 'Z' },
  ];
}

function callout(o: AnalysisObject, s: Style, ctx: ObjectSceneContext): ObjectItems | null {
  const g = o.geometry;
  if (g.type !== 'polyline' || g.pts.length < 2) return null;
  const size = labelSizeMm(s, ctx.mmPerMetre);
  const tip = apply(ctx.paperFromWorld, g.pts[0]);
  const knee = apply(ctx.paperFromWorld, g.pts[g.pts.length - 1]);
  const body = o.text ?? '';
  const pad = Math.max(0.6, size * 0.35);
  const w = textWidthMm(body || ' ', size) + 2 * pad;
  const h = Math.max(1, body.split('\n').length) * size * 1.2 + 2 * pad;
  const dir = knee.x >= tip.x ? 1 : -1;
  const shoulder = size * 0.6;
  const x0 = dir === 1 ? knee.x + shoulder : knee.x - shoulder - w;
  const edge = { x: dir === 1 ? x0 : x0 + w, y: knee.y };
  const stroke = { color: s.stroke, width: Math.max(LINE_MM, s.strokeWidth), cap: 'round' as const };
  const out: ObjectItems = { shapes: [], labels: [] };
  out.labels.push({ kind: 'path', d: [...line(tip, knee), { op: 'L', x: edge.x, y: edge.y }], stroke });
  out.labels.push({
    kind: 'path',
    d: arrowHead(tip, knee, Math.max(1.6, size * 0.8)),
    fill: { color: s.stroke },
  });
  out.labels.push({ kind: 'path', d: rect(x0, knee.y - h / 2, w, h), fill: { color: boxFill(s) }, stroke });
  if (body)
    out.labels.push(
      textItem(body, { x: x0 + pad, y: knee.y - h / 2 + pad }, { ...s, labelHalo: false }, size),
    );
  return out;
}

function tag(o: AnalysisObject, s: Style, ctx: ObjectSceneContext): ObjectItems | null {
  const g = o.geometry;
  const c = g.type === 'point' ? g.p : g.type === 'polyline' && g.pts.length ? g.pts[g.pts.length - 1] : null;
  if (!c) return null;
  const label = `${layerOf(ctx.project, o)?.tagPrefix ?? ''}${o.tagNumber ?? '?'}`;
  const size = labelSizeMm(s, ctx.mmPerMetre);
  const r = Math.max(size * 0.95, textWidthMm(label, size) / 2 + size * 0.45);
  const pc = apply(ctx.paperFromWorld, c);
  const stroke = { color: s.stroke, width: Math.max(LINE_MM, s.strokeWidth), cap: 'round' as const };
  const out: ObjectItems = { shapes: [], labels: [] };
  if (g.type === 'polyline' && g.pts.length >= 2) {
    const t = apply(ctx.paperFromWorld, g.pts[0]);
    const d = Math.hypot(pc.x - t.x, pc.y - t.y);
    if (d > r) {
      out.labels.push({
        kind: 'path',
        d: line(t, { x: pc.x - ((pc.x - t.x) / d) * r, y: pc.y - ((pc.y - t.y) / d) * r }),
        stroke,
      });
      out.labels.push({ kind: 'path', d: circlePath(t.x, t.y, 0.6), fill: { color: s.stroke } });
    }
  }
  out.labels.push({ kind: 'path', d: circlePath(pc.x, pc.y, r), fill: { color: boxFill(s) }, stroke });
  out.labels.push(
    textItem(label, pc, { ...s, labelHalo: false }, size, { anchor: 'middle', baseline: 'middle' }),
  );
  return out;
}

/** Point where a measurement's text goes, and the text direction (paper radians). */
function measureAnchor(g: Geometry, mode: string): { at: Pt; angle: number } {
  if (g.type === 'polyline' && g.pts.length >= 2) {
    if (mode === 'angle' && g.pts.length >= 3) return { at: g.pts[1], angle: 0 };
    if (mode === 'area' || g.closed) return { at: centroid(g), angle: 0 };
    const a = g.pts[g.pts.length - 2];
    const b = g.pts[g.pts.length - 1];
    return { at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  if (g.type === 'circle' || g.type === 'arc') return { at: g.c, angle: 0 };
  if (g.type === 'point') return { at: g.p, angle: 0 };
  return { at: centroid(g), angle: 0 };
}

function measurement(o: AnalysisObject, s: Style, ctx: ObjectSceneContext): ObjectItems | null {
  const mode = o.measurement?.mode ?? modeForGeometry(o.geometry);
  const lines = annotationLines(ctx.project, o);
  const M = ctx.paperFromWorld;
  const out: ObjectItems = { shapes: [], labels: [] };
  const path = geometryPaperPath(o.geometry, M);
  const stroke = { color: s.stroke, width: Math.max(LINE_MM, s.strokeWidth * 0.7), cap: 'butt' as const };
  if (path.d.length && o.geometry.type !== 'point') {
    const item: SceneItem = { kind: 'path', d: path.d, stroke };
    if (path.closed && s.hatch !== 'none' && s.fillOpacity > 0)
      item.fill = { color: s.fill, opacity: s.fillOpacity * 0.5 };
    out.shapes.push(item);
  }
  // End ticks on distance-like measurements.
  if (o.geometry.type === 'polyline' && !o.geometry.closed && mode !== 'angle') {
    const tick = 1.2;
    for (const w of o.geometry.pts) {
      const p = apply(M, w);
      out.shapes.push({
        kind: 'path',
        d: [...line({ x: p.x - tick, y: p.y + tick }, { x: p.x + tick, y: p.y - tick })],
        stroke,
      });
    }
  }
  if (o.geometry.type === 'point') {
    const p = apply(M, o.geometry.p);
    out.shapes.push({
      kind: 'path',
      d: [
        ...line({ x: p.x - 1.5, y: p.y }, { x: p.x + 1.5, y: p.y }),
        ...line({ x: p.x, y: p.y - 1.5 }, { x: p.x, y: p.y + 1.5 }),
      ],
      stroke,
    });
  }
  const { at, angle } = measureAnchor(o.geometry, mode);
  const p = apply(M, at);
  // Paper is y-down: a world angle θ appears as −θ after the (rotation-only) world→paper map.
  const worldDir = { x: Math.cos(angle), y: Math.sin(angle) };
  const pd = { x: M[0] * worldDir.x + M[2] * worldDir.y, y: M[1] * worldDir.x + M[3] * worldDir.y };
  let rot = -Math.atan2(pd.y, pd.x);
  if (rot > Math.PI / 2) rot -= Math.PI;
  if (rot < -Math.PI / 2) rot += Math.PI;
  const size = Math.max(1.8, labelSizeMm(s, ctx.mmPerMetre) * 1.1);
  out.labels.push(
    textItem(lines.join('\n'), p, { ...s, labelColor: s.stroke }, size, {
      anchor: 'middle',
      baseline: mode === 'distance' || mode === 'chain' || mode === 'length' ? 'bottom' : 'middle',
      rotation: angle ? rot : undefined,
      halo: labelHalo(size),
    }),
  );
  return out;
}

exportKindRenderers.text = text;
exportKindRenderers.callout = callout;
exportKindRenderers.tag = tag;
exportKindRenderers.measurement = measurement;
