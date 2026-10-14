import { apply } from '@/core/affine';
import type { Affine2D, AnalysisObject, Bounds, Geometry, ObjectKind, Project, Style } from '@/core/types';
import {
  arcToCubics,
  bulgePolylineToPath,
  circlePath,
  ellipsePath,
  polylinePath,
  transformPath,
  type FillStyle,
  type PathCmd,
  type SceneItem,
  type StrokeStyle,
  type TextItem,
} from '@/export/scene';
import { rectCorners } from '@/geometry/convert';
import { add } from '@/geometry/vec';
import { geomBounds, intersects } from '@/features/objects/geometry-cache';
import { labelAnchor, labelText } from '@/features/objects/labels';
import { dashMm, resolveStyle } from '@/features/objects/style';

/**
 * Analysis objects on the sheet (rows 37–42, 77): the same style resolution, fills, hatches, dash
 * patterns (paper mm), labels with halos and leaders as the canvas overlay
 * (`features/objects/render.ts`), drawn as exact vectors (arcs and circles as Bézier curves).
 */

/** Hatch line spacing and width on paper (mm). */
export const HATCH_SPACING_MM = 2.5;
export const HATCH_LINE_MM = 0.18;
/** Leader line width and end-dot radius (mm). */
const LEADER_WIDTH_MM = 0.25;
const LEADER_DOT_MM = 0.6;
/** Half-size of the point marker (mm). */
const POINT_MARK_MM = 1.5;

export interface ObjectSceneContext {
  project: Project;
  paperFromWorld: Affine2D;
  /** Paper mm per world metre. */
  mmPerMetre: number;
}

export interface ObjectItems {
  shapes: SceneItem[];
  labels: SceneItem[];
}

/**
 * Export renderers per object kind (the export counterpart of `kindRenderers`). Return null to fall
 * back to the default shape + label drawing. Must be registered from a module the export worker
 * imports (e.g. this one), since the worker has its own module instances.
 */
export type ExportKindRenderer = (o: AnalysisObject, s: Style, ctx: ObjectSceneContext) => ObjectItems | null;
export const exportKindRenderers: Partial<Record<ObjectKind, ExportKindRenderer>> = {};

export interface PaperPath {
  d: PathCmd[];
  closed: boolean;
  evenodd: boolean;
}

/** Geometry (world metres) → paper path through the world → paper similarity `M`. */
export function geometryPaperPath(g: Geometry, M: Affine2D): PaperPath {
  const toPaper = (p: { x: number; y: number }): [number, number] => {
    const q = apply(M, p);
    return [q.x, q.y];
  };
  const k = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
  switch (g.type) {
    case 'circle': {
      const c = apply(M, g.c);
      return { d: circlePath(c.x, c.y, Math.abs(g.r) * k), closed: true, evenodd: false };
    }
    case 'arc': {
      const r = Math.abs(g.r);
      const d: PathCmd[] = [
        { op: 'M', x: g.c.x + r * Math.cos(g.a0), y: g.c.y + r * Math.sin(g.a0) },
        ...arcToCubics(g.c.x, g.c.y, r, g.a0, g.a1, true),
      ];
      return { d: transformPath(d, M), closed: false, evenodd: false };
    }
    case 'rect':
      return { d: polylinePath(rectCorners(g).map(toPaper), true), closed: true, evenodd: false };
    case 'ellipse':
      return {
        d: transformPath(ellipsePath(g.c.x, g.c.y, g.rx, g.ry, g.rot), M),
        closed: true,
        evenodd: false,
      };
    case 'polyline':
      return {
        d: g.pts.length >= 2 ? bulgePolylineToPath(g.pts, g.closed, toPaper) : [],
        closed: g.closed,
        evenodd: false,
      };
    case 'multipolygon': {
      const d: PathCmd[] = [];
      for (const ring of g.rings) if (ring.length >= 2) d.push(...bulgePolylineToPath(ring, true, toPaper));
      return { d, closed: true, evenodd: true };
    }
    case 'point': {
      const [x, y] = toPaper(g.p);
      const r = POINT_MARK_MM;
      return {
        d: [
          { op: 'M', x: x - r, y },
          { op: 'L', x: x + r, y },
          { op: 'M', x, y: y - r },
          { op: 'L', x, y: y + r },
        ],
        closed: false,
        evenodd: false,
      };
    }
  }
}

export function objectStroke(s: Style): StrokeStyle | undefined {
  if (!(s.strokeOpacity > 0 && s.strokeWidth > 0)) return undefined;
  const st: StrokeStyle = { color: s.stroke, width: s.strokeWidth, cap: 'round', join: 'round' };
  if (s.strokeOpacity < 1) st.opacity = s.strokeOpacity;
  const dash = dashMm(s.dash, s.strokeWidth);
  if (dash.length) st.dash = dash;
  return st;
}

