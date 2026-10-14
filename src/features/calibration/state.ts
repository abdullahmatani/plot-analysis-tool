import type { Drawing, Project } from '@/core/types';
import { formatNumber } from '@/core/units';
import { calibrationState, type CalibrationState } from '@/underlay/models';

import { equivalentRatio, metresPerUnit } from './compute';

/**
 * Calibration state for outputs (row 32: distances are never exported without the calibration state
 * shown). Exports put `calibrationStatement(project)` on the sheet / in the table header.
 */

const METHOD: Record<string, string> = {
  'two-point': 'two-point scale',
  'multi-point': 'multi-reference fit',
  ratio: 'stated scale',
  coordinates: 'plant coordinates',
  'cad-units': 'drawing units',
};

/** Worst state over the visible drawings (uncalibrated < calibrated < verified); null without drawings. */
export function projectCalibrationState(project: Project): CalibrationState | null {
  const ds = project.drawings.filter((d) => d.visible);
  if (!ds.length) return null;
  const states = ds.map(calibrationState);
  if (states.includes('uncalibrated')) return 'uncalibrated';
  if (states.includes('calibrated')) return 'calibrated';
  return 'verified';
}

/** One line per drawing, e.g. "Plot plan: VERIFIED — stated scale 1:500 (check 300.000 m)". */
export function drawingCalibrationLine(d: Drawing): string {
  const state = calibrationState(d);
  const c = d.calibration;
  if (!c) {
    const why = d.source.kind === 'pdf' ? 'paper size 1:1, not to scale' : 'file units not confirmed';
    return `${d.name}: UNCALIBRATED (${why})`;
  }
  const parts = [METHOD[c.method] ?? c.method];
  if (c.ratio) parts.push(`1:${formatNumber(c.ratio, 0).replace(/\s/g, '')}`);
  else if (d.source.kind === 'pdf')
    parts.push(`≈ 1:${Number(equivalentRatio(metresPerUnit(c.transform)).toPrecision(5))}`);
  if (c.residualRms !== undefined && c.references.length > 2) parts.push(`RMS ${c.residualRms.toFixed(3)} m`);
  const check = d.verified ? ` (checked against ${d.verified.expected.toFixed(3)} m)` : '';
  return `${d.name}: ${state === 'verified' ? 'VERIFIED' : 'CALIBRATED'} — ${parts.join(', ')}${check}`;
}

/** Calibration statement for an export: overall state and one line per visible drawing. */
export function calibrationStatement(project: Project): string {
  const state = projectCalibrationState(project);
  if (!state) return 'Calibration: no drawing (world coordinates in metres)';
  const head =
    state === 'uncalibrated'
      ? 'Calibration: UNCALIBRATED — distances are not verified to scale'
      : state === 'verified'
        ? 'Calibration: verified'
        : 'Calibration: calibrated';
  return [head, ...project.drawings.filter((d) => d.visible).map(drawingCalibrationLine)].join('\n');
}
