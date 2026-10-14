import type { Geometry, Pt } from '@/core/types';
import { centroid } from '@/geometry/measure';
import { ccwSweep } from '@/geometry/vec';
import { traceGeometry } from '@/render/draw-geometry';
import type { FrameInfo } from '@/tools/types';

import type { MeasureMode } from './compute';

/**
 * Dimension-style drawing of measurements (row 35) in screen space: ticks and aligned text for
 * distances, running totals for chains, filled outlines for areas, radius leaders and angle arcs.
 */

export interface DimStyle {
  color: string;
  /** Fill for areas (rgba). */
  fill?: string;
  /** Text height in px. */
  textPx: number;
  dashed?: boolean;
  lightBg: boolean;
}

function text(
  g: CanvasRenderingContext2D,
  lines: string[],
  at: Pt,
  st: DimStyle,
  rotation = 0,
  align: CanvasTextAlign = 'center',
  baseline: CanvasTextBaseline = 'bottom',
) {
  if (!lines.length || st.textPx < 3) return;
  g.save();
  g.translate(at.x, at.y);
  if (rotation) g.rotate(rotation);
  g.font = `600 ${st.textPx}px "Inter Variable", "Noto Sans", sans-serif`;
  g.textAlign = align;
  g.textBaseline = baseline;
  const lh = st.textPx * 1.25;
  const y0 =
    baseline === 'bottom'
      ? -(lines.length - 1) * lh
      : baseline === 'middle'
        ? (-(lines.length - 1) * lh) / 2
        : 0;
  g.lineJoin = 'round';
  g.strokeStyle = st.lightBg ? 'rgba(255,255,255,0.92)' : 'rgba(11,15,20,0.88)';
  g.lineWidth = Math.max(3, st.textPx * 0.3);
  lines.forEach((l, i) => g.strokeText(l, 0, y0 + i * lh));
  g.fillStyle = st.lightBg ? '#0c4a6e' : '#e0f2fe';
  lines.forEach((l, i) => g.fillText(l, 0, y0 + i * lh));
  g.restore();
}

/** Screen rotation that keeps text along a→b readable (never upside down). */
function upright(a: Pt, b: Pt): number {
  let r = Math.atan2(b.y - a.y, b.x - a.x);
  if (r > Math.PI / 2) r -= Math.PI;
  if (r < -Math.PI / 2) r += Math.PI;
  return r;
}

function tick(g: CanvasRenderingContext2D, p: Pt, dir: Pt, len: number) {
  const nx = -dir.y;
  const ny = dir.x;
  g.moveTo(p.x - nx * len - dir.x * len * 0.6, p.y - ny * len - dir.y * len * 0.6);
  g.lineTo(p.x + nx * len + dir.x * len * 0.6, p.y + ny * len + dir.y * len * 0.6);
}

function stroke(g: CanvasRenderingContext2D, st: DimStyle, width = 1.5) {
  g.strokeStyle = st.color;
  g.lineWidth = width;
  g.setLineDash(st.dashed ? [6, 4] : []);
  g.stroke();
  g.setLineDash([]);
}

function dot(g: CanvasRenderingContext2D, p: Pt, st: DimStyle, r = 2.5) {
  g.beginPath();
  g.arc(p.x, p.y, r, 0, Math.PI * 2);
  g.fillStyle = st.color;
  g.fill();
}

function pointsOf(geom: Geometry): Pt[] {
  return geom.type === 'polyline' ? geom.pts : geom.type === 'point' ? [geom.p] : [];
}

