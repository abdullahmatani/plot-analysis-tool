import { BookMarked, Focus } from 'lucide-react';
import { toast } from 'sonner';

import { registerCommands } from '@/app/commands';
import { extraDialogs } from '@/components/app/extra-dialogs';
import { canvasController } from '@/render/canvas-controller';
import { getProject } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { useViewStore } from '@/store/view';
import { getModel } from '@/underlay/models';
import { drawingPlacement } from '@/underlay/pick';

import { selectionBounds, type PickedEntity } from './bounds';
import { SavedViewsDialog } from './SavedViewsDialog';

const hasProject = () => !!getProject();

function pickedEntity(): PickedEntity | null {
  const pick = useViewStore.getState().pickedEntity;
  const d = pick && getProject()?.drawings.find((x) => x.id === pick.drawingId);
  const store = pick && getModel(pick.drawingId)?.result?.store;
  return d && store ? { store, index: pick.index, placement: drawingPlacement(d) } : null;
}

/** Viewer navigation additions (row 17): zoom to selection and the saved views manager. */
export function register() {
  const dialog = { id: 'saved-views', Component: SavedViewsDialog };
  if (!extraDialogs.some((d) => d.id === dialog.id)) extraDialogs.push(dialog);
  const unreg = registerCommands([
    {
      id: 'view.zoomSelection',
      title: 'Zoom to selection',
      menu: 'View',
      section: 'nav',
      shortcut: 'Shift+Z',
      icon: Focus,
      needsProject: true,
      enabled: hasProject,
      run: () => {
        const p = getProject();
        const b = p && selectionBounds(p, useViewStore.getState().selection, pickedEntity());
        if (!b) {
          toast.info('Nothing is selected. Select objects, or click an underlay entity, first.');
          return;
        }
        canvasController()?.zoomToBounds(b);
      },
    },
    {
      id: 'view.manageViews',
      title: 'Saved views…',
      menu: 'View',
      section: 'views',
      icon: BookMarked,
      needsProject: true,
      enabled: hasProject,
      run: () => useUiStore.getState().openDialog('saved-views'),
    },
  ]);
  return () => {
    unreg();
    const i = extraDialogs.indexOf(dialog);
    if (i >= 0) extraDialogs.splice(i, 1);
  };
}
