import type { Drawing, Project } from '@/core/types';
import { formatLength, UNIT_LABEL } from '@/core/units';

/**
 * Calibration statement for exports (row 32): every output that can carry distances states the
 * calibration state of each drawing — Uncalibrated, Calibrated (method, RMS) or Verified — so
 * exported distances never appear without it. Computed from the data model only
 * (`Drawing.calibration`, `Drawing.verified`).
 */

export type CalibrationState = 'uncalibrated' | 'calibrated' | 'verified';

export function drawingCalibrationState(d: Drawing): CalibrationState {
  if (!d.calibration) return 'uncalibrated';
  return d.verified ? 'verified' : 'calibrated';
}

export const STATE_LABEL: Record<CalibrationState, string> = {
  uncalibrated: 'Uncalibrated',
  calibrated: 'Calibrated',
  verified: 'Verified',
};

const METHOD_LABEL: Record<NonNullable<Drawing['calibration']>['method'], string> = {
  'cad-units': 'CAD units',
  'two-point': 'two-point distance',
  'multi-point': 'multi-reference fit',
  ratio: 'stated ratio',
  coordinates: 'plant coordinates',
};

export interface DrawingCalibrationInfo {
  drawingId: string;
  name: string;
  state: CalibrationState;
  /** Method description, e.g. "two-point distance" or "stated ratio 1:500". */
  method: string;
  /** RMS residual in metres when the method reports one. */
  rms?: number;
  /** Check-distance verification. */
  verified?: { at: string; expected: number; measured: number };
  /** One-line statement. */
  text: string;
}

function unitsText(d: Drawing): string {
  if (d.source.kind === 'pdf') return 'PDF points at 1:1';
  const u = d.unitsOverride ?? (d.nativeUnits && d.nativeUnits !== 'pt' ? d.nativeUnits : undefined);
  if (!u || u === 'unitless') return 'unitless drawing units read as metres';
  return `drawing units read as ${UNIT_LABEL[u]}`;
}

export function drawingCalibrationInfo(project: Project, d: Drawing): DrawingCalibrationInfo {
  const { units, precision } = project.display;
  const len = (m: number) => formatLength(m, units, Math.max(precision, 3));
  const state = drawingCalibrationState(d);
  const c = d.calibration;
  let method = '';
  if (c) {
    method = METHOD_LABEL[c.method] ?? c.method;
    if (c.method === 'ratio' && c.ratio) method += ` 1:${c.ratio}`;
    if (c.separateXY) method += ', separate X/Y scale';
  }
  let text: string;
  if (state === 'uncalibrated') {
    text = `“${d.name}”: Uncalibrated — ${unitsText(d)}; distances are not verified`;
  } else {
    const parts = [method];
    if (c?.residualRms !== undefined && Number.isFinite(c.residualRms))
      parts.push(`RMS ${len(c.residualRms)}`);
    text = `“${d.name}”: ${STATE_LABEL[state]} (${parts.join(', ')})`;
    if (state === 'verified' && d.verified) {
      const v = d.verified;
      text += ` — check distance ${len(v.measured)} measured vs ${len(v.expected)} expected`;
    }
  }
  const info: DrawingCalibrationInfo = { drawingId: d.id, name: d.name, state, method, text };
  if (c?.residualRms !== undefined) info.rms = c.residualRms;
  if (d.verified) info.verified = { ...d.verified };
  return info;
}

/** Drawings that the statement covers: the exported (visible) ones, or all when none are visible. */
export function statementDrawings(project: Project, includeUnderlay = true): Drawing[] {
  const visible = project.drawings.filter((d) => d.visible);
  const list = includeUnderlay && visible.length ? visible : project.drawings;
  return [...list].sort((a, b) => a.order - b.order);
}

/** Overall state: the weakest of the drawings ('uncalibrated' when there are none). */
export function overallCalibrationState(drawings: readonly Drawing[]): CalibrationState {
  if (!drawings.length) return 'uncalibrated';
  const s = drawings.map(drawingCalibrationState);
  return s.includes('uncalibrated') ? 'uncalibrated' : s.includes('calibrated') ? 'calibrated' : 'verified';
}

/** Statement lines: a heading line followed by one line per drawing. */
export function calibrationStatement(project: Project, includeUnderlay = true): string[] {
  const drawings = statementDrawings(project, includeUnderlay);
  if (!drawings.length)
    return ['Calibration: no drawing — coordinates are as entered (world metres); scale not verified'];
  const overall = overallCalibrationState(drawings);
  const lines = [`Calibration: ${STATE_LABEL[overall]}`];
  for (const d of drawings) lines.push(drawingCalibrationInfo(project, d).text);
  return lines;
}