/** Fill with the same tint/hatch logic as the canvas overlay (hatches keep a light tint underneath). */
export function objectFill(s: Style, evenodd: boolean): FillStyle | undefined {
  if (s.hatch === 'none' || !(s.fillOpacity > 0)) return undefined;
  const rule = evenodd ? 'evenodd' : 'nonzero';
  if (s.hatch === 'solid') return { color: s.fill, opacity: s.fillOpacity, rule };
  return {
    color: s.fill,
    opacity: s.fillOpacity * 0.35,
    rule,
    hatch: {
      pattern: s.hatch,
      spacing: HATCH_SPACING_MM,
      lineWidth: HATCH_LINE_MM,
      color: s.fill,
      opacity: Math.min(1, s.fillOpacity * 3 + 0.25),
    },
  };
}

/** Label text size on paper (mm). */
export function labelSizeMm(s: Style, mmPerMetre: number): number {
  return s.labelSizeUnit === 'world' ? s.labelSize * mmPerMetre : s.labelSize;
}

export function labelHalo(size: number): { color: string; width: number } {
  return { color: '#ffffff', width: Math.max(0.3, size * 0.22) };
}

/** Default drawing of one object: its shape, and its label (with leader) separately. */
export function objectItems(o: AnalysisObject, s: Style, ctx: ObjectSceneContext): ObjectItems {
  const custom = exportKindRenderers[o.kind]?.(o, s, ctx);
  if (custom) return custom;
  const out: ObjectItems = { shapes: [], labels: [] };
  const M = ctx.paperFromWorld;
  const path = geometryPaperPath(o.geometry, M);
  if (path.d.length) {
    const fill = path.closed ? objectFill(s, path.evenodd) : undefined;
    let stroke = objectStroke(s);
    if (o.geometry.type === 'point')
      stroke = { color: s.stroke, width: Math.max(0.18, s.strokeWidth), cap: 'butt' };
    if (fill || stroke) {
      const item: SceneItem = { kind: 'path', d: path.d };
      if (stroke) item.stroke = stroke;
      if (fill) item.fill = fill;
      out.shapes.push(item);
    }
  }
  if (o.label?.visible) {
    const text = labelText(ctx.project, o);
    if (text) {
      const anchor = labelAnchor(o);
      const at = o.label.offset ? add(anchor, o.label.offset) : anchor;
      const p = apply(M, at);
      if (o.label.placement === 'leader' && o.label.offset) {
        const a = apply(M, anchor);
        out.labels.push({
          kind: 'path',
          d: [
            { op: 'M', x: a.x, y: a.y },
            { op: 'L', x: p.x, y: p.y },
          ],
          stroke: { color: s.stroke, width: LEADER_WIDTH_MM, opacity: 0.9, cap: 'round' },
        });
        out.labels.push({ kind: 'path', d: circlePath(a.x, a.y, LEADER_DOT_MM), fill: { color: s.stroke } });
      }
      const size = labelSizeMm(s, ctx.mmPerMetre);
      const top = o.label.placement === 'top';
      const item: TextItem = {
        kind: 'text',
        text,
        x: p.x,
        y: p.y - (top ? 0.8 : 0),
        size,
        font: s.labelFont,
        color: s.labelColor,
        anchor: 'middle',
        baseline: top ? 'bottom' : 'middle',
      };
      if (s.labelBold) item.bold = true;
      if (s.labelHalo) item.halo = labelHalo(size);
      out.labels.push(item);
    }
  }
  return out;
}

export interface LayerItems {
  layerId: string;
  name: string;
  shapes: SceneItem[];
  labels: SceneItem[];
}

/**
 * Items per visible analysis layer in draw order (first layer at the bottom, then object order).
 * Objects whose bounds miss `cull` (world) are skipped.
 */
export function analysisLayerItems(ctx: ObjectSceneContext, cull: Bounds | null): LayerItems[] {
  const { project } = ctx;
  const out: LayerItems[] = [];
  for (const layer of project.layers) {
    if (!layer.visible) continue;
    const li: LayerItems = { layerId: layer.id, name: layer.name, shapes: [], labels: [] };
    for (const o of project.objects) {
      if (o.layerId !== layer.id) continue;
      if (cull && !intersects(geomBounds(o.geometry), cull)) continue;
      const items = objectItems(o, resolveStyle(project, o), ctx);
      li.shapes.push(...items.shapes);
      li.labels.push(...items.labels);
    }
    if (li.shapes.length || li.labels.length) out.push(li);
  }
  return out;
}
