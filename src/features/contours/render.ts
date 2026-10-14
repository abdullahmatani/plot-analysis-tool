import type { Bounds, ContourDataset, Geometry, Project } from '@/core/types';
import { expand, intersects } from '@/features/objects/geometry-cache';
import { dashMm, fontFamily, hexToRgba, PX_PER_MM } from '@/features/objects/style';
import { registerOverlay } from '@/render/canvas-controller';
import { traceGeometry } from '@/render/draw-geometry';
import { visibleWorldBounds } from '@/render/view';
import { getProject } from '@/store/project';
import type { FrameInfo } from '@/tools/types';

import {
  datasetContours,
  datasetEnvelopes,
  ringsHiddenByEnvelope,
  visibleDatasets,
  type ContourRing,
  type ContourStyle,
} from './compute';
import { layoutLabels, type LabelInput } from './labels';
import { useContoursUi } from './store';

/**
 * Contour overlays (rows 65–71, 74): ring sets at z 25 (between analysis objects at 20 and object
 * labels at 30), contour labels at z 32 and the row ↔ contour highlight at z 61. Only rings whose
 * bounds intersect the visible area are drawn; widths and dashes are paper millimetres like analysis
 * objects; everything is recomputed from the dataset (memoised), so re-binding never flickers.
 */

const MAX_LABELS = 1500;

/** Adds a ring outline to the current path. Circles use arc() (the view is a similarity). */
function pathGeometry(g: CanvasRenderingContext2D, geom: Geometry, f: FrameInfo) {
  if (geom.type === 'circle') {
    const rPx = geom.r * f.scale;
    if (rPx < 1e5) {
      const s = f.toScreen(geom.c);
      g.moveTo(s.x + rPx, s.y);
      g.arc(s.x, s.y, Math.max(0.5, rPx), 0, Math.PI * 2);
      return;
    }
  }
  traceGeometry(g, geom, f.toScreen, f.scale);
}

class StyleState {
  private fill = '';
  private stroke = '';
  private width = -1;
  private dash = '';
  constructor(private g: CanvasRenderingContext2D) {}
  setFill(c: string) {
    if (c !== this.fill) this.g.fillStyle = this.fill = c;
  }
  setStroke(st: ContourStyle, widthScale = 1) {
    const c = hexToRgba(st.stroke, 1);
    if (c !== this.stroke) this.g.strokeStyle = this.stroke = c;
    const w = Math.max(1, st.strokeWidth * PX_PER_MM * widthScale);
    if (w !== this.width) this.g.lineWidth = this.width = w;
    const key = `${st.dash}|${st.strokeWidth}`;
    if (key !== this.dash) {
      this.dash = key;
      this.g.setLineDash(dashMm(st.dash, st.strokeWidth).map((v) => v * PX_PER_MM));
    }
  }
}

function visibleArea(f: FrameInfo): Bounds {
  return expand(visibleWorldBounds(f.view, f.width, f.height), 20 / f.scale);
}

function drawRings(g: CanvasRenderingContext2D, f: FrameInfo, p: Project) {
  const vis = visibleArea(f);
  const st = new StyleState(g);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const ds of visibleDatasets(p)) {
    const dc = datasetContours(p, ds);
    if (!ringsHiddenByEnvelope(ds)) {
      for (const r of dc.rings) {
        if (!intersects(r.bounds, vis)) continue;
        g.beginPath();
        pathGeometry(g, r.geometry, f);
        if (r.style.fillOpacity > 0) {
          st.setFill(hexToRgba(r.style.fill, r.style.fillOpacity));
          g.fill();
        }
        st.setStroke(r.style);
        g.stroke();
      }
    }
    for (const env of datasetEnvelopes(p, ds)) {
      if (!env.geometry) continue;
      g.beginPath();
      pathGeometry(g, env.geometry, f);
      if (env.style.fillOpacity > 0) {
        st.setFill(hexToRgba(env.style.fill, env.style.fillOpacity));
        g.fill('evenodd');
      }
      st.setStroke(env.style);
      g.stroke();
    }
  }
  g.setLineDash([]);
}

/** World "radius" of a ring towards its top (circle r, square half side, rectangle h/2 + r). */
function topReach(r: ContourRing): number {
  return r.bounds.maxY - r.item.centre.y;
}

