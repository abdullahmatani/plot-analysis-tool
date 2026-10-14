import { MousePointer2 } from 'lucide-react';

import { apply } from '@/core/affine';
import { traceGeometry } from '@/render/draw-geometry';
import { registerOverlay } from '@/render/canvas-controller';
import { getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { entityToGeometry } from '@/underlay/entity-geometry';
import { getModel } from '@/underlay/models';
import { drawingPlacement } from '@/underlay/pick';

import { underlayHover } from './nav-tools';
import { registerTool } from './registry';
import type { Tool } from './types';

export const SelectIcon = MousePointer2;

/** Select tool (0.2.0 part): hover highlights underlay entities, click pins one in the inspector. */
export const selectTool: Tool = {
  id: 'select',
  title: 'Select',
  cursor: 'default',
  hint: () => 'Hover over drawing geometry to inspect it; click to pin it in Properties.',
  pointerMove(e, ctx) {
    if (e.buttons) return;
    underlayHover.update(e.world, ctx.frame().scale);
  },
  pointerUp(e) {
    if (e.button !== 0) return;
    const hover = useViewStore.getState().hoverEntity;
    useViewStore.getState().set({ pickedEntity: hover });
  },
  keyDown(e) {
    if (e.key === 'Escape') {
      useViewStore.getState().set({ pickedEntity: null });
      return true;
    }
    return false;
  },
};

registerTool(selectTool);

/** Highlights hovered / picked underlay entities. */
registerOverlay(50, (g, f) => {
  const { hoverEntity, pickedEntity } = useViewStore.getState();
  const project = getProject();
  if (!project) return;
  for (const [ent, color, width] of [
    [pickedEntity, '#f59e0b', 3],
    [hoverEntity, '#38bdf8', 2],
  ] as const) {
    if (!ent) continue;
    const d = project.drawings.find((x) => x.id === ent.drawingId);
    const s = d && getModel(d.id)?.result?.store;
    if (!d || !s || ent.index >= s.count) continue;
    const geom = entityToGeometry(s, ent.index);
    if (!geom) continue;
    const place = drawingPlacement(d);
    const unit = Math.sqrt(Math.abs(place[0] * place[3] - place[1] * place[2]));
    g.beginPath();
    traceGeometry(g, geom, (p) => f.toScreen(apply(place, p)), f.scale * unit);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.globalAlpha = 0.9;
    g.stroke();
  }
});
