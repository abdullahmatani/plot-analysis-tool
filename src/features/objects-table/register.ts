import { TableProperties } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import { dataPanels } from '@/components/inspector/panels';
import { useUiStore } from '@/store/ui';

import { ObjectsTable } from './ObjectsTable';

/** Objects table (row 46) in the Data tab, after the contour datasets. */

if (!dataPanels.includes(ObjectsTable)) dataPanels.push(ObjectsTable);

export function register() {
  return registerCommands([
    {
      id: 'data.objectsTable',
      title: 'Objects table',
      menu: 'Data',
      section: 'view',
      icon: TableProperties,
      keywords: ['list', 'objects', 'areas', 'schedule', 'accessibility'],
      needsProject: true,
      run: () => {
        useUiStore.getState().setInspectorTab('data');
        setTimeout(() => document.querySelector<HTMLElement>('[data-testid="objects-grid"]')?.focus(), 50);
      },
    },
  ]);
}
