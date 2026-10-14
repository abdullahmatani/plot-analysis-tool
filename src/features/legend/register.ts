import { ListTree } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import { legendPanels } from '@/components/inspector/panels';
import { getProject } from '@/store/project';
import { useUiStore } from '@/store/ui';

import { resetLegend } from './legend-ops';
import { LegendPanel } from './LegendPanel';

/** Legend feature (row 75): the Legend tab panel and commands. */
export function register() {
  if (!legendPanels.includes(LegendPanel)) legendPanels.unshift(LegendPanel);
  const un = registerCommands([
    {
      id: 'legend.edit',
      title: 'Edit legend',
      menu: 'Export',
      section: 'legend',
      icon: ListTree,
      needsProject: true,
      keywords: ['key', 'legend'],
      run: () => useUiStore.getState().setInspectorTab('legend'),
    },
    {
      id: 'legend.reset',
      title: 'Reset legend edits',
      menu: 'Export',
      section: 'legend',
      needsProject: true,
      hidden: true,
      enabled: () => !!getProject()?.legend.overrides.length,
      run: () => void resetLegend(),
    },
  ]);
  return () => {
    const i = legendPanels.indexOf(LegendPanel);
    if (i >= 0) legendPanels.splice(i, 1);
    un();
  };
}
