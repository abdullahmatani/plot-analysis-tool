import { canvasController, registerOverlay, requestCanvasRender } from '@/render/canvas-controller';
import type { FrameInfo } from '@/tools/types';

import { traceSettings, useTraceSettings } from './settings';

/**
 * Precision aids for raster drawings (row 54): a magnifier loupe that follows the cursor (drawn
 * after the active tool's preview, so snap glyphs and rubber bands are magnified too) and
 * edge-contrast enhancement of raster PDF pages (a uniform of the underlay renderer).
 */

const LOUPE_R = 72;
let scratch: HTMLCanvasElement | null = null;

function drawLoupe(g: CanvasRenderingContext2D, f: FrameInfo) {
  const s = traceSettings();
  if (!s.loupe) return;
  const c = canvasController();
  const lp = c?.lastPointer;
  if (!c || !lp) return;
  const zoom = Math.max(2, Math.min(12, s.loupeZoom));
  const dpr = f.dpr;
  const cx = lp.screen.x;
  const cy = lp.screen.y;
  // Source square around the cursor (CSS px) and its device-pixel equivalent.
  const half = LOUPE_R / zoom;
  const sx = Math.round((cx - half) * dpr);
  const sy = Math.round((cy - half) * dpr);
  const sw = Math.max(1, Math.round(2 * half * dpr));
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== sw || scratch.height !== sw) {
    scratch.width = sw;
    scratch.height = sw;
  }
  const t = scratch.getContext('2d');
  if (!t) return;
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.clearRect(0, 0, sw, sw);
  t.fillStyle = f.lightBg ? '#ffffff' : '#0b0f14';
  t.fillRect(0, 0, sw, sw);
  try {
    t.drawImage(c.glCanvas, sx, sy, sw, sw, 0, 0, sw, sw);
    t.drawImage(c.overlayCanvas, sx, sy, sw, sw, 0, 0, sw, sw);
  } catch {
    return;
  }
  // Place the loupe up-right of the cursor, flipping near the canvas edges.
  const gap = 28;
  let lx = cx + gap + LOUPE_R;
  let ly = cy - gap - LOUPE_R;
  if (lx + LOUPE_R > f.width - 4) lx = cx - gap - LOUPE_R;
  if (ly - LOUPE_R < 4) ly = cy + gap + LOUPE_R;
  g.save();
  g.beginPath();
  g.arc(lx, ly, LOUPE_R, 0, Math.PI * 2);
  g.closePath();
  g.save();
  g.clip();
  g.imageSmoothingEnabled = false;
  g.drawImage(scratch, 0, 0, sw, sw, lx - LOUPE_R, ly - LOUPE_R, 2 * LOUPE_R, 2 * LOUPE_R);
  // Crosshair at the cursor position and a marker on the snapped point.
  g.strokeStyle = 'rgba(245,158,11,0.9)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(lx - LOUPE_R, ly);
  g.lineTo(lx - 6, ly);
  g.moveTo(lx + 6, ly);
  g.lineTo(lx + LOUPE_R, ly);
  g.moveTo(lx, ly - LOUPE_R);
  g.lineTo(lx, ly - 6);
  g.moveTo(lx, ly + 6);
  g.lineTo(lx, ly + LOUPE_R);
  g.stroke();
  if (lp.snap) {
    const ps = f.toScreen(lp.pt);
    const px = lx + (ps.x - cx) * zoom;
    const py = ly + (ps.y - cy) * zoom;
    g.strokeStyle = '#22c55e';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(px, py, 5, 0, Math.PI * 2);
    g.stroke();
  }
  g.restore();
  g.beginPath();
  g.arc(lx, ly, LOUPE_R, 0, Math.PI * 2);
  g.lineWidth = 2;
  g.strokeStyle = f.lightBg ? 'rgba(15,23,42,0.75)' : 'rgba(226,232,240,0.85)';
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 10;
  g.stroke();
  g.shadowBlur = 0;
  g.font = '10px Inter Variable, sans-serif';
  g.fillStyle = f.lightBg ? 'rgba(15,23,42,0.8)' : 'rgba(226,232,240,0.9)';
  g.textAlign = 'center';
  g.fillText(`×${zoom}`, lx, ly + LOUPE_R - 6);
  g.restore();
}

function syncContrast() {
  const r = canvasController()?.renderer;
  const want = traceSettings().edgeContrast ? 1 : 0;
  if (r && r.edgeContrast !== want) {
    r.edgeContrast = want;
    requestCanvasRender();
  }
}

export function registerRasterAids(): () => void {
  const unLoupe = registerOverlay(100, (g, f) => {
    syncContrast();
    drawLoupe(g, f);
  });
  const unSub = useTraceSettings.subscribe((s, p) => {
    if (s.edgeContrast !== p.edgeContrast) syncContrast();
    if (s.loupe !== p.loupe || s.loupeZoom !== p.loupeZoom) requestCanvasRender();
  });
  return () => {
    unLoupe();
    unSub();
  };
}
