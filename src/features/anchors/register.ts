import { CircleDot, Crosshair, Target } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import { layerSections } from '@/components/inspector/LayersPanel';
import { getProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';
import { setTool } from '@/tools/registry';

import { AnchorsSection } from './AnchorsSection';
import { registerAnchorOverlay } from './render';
import { anchorsFromSelectedCircles, CIRCLES_TOOL, PLACE_TOOL, registerAnchorTools } from './tools';

/** Anchors (row 47): Layers-tab section, place / from-circles tools, canvas overlay, commands. */

if (!layerSections.includes(AnchorsSection)) layerSections.push(AnchorsSection);

const canEdit = () => !!getProject() && !useProjectStore.getState().readOnly;

export function register() {
  registerAnchorTools();
  const unOverlay = registerAnchorOverlay();
  const unCmds = registerCommands([
    {
      id: PLACE_TOOL,
      title: 'Place anchor',
      menu: 'Data',
      section: 'anchors',
      icon: Crosshair,
      keywords: ['anchor', 'reference point', 'equipment', 'tag'],
      rail: true,
      needsProject: true,
      enabled: canEdit,
      active: () => useViewStore.getState().activeTool === PLACE_TOOL,
      run: () => setTool(PLACE_TOOL),
    },
    {
      id: CIRCLES_TOOL,
      title: 'Anchors from circle centres',
      menu: 'Data',
      section: 'anchors',
      icon: CircleDot,
      keywords: ['anchor', 'bulk', 'circles', 'nozzles', 'equipment'],
      needsProject: true,
      enabled: canEdit,
      active: () => useViewStore.getState().activeTool === CIRCLES_TOOL,
      run: () => setTool(CIRCLES_TOOL),
    },
    {
      id: 'anchors.fromSelection',
      title: 'Anchors from selected circles',
      menu: 'Data',
      section: 'anchors',
      icon: Target,
      needsProject: true,
      enabled: () => canEdit() && useViewStore.getState().selection.length > 0,
      run: () => anchorsFromSelectedCircles(useViewStore.getState().selection),
    },
  ]);
  return () => {
    unOverlay();
    unCmds();
  };
}
