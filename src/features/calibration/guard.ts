import { nowIso } from '@/core/ids';
import type { Drawing, Project } from '@/core/types';
import { getProject } from '@/store/project';
import { defaultUnitScale, getModel } from '@/underlay/models';

import { nativeUnitsLabel } from '@/features/units/format';

import { cadUnitsCalibration } from './compute';
import { askGuard } from './prompts';
import { applyPlacementChange } from './recalibrate';
import { openCalibration } from './store';

/**
 * Calibration guard (row 32). Measurement, offset and contour tools call
 * `await warnIfUncalibrated('Measure distance')` before starting; it resolves true when the tool may
 * proceed. When a visible drawing is uncalibrated the user can calibrate first, confirm the CAD file
 * units in one click, or continue anyway (remembered per drawing for the session).
 */

const acknowledged = new Map<string, Set<string>>();

/** CAD drawings with known header units can be confirmed without picking points (row 30). */
export function hasKnownUnits(d: Drawing): boolean {
  if (d.source.kind === 'pdf') return false;
  if (d.unitsOverride) return true;
  return !!d.nativeUnits && d.nativeUnits !== 'unitless' && d.nativeUnits !== 'pt';
}

export function uncalibratedDrawings(project: Project, ids?: readonly string[]): Drawing[] {
  return project.drawings.filter((d) => d.visible && !d.calibration && (!ids || ids.includes(d.id)));
}

/** Confirms the header (or overridden) units of CAD drawings as their calibration (row 30). */
export async function confirmCadUnits(drawings: readonly Drawing[]): Promise<number> {
  let n = 0;
  for (const d of drawings) {
    if (!hasKnownUnits(d)) continue;
    const f = defaultUnitScale(d, getModel(d.id)?.result?.insunits);
    const ok = await applyPlacementChange(d.id, `Confirm units of “${d.name}”`, (x) => {
      x.calibration = cadUnitsCalibration(f, nowIso());
    });
    if (ok) n++;
  }
  return n;
}

export async function warnIfUncalibrated(
  actionName: string,
  opts: { drawingIds?: readonly string[] } = {},
): Promise<boolean> {
  const project = getProject();
  if (!project) return false;
  let seen = acknowledged.get(project.id);
  if (!seen) acknowledged.set(project.id, (seen = new Set()));
  const pending = uncalibratedDrawings(project, opts.drawingIds).filter((d) => !seen.has(d.id));
  if (!pending.length) return true;
  const choice = await askGuard({
    action: actionName,
    drawings: pending.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.source.kind.toUpperCase(),
      units: nativeUnitsLabel(d, getModel(d.id)?.result?.insunits),
    })),
    confirmable: pending.some(hasKnownUnits),
  });
  switch (choice) {
    case 'continue':
      for (const d of pending) seen.add(d.id);
      return true;
    case 'calibrate':
      openCalibration(pending[0].id);
      return false;
    case 'confirm-units': {
      await confirmCadUnits(pending);
      const left = uncalibratedDrawings(getProject() ?? project, opts.drawingIds).filter(
        (d) => !seen.has(d.id),
      );
      if (!left.length) return true;
      return warnIfUncalibrated(actionName, opts);
    }
    default:
      return false;
  }
}

/** Clears the "continue anyway" memory (tests, project switch). */
export function resetGuardMemory() {
  acknowledged.clear();
}
