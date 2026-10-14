import { SquareDashedMousePointer, Trash2, CopyPlus, BringToFront, SendToBack, XCircle } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import { propertySections } from '@/components/inspector/property-sections';
import { registerExtentProvider } from '@/render/canvas-controller';
import { getProject, useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { useViewStore } from '@/store/view';
import { registerTool, setTool } from '@/tools/registry';

import { geomBounds } from './geometry-cache';
import { deleteObjects, editableSelection, moveObjects, reorderObjects } from './ops';
import { registerObjectOverlays } from './render';
import { SelectionProperties } from './PropertiesSection';
import { registerSelectTool } from './select-tool';
import { transformTools } from './transform-tools';

const canEdit = () => !!getProject() && !useProjectStore.getState().readOnly;
const hasSel = () => canEdit() && editableSelection().length > 0;

export function register() {
  registerSelectTool();
  if (!propertySections.includes(SelectionProperties)) propertySections.unshift(SelectionProperties);
  for (const t of transformTools) registerTool(t.tool);
  const unOverlays = registerObjectOverlays();
  // Properties follow the selection (except while working in the Data tab's tables).
  const unFollow = useViewStore.subscribe((st, prev) => {
    if (st.selection === prev.selection || !st.selection.length) return;
    const ui = useUiStore.getState();
    if (ui.inspectorTab !== 'properties' && ui.inspectorTab !== 'data') ui.setInspectorTab('properties');
  });
  const unExtents = registerExtentProvider(() =>
    (getProject()?.objects ?? []).map((o) => geomBounds(o.geometry)),
  );
  const unCmds = registerCommands([
    {
      id: 'edit.selectAll',
      title: 'Select all objects',
      menu: 'Edit',
      section: 'select',
      shortcut: 'Mod+A',
      icon: SquareDashedMousePointer,
      needsProject: true,
      run: () => {
        const p = getProject();
        if (!p) return;
        const off = new Set(p.layers.filter((l) => !l.visible || l.locked).map((l) => l.id));
        useViewStore
          .getState()
          .set({ selection: p.objects.filter((o) => !off.has(o.layerId)).map((o) => o.id) });
      },
    },
    {
      id: 'edit.deselect',
      title: 'Clear selection',
      menu: 'Edit',
      section: 'select',
      icon: XCircle,
      needsProject: true,
      run: () => useViewStore.getState().set({ selection: [] }),
    },
    {
      id: 'edit.delete',
      title: 'Delete selection',
      menu: 'Edit',
      section: 'modify',
      shortcut: 'Delete',
      icon: Trash2,
      needsProject: true,
      enabled: hasSel,
      run: () => void deleteObjects(editableSelection()),
    },
    {
      id: 'edit.duplicate',
      title: 'Duplicate selection',
      menu: 'Edit',
      section: 'modify',
      shortcut: 'Mod+D',
      icon: CopyPlus,
      needsProject: true,
      enabled: hasSel,
      run: () => moveObjects(editableSelection(), 0, 0, true),
    },
    {
      id: 'edit.bringFront',
      title: 'Bring to front',
      menu: 'Edit',
      section: 'order',
      shortcut: 'Mod+]',
      icon: BringToFront,
      needsProject: true,
      enabled: hasSel,
      run: () => reorderObjects(editableSelection(), 'front'),
    },
    {
      id: 'edit.sendBack',
      title: 'Send to back',
      menu: 'Edit',
      section: 'order',
      shortcut: 'Mod+[',
      icon: SendToBack,
      needsProject: true,
      enabled: hasSel,
      run: () => reorderObjects(editableSelection(), 'back'),
    },
    ...transformTools.map(({ spec, tool }) => ({
      id: spec.id,
      title: spec.title,
      menu: 'Edit' as const,
      section: 'transform',
      shortcut: spec.shortcut,
      icon: spec.icon,
      needsProject: true,
      enabled: hasSel,
      active: () => useViewStore.getState().activeTool === tool.id,
      run: () => setTool(tool.id),
    })),
  ]);
  return () => {
    const i = propertySections.indexOf(SelectionProperties);
    if (i >= 0) propertySections.splice(i, 1);
    unOverlays();
    unFollow();
    unExtents();
    unCmds();
  };
}
