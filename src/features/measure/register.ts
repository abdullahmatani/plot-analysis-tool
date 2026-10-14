import { Compass, Ruler } from 'lucide-react';

import { registerCommands } from '@/app/commands';
import { extraDialogs } from '@/components/app/extra-dialogs';
import { requestCanvasRender } from '@/render/canvas-controller';
import { getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { registerTool, setTool } from '@/tools/registry';

import { warnIfUncalibrated } from '@/features/calibration/guard';

import { MeasureFeatureHost } from './Host';
import { useOverlayPrefs } from './overlay-prefs';
import { registerMeasurementRenderer } from './render';
import { useMeasureStore } from './store';
import { MEASURE_TOOL_IDS, MEASURE_TOOLS } from './tools';

/**
 * Measurement (row 35): tools in Draw → Measure, a live result panel, measurement annotations, and
 * the on-canvas scale bar and north arrow (row 36, View menu).
 */

export function register() {
  for (const t of MEASURE_TOOLS) registerTool(t.tool);
  const unRenderer = registerMeasurementRenderer();
  const entry = { id: 'measure-host', Component: MeasureFeatureHost };
  if (!extraDialogs.some((e) => e.id === entry.id)) extraDialogs.push(entry);
  const unResult = useMeasureStore.subscribe((s, p) => {
    if (s.result !== p.result) requestCanvasRender();
  });
  // Leaving the measurement tools clears the transient result.
  const unTool = useViewStore.subscribe((s, p) => {
    if (s.activeTool !== p.activeTool && !MEASURE_TOOL_IDS.has(s.activeTool)) {
      const m = useMeasureStore.getState();
      if (m.result || m.live) useMeasureStore.setState({ result: null, live: null });
    }
  });
  const canMeasure = () => !!getProject();
  const unCmds = registerCommands([
    ...MEASURE_TOOLS.map((t) => ({
      id: t.id,
      title: t.title,
      menu: 'Draw' as const,
      section: 'measure',
      shortcut: t.shortcut,
      icon: t.icon,
      keywords: ['measure', 'dimension'],
      rail: t.id === 'measure.distance' || t.id === 'measure.area',
      needsProject: true,
      enabled: canMeasure,
      active: () => useViewStore.getState().activeTool === t.id,
      run: async () => {
        if (t.id !== 'measure.point' && !(await warnIfUncalibrated(t.title))) return;
        setTool(t.id);
      },
    })),
    {
      id: 'view.scaleBar',
      title: 'Show scale bar',
      menu: 'View',
      section: 'overlays',
      icon: Ruler,
      needsProject: true,
      checked: () => useOverlayPrefs.getState().scaleBar,
      run: () => useOverlayPrefs.getState().toggle('scaleBar'),
    },
    {
      id: 'view.northArrow',
      title: 'Show north arrow',
      menu: 'View',
      section: 'overlays',
      icon: Compass,
      needsProject: true,
      checked: () => useOverlayPrefs.getState().northArrow,
      run: () => useOverlayPrefs.getState().toggle('northArrow'),
    },
  ]);
  return () => {
    unRenderer();
    unResult();
    unTool();
    unCmds();
    const i = extraDialogs.indexOf(entry);
    if (i >= 0) extraDialogs.splice(i, 1);
  };
}
