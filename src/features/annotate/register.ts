import { ListOrdered, MoveDiagonal } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import type { Bounds } from '@/core/types';
import { registerExtentProvider } from '@/render/canvas-controller';
import { resolveStyle } from '@/features/objects/style';
import { deleteHooks, editableSelection } from '@/features/objects/ops';
import { objectSections } from '@/features/objects/PropertiesSection';
import { getProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';
import { registerTool, setTool } from '@/tools/registry';

import { AnnotationSection } from './AnnotationSection';
import { calloutPoints } from './layout';
import { textBoxPx } from './metrics';
import { labelTool } from './label-tool';
import { registerAnnotationRendering } from './render';
import { offerRenumber, renumberTags } from './tags';
import { annotationTools } from './tools';

/** Annotation feature (rows 40, 41): text, callouts, numbered tags and the label tool. */
export function register() {
  const unRender = registerAnnotationRendering();
  for (const t of annotationTools) registerTool(t.tool);
  registerTool(labelTool);
  if (!objectSections.includes(AnnotationSection)) objectSections.push(AnnotationSection);
  deleteHooks.push(offerRenumber);
  // Text boxes extend beyond their anchor points; include them (at the current zoom) in Zoom extents.
  const unExtents = registerExtentProvider(() => {
    const p = getProject();
    if (!p) return [];
    const scale = useViewStore.getState().view.scale;
    const out: Bounds[] = [];
    for (const o of p.objects) {
      if ((o.kind !== 'text' && o.kind !== 'callout') || !o.text) continue;
      const t = textBoxPx(o.text, resolveStyle(p, o), scale);
      const w = (t.w + t.size * 2) / scale;
      const h = (t.h + t.size) / scale;
      const at =
        o.kind === 'text' ? (o.geometry.type === 'point' ? o.geometry.p : null) : calloutPoints(o)?.knee;
      if (at) out.push({ minX: at.x - w, minY: at.y - h, maxX: at.x + w, maxY: at.y + h });
    }
    return out;
  });
  const canEdit = () => !!getProject() && !useProjectStore.getState().readOnly;
  const unCmds = registerCommands([
    ...annotationTools.map(({ spec, tool }) => ({
      id: spec.id,
      title: spec.title,
      menu: 'Draw' as const,
      section: 'annotate',
      shortcut: spec.shortcut,
      icon: spec.icon,
      needsProject: true,
      rail: spec.id !== 'annotate.callout',
      enabled: canEdit,
      active: () => useViewStore.getState().activeTool === tool.id,
      run: () => setTool(tool.id),
    })),
    {
      id: labelTool.id,
      title: 'Move labels',
      menu: 'Draw',
      section: 'annotate',
      shortcut: 'Shift+L',
      icon: MoveDiagonal,
      needsProject: true,
      enabled: canEdit,
      active: () => useViewStore.getState().activeTool === labelTool.id,
      run: () => setTool(labelTool.id),
    },
    {
      id: 'annotate.renumber',
      title: 'Renumber tags on active layer',
      menu: 'Draw',
      section: 'annotate',
      icon: ListOrdered,
      needsProject: true,
      enabled: canEdit,
      run: () => {
        const p = getProject();
        const sel = editableSelection();
        const layerId =
          p?.objects.find((o) => o.id === sel[0] && o.kind === 'tag')?.layerId ?? p?.activeLayerId;
        if (layerId) renumberTags(layerId);
      },
    },
  ]);
  return () => {
    unRender();
    unExtents();
    unCmds();
    const i = objectSections.indexOf(AnnotationSection);
    if (i >= 0) objectSections.splice(i, 1);
    const j = deleteHooks.indexOf(offerRenumber);
    if (j >= 0) deleteHooks.splice(j, 1);
  };
}
