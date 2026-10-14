import { apply } from '@/core/affine';
import type { Affine2D, Bounds, ContourDataset, Geometry } from '@/core/types';
import type { FontSet } from '@/export/fonts';
import { circlePath, type SceneItem, type TextItem } from '@/export/scene';
import { bounds as geometryBounds } from '@/geometry/measure';
import { offsetGeometry } from '@/geometry/offset';
import { dashMm } from '@/features/objects/style';
import type { ContourItem } from '@/tables/contours';

import { geometryPaperPath, labelHalo } from './objects';
import { textWidth } from './text';
import type { ContourSceneInput } from './types';

/**
 * Contour datasets on the sheet (rows 63–74, 77): rings (circle, square, W×H rectangle grown by the
 * size with round corners), dataset styles and style-rule colours, labels at the top, centre or on a
 * leader with simple collision avoidance, and envelopes.
 */

export const CONTOUR_LABEL_MM = 2.5;
const CONTOUR_LABEL_COLOR = '#111827';
const LEADER_MM = 6;

/** World geometry of a contour item (see `ContourItem` for the shapes). */
export function contourGeometry(it: ContourItem, chordTol = 0.005): Geometry {
  if (it.shape === 'circle') return { type: 'circle', c: { ...it.centre }, r: it.r };
  if (it.shape === 'square' || !(it.w && it.h))
    return { type: 'rect', c: { ...it.centre }, w: 2 * it.r, h: 2 * it.r, rot: it.rot ?? 0 };
  const base: Geometry = { type: 'rect', c: { ...it.centre }, w: it.w, h: it.h, rot: it.rot ?? 0 };
  return offsetGeometry(base, it.r, { join: 'round', chordTol }).geometry ?? base;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const overlaps = (a: Box, b: Box) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

export interface ContourSceneContext {
  paperFromWorld: Affine2D;
  fonts?: FontSet;
  chordTol: number;
  /** World cull bounds (items outside are skipped). */
  cull: Bounds | null;
}

/** Scene items of one dataset: rings, envelopes, then labels. */
export function contourDatasetItems(
  ds: ContourDataset,
  input: ContourSceneInput,
  ctx: ContourSceneContext,
): { rings: SceneItem[]; labels: SceneItem[] } {
  const M = ctx.paperFromWorld;
  const rings: SceneItem[] = [];
  const labels: SceneItem[] = [];
  const placed: Box[] = [];
  const size = CONTOUR_LABEL_MM;
  for (const it of input.items) {
    const g = contourGeometry(it, ctx.chordTol);
    const wb = geometryBounds(g);
    if (
      ctx.cull &&
      (wb.minX > ctx.cull.maxX ||
        wb.maxX < ctx.cull.minX ||
        wb.minY > ctx.cull.maxY ||
        wb.maxY < ctx.cull.minY)
    )
      continue;
    const path = geometryPaperPath(g, M);
    const item: SceneItem = {
      kind: 'path',
      d: path.d,
      stroke: { color: it.color, width: it.strokeWidth, cap: 'round', join: 'round' },
    };
    const dash = dashMm(it.dash, it.strokeWidth);
    if (dash.length) item.stroke!.dash = dash;
    if (it.fillOpacity > 0) item.fill = { color: it.color, opacity: it.fillOpacity };
    rings.push(item);
    if (!it.label) continue;
    const placement = ds.labelPlacement;
    const w = textWidth(ctx.fonts, it.label, { size });
    const h = size * 1.2;
    if (placement === 'leader') {
      const a = {
        x: it.centre.x + Math.SQRT1_2 * (wb.maxX - it.centre.x),
        y: it.centre.y + Math.SQRT1_2 * (wb.maxY - it.centre.y),
      };
      const pa = apply(M, a);
      const c = apply(M, it.centre);
      let dx = pa.x - c.x;
      let dy = pa.y - c.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const end = { x: pa.x + dx * LEADER_MM, y: pa.y + dy * LEADER_MM };
      labels.push({
        kind: 'path',
        d: [
          { op: 'M', x: pa.x, y: pa.y },
          { op: 'L', x: end.x, y: end.y },
          { op: 'L', x: end.x + (dx >= 0 ? 1.5 : -1.5), y: end.y },
        ],
        stroke: { color: it.color, width: 0.25, cap: 'round', join: 'round' },
      });
      labels.push({ kind: 'path', d: circlePath(pa.x, pa.y, 0.5), fill: { color: it.color } });
      const t: TextItem = {
        kind: 'text',
        text: it.label,
        x: end.x + (dx >= 0 ? 2 : -2),
        y: end.y,
        size,
        font: 'sans',
        color: CONTOUR_LABEL_COLOR,
        anchor: dx >= 0 ? 'start' : 'end',
        baseline: 'middle',
        halo: labelHalo(size),
      };
      labels.push(t);
      placed.push({
        minX: t.x - (dx >= 0 ? 0 : w),
        minY: t.y - h / 2,
        maxX: t.x + (dx >= 0 ? w : 0),
        maxY: t.y + h / 2,
      });
      continue;
    }
    const top = placement === 'top';
    const at = top ? { x: it.centre.x, y: wb.maxY } : it.centre;
    const p = apply(M, at);
    let y = top ? p.y - 0.8 : p.y;
    const boxAt = (yy: number): Box =>
      top
        ? { minX: p.x - w / 2, minY: yy - h, maxX: p.x + w / 2, maxY: yy }
        : { minX: p.x - w / 2, minY: yy - h / 2, maxX: p.x + w / 2, maxY: yy + h / 2 };
    // Collision avoidance with labels already placed: nudge upwards a few times.
    for (let k = 0; k < 6 && placed.some((b) => overlaps(b, boxAt(y))); k++) y -= h + 0.4;
    placed.push(boxAt(y));
    labels.push({
      kind: 'text',
      text: it.label,
      x: p.x,
      y,
      size,
      font: 'sans',
      color: CONTOUR_LABEL_COLOR,
      anchor: 'middle',
      baseline: top ? 'bottom' : 'middle',
      halo: labelHalo(size),
    });
  }
  for (const env of input.envelopes) {
    const path = geometryPaperPath(env.geometry, M);
    if (!path.d.length) continue;
    const stroke = {
      color: env.color,
      width: env.strokeWidth,
      cap: 'round' as const,
      join: 'round' as const,
    };
    const dash = dashMm(env.dash, env.strokeWidth);
    rings.push({ kind: 'path', d: path.d, stroke: dash.length ? { ...stroke, dash } : stroke });
  }
  return { rings, labels };
}
