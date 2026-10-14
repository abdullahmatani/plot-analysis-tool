import { toast } from 'sonner';

import { transformBounds } from '@/core/affine';
import { nowIso } from '@/core/ids';
import type { Drawing, Geometry, Project, Pt } from '@/core/types';
import { METRES_PER_PT } from '@/core/units';
import { commit, getProject } from '@/store/project';
import { defaultUnitScale, getModel } from '@/underlay/models';
import { drawingPlacement } from '@/underlay/pick';

import { addMeasurement, prepareMeasurement, pushMeasurement } from '@/features/measure/annotations';
import { focusCanvas } from '@/features/units/canvas-slot';
import { fmtLength } from '@/features/units/format';

import { cadUnitsCalibration, ratioCalibration } from './compute';
import { cancelPick, startPick } from './pick';
import { openCheck, parseDisplayLength, useCalStore, type CheckSession } from './store';

/**
 * "Check distance" (row 32): measure a dimension that was not used for calibration and compare it with
 * its known value. Within tolerance the drawing is marked Verified (an uncalibrated drawing whose
 * units check out is confirmed at its current scale).
 */

const session = (): CheckSession | null => {
  const s = useCalStore.getState().session;
  return s?.kind === 'check' ? s : null;
};
const update = (fn: (s: CheckSession) => void) => useCalStore.getState().update('check', fn);

/** Visible drawings whose world extents contain a point, top-most first. */
export function drawingsAt(project: Project, p: Pt): Drawing[] {
  return [...project.drawings]
    .filter((d) => d.visible)
    .sort((a, b) => b.order - a.order)
    .filter((d) => {
      const ext = getModel(d.id)?.result?.extents;
      if (!ext) return false;
      const b = transformBounds(drawingPlacement(d), ext);
      return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
    });
}

/** Default tolerance: 0.1 % of the known distance, at least 1 mm (NFR-7). */
export function defaultTolerance(expected: number): number {
  return Math.max(0.001, Math.abs(expected) * 0.001);
}

export function startCheckPicks() {
  const s = session();
  if (!s) return;
  update((x) => {
    x.a = null;
    x.b = null;
    x.result = null;
    x.picking = true;
  });
  startPick({
    drawingId: s.drawingId,
    count: 2,
    prompt: (i) => `Check distance: pick ${i === 0 ? 'the first' : 'the second'} end of a known dimension`,
    onPoint: (w, _d, i) =>
      update((x) => {
        if (i === 0) x.a = w;
        else x.b = w;
      }),
    onDone: () => {
      const cur = session();
      const p = getProject();
      update((x) => {
        x.picking = false;
        if (!x.drawingId && p && x.a && x.b) {
          const under = drawingsAt(p, x.a).filter((d) => drawingsAt(p, x.b!).some((e) => e.id === d.id));
          x.drawingId = under[0]?.id ?? null;
        }
      });
      if (cur)
        setTimeout(
          () => document.querySelector<HTMLInputElement>('[data-testid="check-known"]')?.focus(),
          30,
        );
    },
    onCancel: () => update((x) => void (x.picking = false)),
  });
  focusCanvas();
}

export function beginCheck() {
  openCheck();
  startCheckPicks();
}

export function stopCheckPicks() {
  cancelPick();
  update((x) => void (x.picking = false));
}

export function measuredDistance(s: CheckSession): number | null {
  return s.a && s.b ? Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) : null;
}

/** Runs the check; marks the drawing Verified when within tolerance. */
export function runCheck(keepAnnotation: boolean): boolean {
  const s = session();
  const p = getProject();
  if (!s || !p) return false;
  const measured = measuredDistance(s);
  const expected = parseDisplayLength(s.value);
  if (measured === null || expected === null || !(expected > 0)) {
    toast.error('Pick two points and enter the known distance.');
    return false;
  }
  const tolText = s.tolerance.trim();
  const tolerance = tolText ? parseDisplayLength(tolText) : defaultTolerance(expected);
  if (tolerance === null || !(tolerance >= 0)) {
    toast.error('Enter a valid tolerance.');
    return false;
  }
  const diff = measured - expected;
  const pass = Math.abs(diff) <= tolerance;
  update((x) => void (x.result = { measured, expected, diff, tolerance, pass }));
  const d = s.drawingId ? p.drawings.find((x) => x.id === s.drawingId) : undefined;
  const display = p.display;
  const geometry: Geometry | null = s.a && s.b ? { type: 'polyline', pts: [s.a, s.b], closed: false } : null;
  if (pass && d) {
    const at = nowIso();
    const insunits = getModel(d.id)?.result?.insunits;
    const confirm = !d.calibration
      ? d.source.kind === 'pdf'
        ? ratioCalibration(1, METRES_PER_PT, at)
        : cadUnitsCalibration(defaultUnitScale(d, insunits), at)
      : null;
    const keep = keepAnnotation && geometry ? prepareMeasurement(p, geometry, 'check', expected) : null;
    commit(`Verify calibration of “${d.name}”`, (draft) => {
      const x = draft.drawings.find((y) => y.id === d.id);
      if (!x) return;
      if (confirm) x.calibration = confirm;
      x.verified = { at, expected, measured };
      if (keep) pushMeasurement(draft, keep);
    });
    toast.success(`“${d.name}” verified`, {
      description: `Measured ${fmtLength(measured, display)} against ${fmtLength(expected, display)} (difference ${fmtLength(diff, { ...display, precision: display.precision + 1 })}).`,
    });
    return pass;
  }
  if (!pass) {
    toast.warning('Check failed — the calibration does not match this dimension', {
      description: `Measured ${fmtLength(measured, display)}, expected ${fmtLength(expected, display)}. Recalibrate the drawing or check the picked points.`,
    });
  } else {
    toast.info('Check passed. Choose the drawing to mark as verified.');
  }
  if (keepAnnotation && geometry) addMeasurement(geometry, 'check', expected, 'Add check measurement');
  return pass;
}
