import {
  Maximize,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  RotateCw,
  Compass,
  Bookmark,
  Hand,
  MousePointer2,
  ScanSearch,
} from 'lucide-react';
import { toast } from 'sonner';

import { newId } from '@/core/ids';
import { degToRad, radToDeg } from '@/core/units';
import { canvasController } from '@/render/canvas-controller';
import { commit, getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { setTool } from '@/tools/registry';

import { registerCommands } from './commands';
import { promptText } from './prompt';

const hasProject = () => !!getProject();

/** Viewer navigation commands (row 17). */
export function registerViewCommands() {
  return registerCommands([
    {
      id: 'tool.select',
      title: 'Select / inspect',
      menu: 'Edit',
      section: 'tools',
      shortcut: 'V',
      icon: MousePointer2,
      rail: true,
      needsProject: true,
      active: () => useViewStore.getState().activeTool === 'select',
      run: () => setTool('select'),
    },
    {
      id: 'tool.pan',
      title: 'Pan',
      menu: 'View',
      section: 'nav',
      shortcut: 'H',
      icon: Hand,
      rail: true,
      needsProject: true,
      active: () => useViewStore.getState().activeTool === 'pan',
      run: () => setTool('pan'),
    },
    {
      id: 'view.zoomWindow',
      title: 'Zoom window',
      menu: 'View',
      section: 'nav',
      shortcut: 'Z',
      icon: ScanSearch,
      rail: true,
      needsProject: true,
      active: () => useViewStore.getState().activeTool === 'zoom-window',
      run: () => setTool('zoom-window'),
    },
    {
      id: 'view.zoomExtents',
      title: 'Zoom extents',
      menu: 'View',
      section: 'nav',
      shortcut: 'Home',
      icon: Maximize,
      needsProject: true,
      enabled: hasProject,
      run: () => canvasController()?.zoomExtents(),
    },
    {
      id: 'view.zoomIn',
      title: 'Zoom in',
      menu: 'View',
      section: 'nav',
      shortcut: '=',
      icon: ZoomIn,
      needsProject: true,
      enabled: hasProject,
      run: () => canvasController()?.zoomBy(1.5),
    },
    {
      id: 'view.zoomOut',
      title: 'Zoom out',
      menu: 'View',
      section: 'nav',
      shortcut: '-',
      icon: ZoomOut,
      needsProject: true,
      enabled: hasProject,
      run: () => canvasController()?.zoomBy(1 / 1.5),
    },
    {
      id: 'view.rotateLeft',
      title: 'Rotate view 90° anticlockwise',
      menu: 'View',
      section: 'rotate',
      shortcut: 'Alt+[',
      icon: RotateCcw,
      needsProject: true,
      enabled: hasProject,
      run: () => canvasController()?.rotateBy(Math.PI / 2),
    },
    {
      id: 'view.rotateRight',
      title: 'Rotate view 90° clockwise',
      menu: 'View',
      section: 'rotate',
      shortcut: 'Alt+]',
      icon: RotateCw,
      needsProject: true,
      enabled: hasProject,
      run: () => canvasController()?.rotateBy(-Math.PI / 2),
    },
    {
      id: 'view.rotateFree',
      title: 'Rotate view to angle…',
      menu: 'View',
      section: 'rotate',
      icon: Compass,
      needsProject: true,
      enabled: hasProject,
      run: async () => {
        const cur = radToDeg(useViewStore.getState().view.rotation);
        const v = await promptText({
          title: 'Rotate view',
          label: 'Angle in degrees (anticlockwise)',
          defaultValue: cur.toFixed(2),
        });
        if (v === null) return;
        const deg = Number(v.replace(',', '.'));
        if (!Number.isFinite(deg)) {
          toast.error('Enter an angle in degrees.');
          return;
        }
        canvasController()?.setRotation(degToRad(deg));
      },
    },
    {
      id: 'view.resetRotation',
      title: 'Reset view rotation',
      menu: 'View',
      section: 'rotate',
      needsProject: true,
      enabled: hasProject,
      run: () => canvasController()?.setRotation(0),
    },
    {
      id: 'view.saveView',
      title: 'Save current view…',
      menu: 'View',
      section: 'views',
      icon: Bookmark,
      needsProject: true,
      enabled: hasProject,
      run: async () => {
        const name = await promptText({
          title: 'Save view',
          label: 'Name',
          defaultValue: `View ${(getProject()?.views.length ?? 0) + 1}`,
        });
        if (!name) return;
        const v = useViewStore.getState().view;
        commit(`Save view “${name}”`, (d) => {
          d.views.push({
            id: newId('view'),
            name,
            centre: { x: v.cx, y: v.cy },
            scale: v.scale,
            rotation: v.rotation,
          });
        });
        registerSavedViewCommands();
      },
    },
  ]);
}

let savedViewUnreg: (() => void) | null = null;

/** Saved views appear as palette/menu commands. */
export function registerSavedViewCommands() {
  savedViewUnreg?.();
  const p = getProject();
  savedViewUnreg = registerCommands(
    (p?.views ?? []).map((v) => ({
      id: `view.saved.${v.id}`,
      title: `Go to view “${v.name}”`,
      menu: 'View' as const,
      section: 'views',
      needsProject: true,
      run: () =>
        useViewStore
          .getState()
          .setView({ cx: v.centre.x, cy: v.centre.y, scale: v.scale, rotation: v.rotation }),
    })),
  );
}
