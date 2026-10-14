import type { AnalysisObject, ObjectKind, Project, Style } from '@/core/types';
import { add } from '@/geometry/vec';
import { isClosedGeometry, traceGeometry } from '@/render/draw-geometry';
import { registerOverlay } from '@/render/canvas-controller';
import { visibleWorldBounds } from '@/render/view';
import { getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import type { FrameInfo } from '@/tools/types';

import { expand, geomBounds, intersects } from './geometry-cache';
import { labelAnchor, labelText } from './labels';
import { dashMm, fontFamily, hatchPattern, hexToRgba, labelHeightPx, PX_PER_MM, resolveStyle } from './style';

/**
 * Analysis-object overlay (rows 37–41): fills/hatches with opacity, strokes with dash styles and
 * paper-mm widths, labels with halos and leaders, selection highlight and grips. Draw order follows
 * layer order (first layer at the bottom), then object order within the project.
 */

export type KindRenderer = (
  g: CanvasRenderingContext2D,
  o: AnalysisObject,
  s: Style,
  f: FrameInfo,
  p: Project,
) => void;

/** Special renderers per object kind (e.g. measurements, callouts, tags), registered by features. */
export const kindRenderers: Partial<Record<ObjectKind, KindRenderer>> = {};

export function strokeStyleFor(g: CanvasRenderingContext2D, s: Style) {
  g.strokeStyle = hexToRgba(s.stroke, s.strokeOpacity);
  g.lineWidth = Math.max(1, s.strokeWidth * PX_PER_MM);
  g.setLineDash(dashMm(s.dash, s.strokeWidth).map((v) => v * PX_PER_MM));
  g.lineCap = 'round';
  g.lineJoin = 'round';
}

export function drawShape(g: CanvasRenderingContext2D, o: AnalysisObject, s: Style, f: FrameInfo) {
  const geom = o.geometry;
  g.beginPath();
  traceGeometry(g, geom, f.toScreen, f.scale);
  if (isClosedGeometry(geom) && s.hatch !== 'none' && s.fillOpacity > 0) {
    const rule: CanvasFillRule = geom.type === 'multipolygon' ? 'evenodd' : 'nonzero';
    if (s.hatch === 'solid') {
      g.fillStyle = hexToRgba(s.fill, s.fillOpacity);
      g.fill(rule);
    } else {
      // Light tint plus the hatch lines so overlapping highlights stay distinguishable (row 39).
      g.fillStyle = hexToRgba(s.fill, s.fillOpacity * 0.35);
      g.fill(rule);
      const pat = hatchPattern(g, s.hatch, s.fill, s.fillOpacity);
      if (pat) {
        g.fillStyle = pat;
        g.fill(rule);
      }
    }
  }
  if (s.strokeOpacity > 0 && s.strokeWidth > 0) {
    strokeStyleFor(g, s);
    g.stroke();
  }
  g.setLineDash([]);
}

export function drawLabelText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  s: Style,
  f: FrameInfo,
  align: CanvasTextAlign = 'center',
  baseline: CanvasTextBaseline = 'middle',
  rotation = 0,
) {
  const h = labelHeightPx(s, f.scale);
  if (h < 3 || !text) return;
  g.save();
  g.translate(x, y);
  if (rotation) g.rotate(-rotation);
  g.font = `${s.labelBold ? 700 : 400} ${h}px ${fontFamily(s.labelFont)}`;
  g.textAlign = align;
  g.textBaseline = baseline;
  g.direction = /[֐-ࣿיִ-ﻼ]/.test(text) ? 'rtl' : 'ltr';
  const lines = text.split('\n');
  const lh = h * 1.25;
  const y0 =
    baseline === 'middle'
      ? (-(lines.length - 1) * lh) / 2
      : baseline === 'bottom'
        ? -(lines.length - 1) * lh
        : 0;
  if (s.labelHalo) {
    g.strokeStyle = f.lightBg ? 'rgba(255,255,255,0.9)' : 'rgba(11,15,20,0.85)';
    g.lineWidth = Math.max(2, h * 0.22);
    g.lineJoin = 'round';
    lines.forEach((l, i) => g.strokeText(l, 0, y0 + i * lh));
  }
  g.fillStyle = s.labelColor === '#111827' && !f.lightBg ? '#f3f4f6' : s.labelColor;
  lines.forEach((l, i) => g.fillText(l, 0, y0 + i * lh));
  g.restore();
}

function visibleObjects(project: Project, f: FrameInfo): AnalysisObject[] {
  const vis = expand(visibleWorldBounds(f.view, f.width, f.height), 50 / f.scale);
  const layerOrder = new Map(project.layers.map((l, i) => [l.id, i]));
  const hidden = new Set(project.layers.filter((l) => !l.visible).map((l) => l.id));
  return project.objects
    .filter((o) => !hidden.has(o.layerId) && intersects(geomBounds(o.geometry), vis))
    .sort((a, b) => (layerOrder.get(a.layerId) ?? 0) - (layerOrder.get(b.layerId) ?? 0));
}

export function registerObjectOverlays() {
  const un1 = registerOverlay(20, (g, f) => {
    const p = getProject();
    if (!p) return;
    for (const o of visibleObjects(p, f)) {
      const s = resolveStyle(p, o);
      const r = kindRenderers[o.kind];
      if (r) r(g, o, s, f, p);
      else drawShape(g, o, s, f);
    }
  });
  const un2 = registerOverlay(30, (g, f) => {
    const p = getProject();
    if (!p) return;
    for (const o of visibleObjects(p, f)) {
      if (!o.label?.visible) continue;
      const text = labelText(p, o);
      if (!text) continue;
      const s = resolveStyle(p, o);
      const anchor = labelAnchor(o);
      const at = o.label.offset ? add(anchor, o.label.offset) : anchor;
      const sp = f.toScreen(at);
      if (o.label.placement === 'leader' && o.label.offset) {
        const a = f.toScreen(anchor);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(sp.x, sp.y);
        g.strokeStyle = hexToRgba(s.stroke, 0.9);
        g.lineWidth = 1;
        g.stroke();
        g.beginPath();
        g.arc(a.x, a.y, 2.5, 0, Math.PI * 2);
        g.fillStyle = s.stroke;
        g.fill();
      }
      const baseline = o.label.placement === 'top' ? 'bottom' : 'middle';
      drawLabelText(g, text, sp.x, sp.y - (o.label.placement === 'top' ? 3 : 0), s, f, 'center', baseline);
    }
  });
  const un3 = registerOverlay(60, (g, f) => {
    const p = getProject();
    const sel = useViewStore.getState().selection;
    const hover = useViewStore.getState().hoverObject;
    if (!p) return;
    const ids = new Set(sel);
    for (const o of p.objects) {
      const selected = ids.has(o.id);
      if (!selected && o.id !== hover) continue;
      g.beginPath();
      traceGeometry(g, o.geometry, f.toScreen, f.scale);
      g.setLineDash(selected ? [6, 4] : []);
      g.strokeStyle = selected ? '#3b82f6' : 'rgba(59,130,246,0.7)';
      g.lineWidth = selected ? 2 : 3;
      g.stroke();
      g.setLineDash([]);
    }
  });
  return () => {
    un1();
    un2();
    un3();
  };
}