/** Draws a measurement; `lines` is its text (already formatted in display units). */
export function drawMeasurement(
  g: CanvasRenderingContext2D,
  f: FrameInfo,
  mode: MeasureMode,
  geom: Geometry,
  lines: string[],
  st: DimStyle,
) {
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const S = (p: Pt) => f.toScreen(p);
  const pts = pointsOf(geom);
  switch (mode) {
    case 'distance':
    case 'check': {
      if (pts.length < 2) break;
      const a = S(pts[0]);
      const b = S(pts[pts.length - 1]);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const dir = len > 0 ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : { x: 1, y: 0 };
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      tick(g, a, dir, 6);
      tick(g, b, dir, 6);
      stroke(g, st);
      const rot = upright(a, b);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Text sits on the side of the line that is "up" for the rotated text.
      const off = { x: Math.sin(rot) * 5, y: -Math.cos(rot) * 5 };
      text(g, lines, { x: mid.x + off.x, y: mid.y + off.y }, st, rot);
      break;
    }
    case 'chain':
    case 'length': {
      if (geom.type !== 'polyline' && geom.type !== 'point') {
        g.beginPath();
        traceGeometry(g, geom, S, f.scale);
        stroke(g, st, 2);
        const c = S(centroid(geom));
        text(g, lines, { x: c.x, y: c.y - 6 }, st);
        break;
      }
      if (pts.length < 1) break;
      g.beginPath();
      traceGeometry(g, geom, S, f.scale);
      stroke(g, st);
      pts.forEach((p) => dot(g, S(p), st));
      const last = S(pts[pts.length - 1]);
      text(g, lines, { x: last.x + 8, y: last.y - 8 }, st, 0, 'left');
      break;
    }
    case 'area': {
      g.beginPath();
      traceGeometry(g, geom, S, f.scale);
      if (st.fill) {
        g.fillStyle = st.fill;
        g.fill('evenodd');
      }
      stroke(g, st);
      pts.forEach((p) => dot(g, S(p), st, 2));
      if (geom.type !== 'point') {
        const c = S(centroid(geom));
        text(g, lines, c, st, 0, 'center', 'middle');
      }
      break;
    }
    case 'radius': {
      if (geom.type !== 'circle' && geom.type !== 'arc') {
        g.beginPath();
        traceGeometry(g, geom, S, f.scale);
        stroke(g, st, 2);
        if (geom.type !== 'point') text(g, lines, S(centroid(geom)), st, 0, 'center', 'middle');
        break;
      }
      g.beginPath();
      traceGeometry(g, geom, S, f.scale);
      stroke(g, { ...st, dashed: true });
      const ang = geom.type === 'arc' ? geom.a0 + ccwSweep(geom.a0, geom.a1) / 2 : Math.PI / 4;
      const c = S(geom.c);
      const e = S({ x: geom.c.x + geom.r * Math.cos(ang), y: geom.c.y + geom.r * Math.sin(ang) });
      g.beginPath();
      g.moveTo(c.x - 5, c.y);
      g.lineTo(c.x + 5, c.y);
      g.moveTo(c.x, c.y - 5);
      g.lineTo(c.x, c.y + 5);
      g.moveTo(c.x, c.y);
      g.lineTo(e.x, e.y);
      stroke(g, st);
      // Arrowhead at the circle.
      const l = Math.hypot(e.x - c.x, e.y - c.y) || 1;
      const ux = (e.x - c.x) / l;
      const uy = (e.y - c.y) / l;
      g.beginPath();
      g.moveTo(e.x, e.y);
      g.lineTo(e.x - ux * 9 - uy * 3.5, e.y - uy * 9 + ux * 3.5);
      g.lineTo(e.x - ux * 9 + uy * 3.5, e.y - uy * 9 - ux * 3.5);
      g.closePath();
      g.fillStyle = st.color;
      g.fill();
      const rot = upright(c, e);
      const mid = { x: (c.x + e.x) / 2, y: (c.y + e.y) / 2 };
      text(g, lines, { x: mid.x + Math.sin(rot) * 5, y: mid.y - Math.cos(rot) * 5 }, st, rot);
      break;
    }
    case 'angle': {
      if (pts.length < 2) break;
      const v = S(pts[1]);
      const a = S(pts[0]);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(v.x, v.y);
      if (pts.length >= 3) {
        const b = S(pts[2]);
        g.lineTo(b.x, b.y);
        stroke(g, st);
        const a0 = Math.atan2(a.y - v.y, a.x - v.x);
        const a1 = Math.atan2(b.y - v.y, b.x - v.x);
        let d = a1 - a0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const r = Math.min(
          36,
          Math.hypot(a.x - v.x, a.y - v.y) * 0.6,
          Math.hypot(b.x - v.x, b.y - v.y) * 0.6,
        );
        g.beginPath();
        g.arc(v.x, v.y, Math.max(r, 8), a0, a0 + d, d < 0);
        stroke(g, st);
        const bis = a0 + d / 2;
        text(
          g,
          lines,
          { x: v.x + Math.cos(bis) * (Math.max(r, 8) + 12), y: v.y + Math.sin(bis) * (Math.max(r, 8) + 12) },
          st,
          0,
          'center',
          'middle',
        );
      } else stroke(g, st);
      dot(g, v, st);
      break;
    }
    case 'point': {
      if (!pts.length) break;
      const p = S(pts[0]);
      g.beginPath();
      g.moveTo(p.x - 8, p.y);
      g.lineTo(p.x + 8, p.y);
      g.moveTo(p.x, p.y - 8);
      g.lineTo(p.x, p.y + 8);
      stroke(g, st);
      g.beginPath();
      g.arc(p.x, p.y, 4, 0, Math.PI * 2);
      stroke(g, st);
      text(g, lines, { x: p.x + 10, y: p.y - 10 }, st, 0, 'left');
      break;
    }
  }
  g.restore();
}
