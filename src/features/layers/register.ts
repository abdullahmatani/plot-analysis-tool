import { Layers } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import { layerSections } from '@/components/inspector/LayersPanel';
import { getProject, useProjectStore } from '@/store/project';

import { LayersSection, newLayer } from './LayersSection';

if (!layerSections.includes(LayersSection)) layerSections.unshift(LayersSection);

export function register() {
  return registerCommands([
    {
      id: 'layers.new',
      title: 'New analysis layer…',
      menu: 'Edit',
      section: 'layers',
      shortcut: 'Mod+Shift+N',
      icon: Layers,
      needsProject: true,
      enabled: () => !!getProject() && !useProjectStore.getState().readOnly,
      run: () => newLayer(),
    },
  ]);
}
