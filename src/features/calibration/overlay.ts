import { apply } from '@/core/affine';
import type { Affine2D, Pt } from '@/core/types';
import { getProject } from '@/store/project';
import type { FrameInfo } from '@/tools/types';
import { drawingPlacement } from '@/underlay/pick';

import { previewDistances, previewPoints } from './actions';
import { drawMarker } from './pick';
import { useCalStore, type CalibrateSession } from './store';

/**
 * Canvas overlay for open calibration / alignment / check sessions: the picked references (in their
 * drawing's current placement), with the worst residual of a fit highlighted in red.
 */

const AMBER = '#f59e0b';
const RED = '#ef4444';
const BLUE = '#38bdf8';
const GREEN = '#22c55e';

function line(g: CanvasRenderingContext2D, a: Pt, b: Pt, color: string, dash: number[] = []) {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.setLineDash(dash);
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.stroke();
  g.restore();
}

function drawCalibrate(g: CanvasRenderingContext2D, f: FrameInfo, s: CalibrateSession, place: Affine2D) {
  const toS = (p: Pt) => f.toScreen(apply(place, p));
  if (s.tab === 'two-point') {
    const { a, b } = s.twoPoint;
    if (a && b) line(g, toS(a), toS(b), AMBER);
    if (a) drawMarker(g, toS(a), '1');
    if (b) drawMarker(g, toS(b), '2');
  } else if (s.tab === 'references' && s.refMode === 'distance') {
    const pv = previewDistances(s);
    s.distances.forEach((r, i) => {
      const worst = pv.worstRow === i && (pv.fit?.rms ?? 0) > 0;
      const c = worst ? RED : AMBER;
      if (r.a && r.b) line(g, toS(r.a), toS(r.b), c);
      if (r.a) drawMarker(g, toS(r.a), `#${i + 1}`, c);
      if (r.b) drawMarker(g, toS(r.b), '', c);
    });
  } else if (s.tab === 'references' || s.tab === 'coordinates') {
    const list = s.tab === 'coordinates' ? 'coords' : 'points';
    const pv = previewPoints(s, list);
    s[list].forEach((r, i) => {
      if (!r.p) return;
      const worst = pv.worstRow === i && (pv.fit?.rms ?? 0) > 1e-9 && s[list].length > 2;
      drawMarker(g, toS(r.p), `#${i + 1}`, worst ? RED : AMBER);
    });
  }
}

export function drawSessionOverlay(g: CanvasRenderingContext2D, f: FrameInfo) {
  const s = useCalStore.getState().session;
  const p = getProject();
  if (!s || !p) return;
  if (s.kind === 'calibrate') {
    const d = p.drawings.find((x) => x.id === s.drawingId);
    if (d) drawCalibrate(g, f, s, drawingPlacement(d));
    return;
  }
  if (s.kind === 'align') {
    const sub = p.drawings.find((x) => x.id === s.drawingId);
    const base = p.drawings.find((x) => x.id === s.baseId);
    s.src.forEach((pt, i) => {
      if (pt && sub) drawMarker(g, f.toScreen(apply(drawingPlacement(sub), pt)), `S${i + 1}`, BLUE);
    });
    s.dst.forEach((pt, i) => {
      if (pt && base) drawMarker(g, f.toScreen(apply(drawingPlacement(base), pt)), `B${i + 1}`, GREEN);
    });
    return;
  }
  if (s.kind === 'check') {
    if (s.a && s.b)
      line(g, f.toScreen(s.a), f.toScreen(s.b), s.result && !s.result.pass ? RED : GREEN, [6, 4]);
    if (s.a) drawMarker(g, f.toScreen(s.a), '1', GREEN);
    if (s.b) drawMarker(g, f.toScreen(s.b), '2', GREEN);
  }
}
