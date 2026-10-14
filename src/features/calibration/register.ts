import { Layers, Ruler, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { registerCommands } from '@/app/commands';
import { extraDialogs } from '@/components/app/extra-dialogs';
import type { DraftRecord } from '@/persistence/db';
import { registerOverlay, requestCanvasRender } from '@/render/canvas-controller';
import { getProject, useProjectStore } from '@/store/project';

import { beginCheck } from './check';
import { AlignDialogAdapter, CalibrateDialogAdapter, CalibrationHost } from './Host';
import { drawSessionOverlay } from './overlay';
import { registerPickTool } from './pick';
import { DRAFT_KEY, openAlignment, openCalibration, useCalStore, type Session } from './store';

/**
 * Scale and calibration (rows 26, 28–34): calibration panel (two points, references, ratio/units,
 * plant coordinates), sub-drawing alignment, "Check distance", the calibration guard and the
 * recalibration prompt. Other tools call `warnIfUncalibrated` from `./guard`.
 */

const canEdit = () => !!getProject() && !useProjectStore.getState().readOnly;
const hasDrawings = () => canEdit() && (getProject()?.drawings.length ?? 0) > 0;

/** The drawing a menu command applies to: the first uncalibrated visible one, else the top-most. */
function defaultDrawing(): string | null {
  const p = getProject();
  if (!p?.drawings.length) return null;
  const sorted = [...p.drawings].sort((a, b) => b.order - a.order);
  return (sorted.find((d) => d.visible && !d.calibration) ?? sorted[0]).id;
}

/** Picking cannot resume after a reload; everything else (points, typed values) can. */
function resumable(s: Session): Session {
  if (s.kind === 'calibrate') return { ...s, picking: null };
  if (s.kind === 'align') return { ...s, step: null };
  return { ...s, picking: false };
}

function onDrafts(e: Event) {
  const drafts = (e as CustomEvent<DraftRecord[]>).detail ?? [];
  const state = drafts.find((x) => x.key === DRAFT_KEY)?.state as { session?: Session } | undefined;
  const session = state?.session;
  const p = getProject();
  if (!session || !p) return;
  if (session.kind !== 'check' && !p.drawings.some((x) => x.id === session.drawingId)) return;
  toast('Unfinished calibration recovered', {
    description: 'Picked points and typed values from before the app closed can be resumed.',
    duration: 30000,
    action: { label: 'Resume', onClick: () => useCalStore.getState().set(resumable(session)) },
  });
}

export function register() {
  registerPickTool();
  const dialogs = [
    { id: 'calibrate', Component: CalibrateDialogAdapter },
    { id: 'align', Component: AlignDialogAdapter },
    { id: 'calibration-host', Component: CalibrationHost },
  ];
  for (const e of dialogs) if (!extraDialogs.some((x) => x.id === e.id)) extraDialogs.push(e);
  const unOverlay = registerOverlay(85, drawSessionOverlay);
  const unStore = useCalStore.subscribe(() => requestCanvasRender());
  window.addEventListener('pat:drafts', onDrafts);
  const unCmds = registerCommands([
    {
      id: 'calibration.calibrate',
      title: 'Calibrate scale…',
      menu: 'View',
      section: 'calibration',
      icon: Ruler,
      keywords: ['scale', 'calibration', 'ratio', 'units', 'plant coordinates', 'two point', 'reference'],
      needsProject: true,
      enabled: hasDrawings,
      run: () => {
        const id = defaultDrawing();
        if (id) openCalibration(id);
      },
    },
    {
      id: 'calibration.align',
      title: 'Align sub-drawing to plot plan…',
      menu: 'View',
      section: 'calibration',
      icon: Layers,
      keywords: ['alignment', 'sub-drawing', 'overlay', 'shared coordinates', 'two point'],
      needsProject: true,
      enabled: () => canEdit() && (getProject()?.drawings.length ?? 0) > 1,
      run: () => {
        const p = getProject();
        const top = p ? [...p.drawings].sort((a, b) => b.order - a.order)[0] : undefined;
        if (top) openAlignment(top.id);
      },
    },
    {
      id: 'calibration.check',
      title: 'Check distance (verify calibration)…',
      menu: 'View',
      section: 'calibration',
      icon: ShieldCheck,
      keywords: ['verify', 'check', 'calibration', 'distance'],
      needsProject: true,
      enabled: hasDrawings,
      run: beginCheck,
    },
  ]);
  return () => {
    unOverlay();
    unStore();
    unCmds();
    window.removeEventListener('pat:drafts', onDrafts);
    for (const e of dialogs) {
      const i = extraDialogs.findIndex((x) => x.id === e.id);
      if (i >= 0) extraDialogs.splice(i, 1);
    }
  };
}
