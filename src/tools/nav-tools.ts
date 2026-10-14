import { Hand, MousePointer2, ScanSearch } from 'lucide-react';

import type { Pt } from '@/core/types';
import { canvasController } from '@/render/canvas-controller';
import { getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { pickUnderlay } from '@/underlay/pick';

import { registerTool } from './registry';
import type { Tool } from './types';

export const ICONS = { select: MousePointer2, pan: Hand, zoomWindow: ScanSearch };

/**
 * Selection-less base tool for 0.2.0: hovering highlights the underlay entity under the cursor and a
 * click pins it in the inspector (row 20). Analysis-object selection (row 43) extends this tool.
 */
export const underlayHover = {
  update(world: Pt, scale: number) {
    const p = getProject();
    if (!p) return;
    const [hit] = pickUnderlay(p.drawings, world, scale, 6, { limit: 1 });
    const cur = useViewStore.getState().hoverEntity;
    const next = hit ? { drawingId: hit.drawingId, index: hit.index } : null;
    if (cur?.drawingId !== next?.drawingId || cur?.index !== next?.index)
      useViewStore.getState().set({ hoverEntity: next });
  },
};

export const panTool: Tool = {
  id: 'pan',
  title: 'Pan',
  cursor: 'grab',
  hint: () => 'Drag to pan. Wheel to zoom.',
};

let windowStart: Pt | null = null;
let windowEnd: Pt | null = null;

export const zoomWindowTool: Tool = {
  id: 'zoom-window',
  title: 'Zoom window',
  cursor: 'crosshair',
  hint: () => 'Drag a rectangle to zoom into it. Esc to cancel.',
  pointerDown(e) {
    windowStart = e.screen;
    windowEnd = e.screen;
  },
  pointerMove(e) {
    if (windowStart) windowEnd = e.screen;
  },
  pointerUp(e, ctx) {
    if (!windowStart) return;
    const f = ctx.frame();
    const a = f.toWorld(windowStart);
    const b = f.toWorld(e.screen);
    const big = Math.abs(windowStart.x - e.screen.x) > 4 && Math.abs(windowStart.y - e.screen.y) > 4;
    windowStart = windowEnd = null;
    if (big) {
      canvasController()?.zoomToBounds(
        {
          minX: Math.min(a.x, b.x),
          minY: Math.min(a.y, b.y),
          maxX: Math.max(a.x, b.x),
          maxY: Math.max(a.y, b.y),
        },
        8,
      );
    } else {
      canvasController()?.zoomBy(2, e.screen);
    }
  },
  keyDown(e) {
    if (e.key === 'Escape' && windowStart) {
      windowStart = windowEnd = null;
      return true;
    }
    return false;
  },
  render(g) {
    if (!windowStart || !windowEnd) return;
    g.strokeStyle = '#3b82f6';
    g.fillStyle = 'rgba(59,130,246,0.1)';
    g.setLineDash([4, 3]);
    const x = Math.min(windowStart.x, windowEnd.x);
    const y = Math.min(windowStart.y, windowEnd.y);
    g.fillRect(x, y, Math.abs(windowEnd.x - windowStart.x), Math.abs(windowEnd.y - windowStart.y));
    g.strokeRect(x, y, Math.abs(windowEnd.x - windowStart.x), Math.abs(windowEnd.y - windowStart.y));
  },
};

registerTool(panTool);
registerTool(zoomWindowTool);
