import { Type } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import { extraDialogs } from '@/components/app/extra-dialogs';
import { useUiStore } from '@/store/ui';

import { FontsDialog } from './FontsDialog';

/** Help → CAD font substitutions (row 24). */
export function register() {
  if (!extraDialogs.some((d) => d.id === 'cad-fonts'))
    extraDialogs.push({ id: 'cad-fonts', Component: FontsDialog });
  return registerCommands([
    {
      id: 'help.cadFonts',
      title: 'CAD font substitutions',
      menu: 'Help',
      section: 'reference',
      icon: Type,
      run: () => useUiStore.getState().openDialog('cad-fonts'),
    },
  ]);
}