function drawLabels(g: CanvasRenderingContext2D, f: FrameInfo, p: Project) {
  const inputs: LabelInput[] = [];
  const meta: { ring: ContourRing; ds: ContourDataset; color: string; halo: boolean }[] = [];
  const vp = { x0: 0, y0: 0, x1: f.width, y1: f.height };
  const vis = visibleArea(f);
  let minH = Infinity;
  for (const ds of visibleDatasets(p)) {
    if (ringsHiddenByEnvelope(ds)) continue;
    const dc = datasetContours(p, ds);
    const ls = dc.labelStyle;
    if (!ls.visible) continue;
    const h = ls.size * PX_PER_MM;
    if (h < 3) continue;
    minH = Math.min(minH, h);
    for (const r of dc.rings) {
      if (!r.label || !intersects(r.bounds, vis)) continue;
      inputs.push({
        id: meta.length,
        text: r.label.replace(/\s*\n\s*/g, ' '),
        centre: f.toScreen(r.item.centre),
        r: topReach(r) * f.scale,
        placement: ds.labelPlacement,
        height: h,
      });
      meta.push({ ring: r, ds, color: ls.color ?? r.style.stroke, halo: ls.halo });
    }
  }
  if (!inputs.length) return;
  const font = (h: number) => `500 ${h}px ${fontFamily('sans')}`;
  let lastFont = '';
  const placed = layoutLabels(
    inputs,
    (text, h) => {
      const fs = font(h);
      if (fs !== lastFont) g.font = lastFont = fs;
      return g.measureText(text).width;
    },
    { height: minH, viewport: vp, maxLabels: MAX_LABELS },
  );
  const halo = f.lightBg ? 'rgba(255,255,255,0.92)' : 'rgba(11,15,20,0.88)';
  for (const l of placed) {
    const m = meta[l.id];
    const h = inputs[l.id].height ?? minH;
    if (l.leader) {
      g.beginPath();
      g.moveTo(l.leader.a.x, l.leader.a.y);
      g.lineTo(l.leader.b.x, l.leader.b.y);
      g.strokeStyle = m.color;
      g.lineWidth = 1;
      g.stroke();
      g.beginPath();
      g.arc(l.leader.a.x, l.leader.a.y, 2, 0, Math.PI * 2);
      g.fillStyle = m.color;
      g.fill();
    }
    const fs = font(h);
    if (fs !== lastFont) g.font = lastFont = fs;
    g.textAlign = l.align;
    g.textBaseline = l.baseline;
    g.direction = /[֐-ࣿיִ-ﻼ]/.test(l.text) ? 'rtl' : 'ltr';
    if (m.halo) {
      g.strokeStyle = halo;
      g.lineWidth = Math.max(2, h * 0.24);
      g.lineJoin = 'round';
      g.strokeText(l.text, l.x, l.y);
    }
    g.fillStyle = labelInk(m.color, f.lightBg);
    g.fillText(l.text, l.x, l.y);
  }
  g.direction = 'ltr';
}

/** Very dark label colours are lightened on the dark canvas (and vice versa) so text stays legible. */
function labelInk(color: string, lightBg: boolean): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  if (lightBg) return lum > 0.85 ? '#111827' : color;
  // Dark canvas: mix towards white so saturated mid-tones stay legible (the halo is dark).
  const k = lum < 0.18 ? 0.75 : 0.4;
  const mix = rgb.map((c) => Math.round(c + (255 - c) * k));
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
}

function drawHighlight(g: CanvasRenderingContext2D, f: FrameInfo, p: Project) {
  const { hover, selection } = useContoursUi.getState();
  if (!hover && !selection) return;
  const vis = visibleArea(f);
  for (const ds of visibleDatasets(p)) {
    const sel = selection?.ds === ds.id ? new Set(selection.rows) : null;
    const hov = hover?.ds === ds.id ? hover.row : -1;
    if (!sel && hov < 0) continue;
    const dc = datasetContours(p, ds);
    for (const r of dc.rings) {
      const selected = sel?.has(r.row) ?? false;
      if (!selected && r.row !== hov) continue;
      if (!intersects(r.bounds, vis)) continue;
      g.beginPath();
      pathGeometry(g, r.geometry, f);
      g.setLineDash(selected ? [6, 4] : []);
      g.strokeStyle = selected ? '#3b82f6' : 'rgba(59,130,246,0.75)';
      g.lineWidth = selected ? 2.5 : 3.5;
      g.stroke();
    }
    // Centre marker of highlighted rows.
    g.setLineDash([]);
    g.fillStyle = '#3b82f6';
    const done = new Set<number>();
    for (const r of dc.rings) {
      if (done.has(r.row) || (!(sel?.has(r.row) ?? false) && r.row !== hov)) continue;
      done.add(r.row);
      const s = f.toScreen(r.item.centre);
      g.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
  }
}

export function registerContourOverlays(): () => void {
  const wrap =
    (fn: (g: CanvasRenderingContext2D, f: FrameInfo, p: Project) => void) =>
    (g: CanvasRenderingContext2D, f: FrameInfo) => {
      const p = getProject();
      if (p && p.datasets.length) fn(g, f, p);
    };
  const un = [
    registerOverlay(25, wrap(drawRings)),
    registerOverlay(32, wrap(drawLabels)),
    registerOverlay(61, wrap(drawHighlight)),
  ];
  return () => un.forEach((u) => u());
}
