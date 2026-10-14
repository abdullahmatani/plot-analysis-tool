import { SlidersHorizontal } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import { extraDialogs } from '@/components/app/extra-dialogs';
import { getProject } from '@/store/project';
import { useUiStore } from '@/store/ui';

import { ProjectSettingsDialog } from './ProjectSettingsDialog';

/** Units and precision (row 26): project display settings dialog. */

export const PROJECT_SETTINGS_DIALOG = 'project-settings';

export function register() {
  const entry = { id: PROJECT_SETTINGS_DIALOG, Component: ProjectSettingsDialog };
  if (!extraDialogs.some((e) => e.id === entry.id)) extraDialogs.push(entry);
  const un = registerCommands([
    {
      id: 'project.settings',
      title: 'Project settings (units, precision, north)…',
      menu: 'File',
      section: 'project',
      icon: SlidersHorizontal,
      keywords: ['units', 'precision', 'decimal', 'metres', 'feet', 'area', 'angle', 'north', 'coordinates'],
      needsProject: true,
      enabled: () => !!getProject(),
      run: () => useUiStore.getState().openDialog(PROJECT_SETTINGS_DIALOG),
    },
  ]);
  return () => {
    un();
    const i = extraDialogs.indexOf(entry);
    if (i >= 0) extraDialogs.splice(i, 1);
  };
}
