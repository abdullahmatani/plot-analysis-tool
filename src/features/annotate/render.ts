import type { AnalysisObject, Project, Style } from '@/core/types';
import { distanceToGeometry } from '@/geometry/hit';
import { drawLabelText, kindRenderers } from '@/features/objects/render';
import { kindHitTests } from '@/features/objects/pick';
import { hexToRgba, layerOf, PX_PER_MM, resolveStyle } from '@/features/objects/style';
import { useViewStore } from '@/store/view';
import type { FrameInfo } from '@/tools/types';

import { calloutLayout, calloutPoints, tagCentre, tagLabel, tagRadiusPx } from './layout';
import { distToBox, screenDelta, textBoxPx } from './metrics';

/** Drawing and hit-testing of free text, leader callouts and bubble tags (row 41). */

const boxFill = (s: Style, f: FrameInfo) =>
  s.hatch !== 'none' && s.fillOpacity > 0
    ? hexToRgba(s.fill, Math.max(s.fillOpacity, 0.85))
    : f.lightBg
      ? 'rgba(255,255,255,0.92)'
      : 'rgba(11,15,20,0.88)';

function strokeW(s: Style) {
  return Math.max(1, s.strokeWidth * PX_PER_MM);
}

function arrowHead(
  g: CanvasRenderingContext2D,
  tip: { x: number; y: number },
  from: { x: number; y: number },
  size: number,
) {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  g.beginPath();
  g.moveTo(tip.x, tip.y);
  g.lineTo(tip.x - size * Math.cos(a - 0.4), tip.y - size * Math.sin(a - 0.4));
  g.lineTo(tip.x - size * Math.cos(a + 0.4), tip.y - size * Math.sin(a + 0.4));
  g.closePath();
  g.fill();
}

function drawText(g: CanvasRenderingContext2D, o: AnalysisObject, s: Style, f: FrameInfo) {
  if (o.geometry.type !== 'point' || !o.text) return;
  const sp = f.toScreen(o.geometry.p);
  if (s.hatch !== 'none' && s.fillOpacity > 0) {
    const t = textBoxPx(o.text, s, f.scale);
    const pad = t.size * 0.3;
    g.fillStyle = boxFill(s, f);
    g.fillRect(sp.x - pad, sp.y - pad, t.w + 2 * pad, t.h + 2 * pad);
  }
  drawLabelText(g, o.text, sp.x, sp.y, s, f, 'left', 'top');
}

function drawCallout(g: CanvasRenderingContext2D, o: AnalysisObject, s: Style, f: FrameInfo) {
  const pts = calloutPoints(o);
  if (!pts) return;
  const tip = f.toScreen(pts.tip);
  const knee = f.toScreen(pts.knee);
  const L = calloutLayout(o.text ?? '', s, f.scale, knee.x - tip.x);
  const bx = knee.x + L.box.x0;
  const by = knee.y + L.box.y0;
  const bw = L.box.x1 - L.box.x0;
  const bh = L.box.y1 - L.box.y0;
  const edge = { x: knee.x + (L.dir === 1 ? L.box.x0 : L.box.x1), y: knee.y };
  g.strokeStyle = hexToRgba(s.stroke, s.strokeOpacity || 1);
  g.fillStyle = g.strokeStyle;
  g.lineWidth = strokeW(s);
  g.beginPath();
  g.moveTo(tip.x, tip.y);
  g.lineTo(knee.x, knee.y);
  g.lineTo(edge.x, edge.y);
  g.stroke();
  arrowHead(g, tip, knee, Math.max(7, L.text.size * 0.8));
  g.fillStyle = boxFill(s, f);
  g.fillRect(bx, by, bw, bh);
  g.strokeRect(bx, by, bw, bh);
  if (o.text) drawLabelText(g, o.text, bx + L.pad, by + L.pad, { ...s, labelHalo: false }, f, 'left', 'top');
}

function tagPrefix(p: Project, o: AnalysisObject) {
  return layerOf(p, o)?.tagPrefix ?? '';
}

function drawTag(g: CanvasRenderingContext2D, o: AnalysisObject, s: Style, f: FrameInfo, p: Project) {
  const c = tagCentre(o);
  if (!c) return;
  const label = tagLabel(o, tagPrefix(p, o));
  const { r } = tagRadiusPx(label, s, f.scale);
  const sc = f.toScreen(c);
  g.strokeStyle = hexToRgba(s.stroke, s.strokeOpacity || 1);
  g.lineWidth = strokeW(s);
  if (o.geometry.type === 'polyline' && o.geometry.pts.length >= 2) {
    const t = f.toScreen(o.geometry.pts[0]);
    const d = Math.hypot(sc.x - t.x, sc.y - t.y);
    if (d > r) {
      g.beginPath();
      g.moveTo(t.x, t.y);
      g.lineTo(sc.x - ((sc.x - t.x) / d) * r, sc.y - ((sc.y - t.y) / d) * r);
      g.stroke();
      g.beginPath();
      g.arc(t.x, t.y, 2.5, 0, Math.PI * 2);
      g.fillStyle = g.strokeStyle;
      g.fill();
    }
  }
  g.beginPath();
  g.arc(sc.x, sc.y, r, 0, Math.PI * 2);
  g.fillStyle = boxFill(s, f);
  g.fill();
  g.stroke();
  drawLabelText(g, label, sc.x, sc.y, { ...s, labelHalo: false }, f, 'center', 'middle');
}

const rotation = () => useViewStore.getState().view.rotation;
const styleOf = (p: Project, o: AnalysisObject): Style => resolveStyle(p, o);

export function registerAnnotationRendering(): () => void {
  kindRenderers.text = drawText;
  kindRenderers.callout = drawCallout;
  kindRenderers.tag = drawTag;
  kindHitTests.text = (o, world, scale, p) => {
    if (o.geometry.type !== 'point' || !o.text) return null;
    const s = styleOf(p, o);
    const t = textBoxPx(o.text, s, scale);
    const d = screenDelta(world, o.geometry.p, scale, rotation());
    return distToBox(d, 0, 0, t.w, t.h) / scale;
  };
  kindHitTests.callout = (o, world, scale, p) => {
    const pts = calloutPoints(o);
    if (!pts) return null;
    const s = styleOf(p, o);
    const tipD = screenDelta(pts.tip, pts.knee, scale, rotation());
    const L = calloutLayout(o.text ?? '', s, scale, -tipD.x);
    const d = screenDelta(world, pts.knee, scale, rotation());
    const box = distToBox(d, L.box.x0, L.box.y0, L.box.x1, L.box.y1) / scale;
    return Math.min(box, distanceToGeometry(world, o.geometry));
  };
  kindHitTests.tag = (o, world, scale, p) => {
    const c = tagCentre(o);
    if (!c) return null;
    const s = styleOf(p, o);
    const { r } = tagRadiusPx(tagLabel(o, tagPrefix(p, o)), s, scale);
    const d = screenDelta(world, c, scale, rotation());
    const bubble = Math.max(0, Math.hypot(d.x, d.y) - r) / scale;
    return o.geometry.type === 'polyline' ? Math.min(bubble, distanceToGeometry(world, o.geometry)) : bubble;
  };
  return () => {
    delete kindRenderers.text;
    delete kindRenderers.callout;
    delete kindRenderers.tag;
    delete kindHitTests.text;
    delete kindHitTests.callout;
    delete kindHitTests.tag;
  };
}
