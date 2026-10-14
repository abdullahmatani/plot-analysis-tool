import { expand } from '@/features/objects/geometry-cache';
import { fontFamily } from '@/features/objects/style';
import { registerOverlay } from '@/render/canvas-controller';
import { visibleWorldBounds } from '@/render/view';
import { getProject } from '@/store/project';

import { useAnchorsUi } from './tools';

/**
 * Anchor overlay (row 47): a diamond marker with a crosshair and the anchor name, drawn above
 * contour labels (z 34) so reference points stay visible. Names are skipped where they would overlap.
 */
export function registerAnchorOverlay(): () => void {
  return registerOverlay(34, (g, f) => {
    const p = getProject();
    if (!p?.anchors.length || !useAnchorsUi.getState().showOnCanvas) return;
    const hoverId = useAnchorsUi.getState().hoverId;
    const vis = expand(visibleWorldBounds(f.view, f.width, f.height), 40 / f.scale);
    const ink = f.lightBg ? '#0f766e' : '#2dd4bf';
    const halo = f.lightBg ? 'rgba(255,255,255,0.92)' : 'rgba(11,15,20,0.88)';
    g.font = `600 11px ${fontFamily('sans')}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
    let drawn = 0;
    for (const a of p.anchors) {
      if (a.p.x < vis.minX || a.p.x > vis.maxX || a.p.y < vis.minY || a.p.y > vis.maxY) continue;
      if (++drawn > 3000) break;
      const s = f.toScreen(a.p);
      const hot = a.id === hoverId;
      const k = hot ? 7 : 5;
      g.beginPath();
      g.moveTo(s.x, s.y - k);
      g.lineTo(s.x + k, s.y);
      g.lineTo(s.x, s.y + k);
      g.lineTo(s.x - k, s.y);
      g.closePath();
      g.fillStyle = halo;
      g.fill();
      g.lineWidth = hot ? 2.5 : 1.5;
      g.strokeStyle = hot ? '#3b82f6' : ink;
      g.stroke();
      g.beginPath();
      g.moveTo(s.x - k - 3, s.y);
      g.lineTo(s.x + k + 3, s.y);
      g.moveTo(s.x, s.y - k - 3);
      g.lineTo(s.x, s.y + k + 3);
      g.lineWidth = 1;
      g.stroke();
      const w = g.measureText(a.name).width;
      const box = { x0: s.x + k + 3, y0: s.y - k - 13, x1: s.x + k + 7 + w, y1: s.y - k + 1 };
      if (!hot && boxes.some((b) => b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0))
        continue;
      boxes.push(box);
      g.direction = /[֐-ࣿיִ-ﻼ]/.test(a.name) ? 'rtl' : 'ltr';
      g.textAlign = g.direction === 'rtl' ? 'right' : 'left';
      const tx = g.direction === 'rtl' ? box.x1 : box.x0 + 2;
      g.lineWidth = 3;
      g.lineJoin = 'round';
      g.strokeStyle = halo;
      g.strokeText(a.name, tx, s.y - k - 6);
      g.fillStyle = hot ? '#3b82f6' : ink;
      g.fillText(a.name, tx, s.y - k - 6);
    }
    g.direction = 'ltr';
  });
}
