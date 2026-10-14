import { useEffect, useRef } from 'react';

import { useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';

import { CanvasSlot } from '@/features/units/canvas-slot';

import { AlignPanel } from './AlignPanel';
import { CalibrationPanel } from './CalibrationPanel';
import { CheckPanel } from './CheckPanel';
import { PromptsHost } from './PromptsHost';
import { closeSession, dropSession, openAlignment, openCalibration, useCalStore } from './store';

/** Always-mounted host: canvas panels of the open session and the calibration prompts. */
export function CalibrationHost() {
  const session = useCalStore((s) => s.session);
  const projectId = useProjectStore((s) => s.history?.project.id ?? null);
  const drawingIds = useProjectStore((s) => s.history?.project.drawings.map((d) => d.id).join('|') ?? '');
  const lastProject = useRef(projectId);
  // Close sessions when the project closes or changes, or when their drawing is removed.
  useEffect(() => {
    const changed = lastProject.current !== projectId;
    lastProject.current = projectId;
    const s = useCalStore.getState().session;
    if (!s) return;
    if (!projectId || changed) {
      dropSession();
      return;
    }
    if (s.kind !== 'check' && !drawingIds.split('|').includes(s.drawingId)) closeSession();
  }, [projectId, drawingIds]);
  return (
    <>
      <PromptsHost />
      {session && (
        <CanvasSlot name="top-left">
          {session.kind === 'calibrate' && <CalibrationPanel s={session} />}
          {session.kind === 'align' && <AlignPanel s={session} />}
          {session.kind === 'check' && <CheckPanel s={session} />}
        </CanvasSlot>
      )}
    </>
  );
}

/** `openDialog('calibrate', { drawingId })` (Drawings panel) opens the non-modal calibration panel. */
export function CalibrateDialogAdapter({ open }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  useEffect(() => {
    if (!open) return;
    const payload = useUiStore.getState().dialogPayload as { drawingId?: string; tab?: string } | null;
    useUiStore.getState().closeDialog();
    if (payload?.drawingId) openCalibration(payload.drawingId);
  }, [open]);
  return null;
}

/** `openDialog('align', { drawingId })` opens the alignment panel. */
export function AlignDialogAdapter({ open }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  useEffect(() => {
    if (!open) return;
    const payload = useUiStore.getState().dialogPayload as { drawingId?: string } | null;
    useUiStore.getState().closeDialog();
    if (payload?.drawingId) openAlignment(payload.drawingId);
  }, [open]);
  return null;
}
