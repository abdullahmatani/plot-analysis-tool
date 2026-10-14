import { toast } from 'sonner';

import { apply, transformBounds } from '@/core/affine';
import { nowIso } from '@/core/ids';
import type { Affine2D, Drawing, Pt } from '@/core/types';
import { canvasController } from '@/render/canvas-controller';
import { getModel } from '@/underlay/models';
import { drawingPlacement } from '@/underlay/pick';

import { focusCanvas } from '@/features/units/canvas-slot';

import { drawingOf, insunitsOf } from './actions';
import { composeAlignment, describeSimilarity, sharedCoordinates, twoPointAlignment } from './compute';
import { cancelPick, startPick } from './pick';
import { applyPlacementChange } from './recalibrate';
import { closeSession, useCalStore, type AlignSession } from './store';

/**
 * Sub-drawing alignment (row 34): two-point alignment (pick two points on the sub-drawing and the two
 * matching points on the plot plan → similarity) or shared coordinates (the sub-drawing is already in
 * the base's coordinate system → same placement as the base).
 */

const session = (): AlignSession | null => {
  const s = useCalStore.getState().session;
  return s?.kind === 'align' ? s : null;
};
const update = (fn: (s: AlignSession) => void) => useCalStore.getState().update('align', fn);

/** Pick order: source 1 (sub), destination 1 (base), source 2, destination 2. */
export const ALIGN_STEPS: { list: 'src' | 'dst'; index: number }[] = [
  { list: 'src', index: 0 },
  { list: 'dst', index: 0 },
  { list: 'src', index: 1 },
  { list: 'dst', index: 1 },
];

export function zoomToDrawing(d: Drawing | undefined) {
  const m = d ? getModel(d.id) : undefined;
  if (!d || !m?.result) return;
  canvasController()?.zoomToBounds(transformBounds(drawingPlacement(d), m.result.extents));
}

function pickStep(step: number) {
  const s = session();
  if (!s || !s.baseId) return;
  const st = ALIGN_STEPS[step];
  const onSub = st.list === 'src';
  const target = onSub ? s.drawingId : s.baseId;
  const sub = drawingOf(s.drawingId);
  const base = drawingOf(s.baseId);
  update((x) => void (x.step = step));
  startPick({
    drawingId: target,
    count: 1,
    prompt: () =>
      onSub
        ? `Align: pick point ${st.index + 1} on “${sub?.name ?? 'sub-drawing'}”`
        : `Align: pick the matching point ${st.index + 1} on “${base?.name ?? 'plot plan'}”`,
    onPoint: (_w, p) =>
      update((x) => {
        x[st.list][st.index] = p;
      }),
    onDone: () => {
      if (step + 1 < ALIGN_STEPS.length) setTimeout(() => pickStep(step + 1), 0);
      else update((x) => void (x.step = null));
    },
    onCancel: () => update((x) => void (x.step = null)),
  });
  focusCanvas();
}

export function startAlignPicks() {
  update((x) => {
    x.src = [null, null];
    x.dst = [null, null];
  });
  pickStep(0);
}

export function stopAlignPicks() {
  cancelPick();
  update((x) => void (x.step = null));
}

export interface AlignPreview {
  correction: Affine2D | null;
  scale?: number;
  rotation?: number;
  /** Largest distance between matched points after alignment (0 unless the scale is kept). */
  mismatch?: number;
  error: string | null;
}

export function previewAlignment(s: AlignSession): AlignPreview {
  const sub = drawingOf(s.drawingId);
  const base = drawingOf(s.baseId);
  if (!sub || !base) return { correction: null, error: 'Choose the drawing to align to.' };
  if (s.src.some((p) => !p) || s.dst.some((p) => !p)) return { correction: null, error: null };
  const ps = drawingPlacement(sub);
  const pb = drawingPlacement(base);
  const src = s.src.map((p) => apply(ps, p as Pt)) as [Pt, Pt];
  const dst = s.dst.map((p) => apply(pb, p as Pt)) as [Pt, Pt];
  try {
    const correction = twoPointAlignment(src, dst, s.keepScale);
    const mismatch = Math.max(
      ...src.map((p, i) => {
        const q = apply(correction, p);
        return Math.hypot(q.x - dst[i].x, q.y - dst[i].y);
      }),
    );
    return { correction, ...describeSimilarity(correction), mismatch, error: null };
  } catch (e) {
    return { correction: null, error: (e as Error).message };
  }
}

export async function applyTwoPointAlignment(s: AlignSession): Promise<boolean> {
  const sub = drawingOf(s.drawingId);
  const base = drawingOf(s.baseId);
  const p = previewAlignment(s);
  if (!sub || !base || !p.correction) return false;
  const alignment = composeAlignment(p.correction, sub.alignment);
  const ok = await applyPlacementChange(sub.id, `Align “${sub.name}” to “${base.name}”`, (d) => {
    d.alignment = [...alignment] as Affine2D;
  });
  if (ok) {
    toast.success(`Aligned “${sub.name}” to “${base.name}”`);
    closeSession();
  }
  return ok;
}

export async function applySharedCoordinates(s: AlignSession): Promise<boolean> {
  const sub = drawingOf(s.drawingId);
  const base = drawingOf(s.baseId);
  if (!sub || !base) return false;
  const patch = sharedCoordinates(base, insunitsOf(base.id), nowIso());
  const ok = await applyPlacementChange(
    sub.id,
    `Place “${sub.name}” in the coordinates of “${base.name}”`,
    (d) => {
      if (patch.calibration) d.calibration = structuredClone(patch.calibration);
      else delete d.calibration;
      if (patch.alignment) d.alignment = [...patch.alignment] as Affine2D;
      else delete d.alignment;
      if (patch.unitsOverride) d.unitsOverride = patch.unitsOverride;
      else delete d.unitsOverride;
    },
  );
  if (ok) {
    toast.success(`“${sub.name}” now shares the coordinates of “${base.name}”`);
    closeSession();
  }
  return ok;
}

export async function resetAlignment(drawingId: string): Promise<boolean> {
  const d = drawingOf(drawingId);
  if (!d?.alignment) return false;
  return applyPlacementChange(drawingId, `Remove alignment of “${d.name}”`, (x) => {
    delete x.alignment;
  });
}
