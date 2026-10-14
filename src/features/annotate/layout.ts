import type { AnalysisObject, Pt, Style } from '@/core/types';

import { textBoxPx, type TextBox } from './metrics';

/**
 * Screen-space layout of free text, leader callouts and bubble tags (row 41). Boxes are relative
 * to the object's anchor point in screen-aligned pixels (x right, y down), so the same layout is
 * used for drawing and hit-testing at any zoom and view rotation.
 */

export interface CalloutLayout {
  tip: Pt;
  knee: Pt;
  /** Text box relative to the knee. */
  box: { x0: number; y0: number; x1: number; y1: number };
  text: TextBox;
  dir: 1 | -1;
  pad: number;
}

export function calloutPoints(o: AnalysisObject): { tip: Pt; knee: Pt } | null {
  const g = o.geometry;
  if (g.type !== 'polyline' || g.pts.length < 2) return null;
  return { tip: g.pts[0], knee: g.pts[g.pts.length - 1] };
}

/** `kneeDx` = screen x of the knee minus screen x of the tip (decides which side the text goes). */
export function calloutLayout(
  text: string,
  s: Style,
  scale: number,
  kneeDx: number,
): Omit<CalloutLayout, 'tip' | 'knee'> {
  const t = textBoxPx(text || ' ', s, scale);
  const pad = Math.max(2, t.size * 0.35);
  const shoulder = t.size * 0.6;
  const dir: 1 | -1 = kneeDx >= 0 ? 1 : -1;
  const w = t.w + 2 * pad;
  const h = t.h + 2 * pad;
  const x0 = dir === 1 ? shoulder : -shoulder - w;
  return { box: { x0, y0: -h / 2, x1: x0 + w, y1: h / 2 }, text: t, dir, pad };
}

export function tagLabel(o: AnalysisObject, prefix = ''): string {
  return `${prefix}${o.tagNumber ?? '?'}`;
}

export function tagCentre(o: AnalysisObject): Pt | null {
  const g = o.geometry;
  if (g.type === 'point') return g.p;
  if (g.type === 'polyline' && g.pts.length) return g.pts[g.pts.length - 1];
  return null;
}

export function tagRadiusPx(label: string, s: Style, scale: number): { r: number; text: TextBox } {
  const t = textBoxPx(label, s, scale);
  return { r: Math.max(t.size * 0.95, t.w / 2 + t.size * 0.45), text: t };
}
