import { toast } from 'sonner';

import { nowIso } from '@/core/ids';
import type { Calibration, Drawing, Units } from '@/core/types';
import { METRES_PER, METRES_PER_PT } from '@/core/units';
import { getProject } from '@/store/project';
import { defaultUnitScale, getModel } from '@/underlay/models';

import { focusCanvas } from '@/features/units/canvas-slot';
import { fmtLength } from '@/features/units/format';

import {
  cadUnitsCalibration,
  distanceCalibration,
  equivalentRatio,
  metresPerUnit,
  minPoints,
  pointCalibration,
  ratioCalibration,
  sheetFactor,
  twoPointCalibration,
  type DistanceInput,
  type FitReport,
  type PointInput,
} from './compute';
import { cancelPick, startPick } from './pick';
import { applyPlacementChange } from './recalibrate';
import {
  closeSession,
  parseDisplayLength,
  useCalStore,
  type CalibrateSession,
  type DistanceRow,
  type PointRow,
} from './store';

/** Calibration panel actions: starting picks and applying calibrations (rows 28–31). */

export function drawingOf(id: string | null | undefined): Drawing | undefined {
  return id ? getProject()?.drawings.find((d) => d.id === id) : undefined;
}

export function insunitsOf(id: string): number | undefined {
  return getModel(id)?.result?.insunits;
}

/** Short unit name of a drawing's own coordinates ("pt", "m", "units"). */
export function drawingUnitName(d: Drawing): string {
  if (d.source.kind === 'pdf') return 'pt';
  const u = d.unitsOverride ?? d.nativeUnits;
  return u && u !== 'unitless' && u !== 'pt' ? u : 'units';
}

const session = (): CalibrateSession | null => {
  const s = useCalStore.getState().session;
  return s?.kind === 'calibrate' ? s : null;
};

const update = (fn: (s: CalibrateSession) => void) => useCalStore.getState().update('calibrate', fn);

function focusValue(testId: string) {
  setTimeout(() => document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)?.focus(), 30);
}

// ------------------------------------------------------------------------------------- picking

export function pickTwoPoint() {
  const s = session();
  if (!s) return;
  update((x) => {
    x.twoPoint.a = null;
    x.twoPoint.b = null;
    x.picking = { list: 'twoPoint', index: 0 };
  });
  startPick({
    drawingId: s.drawingId,
    count: 2,
    prompt: (i) =>
      `Scale from a known distance: pick ${i === 0 ? 'the first' : 'the second'} end of the dimension`,
    onPoint: (_w, p, i) =>
      update((x) => {
        if (i === 0) x.twoPoint.a = p;
        else x.twoPoint.b = p;
      }),
    onDone: () => {
      update((x) => void (x.picking = null));
      focusValue('cal-real-length');
    },
    onCancel: () => update((x) => void (x.picking = null)),
  });
  focusCanvas();
}

/** Picks the two ends of a reference distance (a new row when index is undefined). */
export function pickDistance(index?: number) {
  const s = session();
  if (!s) return;
  const i = index ?? s.distances.length;
  update((x) => {
    if (index === undefined) x.distances.push({ a: null, b: null, value: '' });
    else x.distances[i] = { ...x.distances[i], a: null, b: null };
    x.picking = { list: 'distances', index: i };
  });
  startPick({
    drawingId: s.drawingId,
    count: 2,
    prompt: (k) => `Reference ${i + 1}: pick ${k === 0 ? 'the first' : 'the second'} end of a known distance`,
    onPoint: (_w, p, k) =>
      update((x) => {
        const row = x.distances[i];
        if (!row) return;
        if (k === 0) row.a = p;
        else row.b = p;
      }),
    onDone: () => {
      update((x) => void (x.picking = null));
      focusValue(`cal-ref-value-${i}`);
    },
    onCancel: () =>
      update((x) => {
        x.picking = null;
        const row = x.distances[i];
        if (row && (!row.a || !row.b) && index === undefined) x.distances.splice(i, 1);
      }),
  });
  focusCanvas();
}

/** Picks a point with known coordinates (references "points" mode or plant coordinates). */
export function pickPoint(list: 'points' | 'coords', index?: number) {
  const s = session();
  if (!s) return;
  const rows = s[list];
  const i = index ?? rows.length;
  update((x) => {
    if (index === undefined) x[list].push({ p: null, x: '', y: '' });
    else x[list][i] = { ...x[list][i], p: null };
    x.picking = { list, index: i };
  });
  startPick({
    drawingId: s.drawingId,
    count: 1,
    prompt: () =>
      list === 'coords'
        ? `Plant coordinates: pick point ${i + 1} (e.g. a grid intersection with known E/N)`
        : `Reference point ${i + 1}: pick a point with known coordinates`,
    onPoint: (_w, p) =>
      update((x) => {
        const row = x[list][i];
        if (row) row.p = p;
      }),
    onDone: () => {
      update((x) => void (x.picking = null));
      focusValue(`cal-${list}-x-${i}`);
    },
    onCancel: () =>
      update((x) => {
        x.picking = null;
        const row = x[list][i];
        if (row && !row.p && index === undefined) x[list].splice(i, 1);
      }),
  });
  focusCanvas();
}

export function stopPicking() {
  cancelPick();
  update((x) => void (x.picking = null));
}

// ------------------------------------------------------------------------------------- parsing

export function distanceInputs(rows: readonly DistanceRow[]): { refs: DistanceInput[]; rowIndex: number[] } {
  const refs: DistanceInput[] = [];
  const rowIndex: number[] = [];
  rows.forEach((r, i) => {
    const v = parseDisplayLength(r.value);
    if (r.a && r.b && v !== null && v > 0) {
      refs.push({ a: r.a, b: r.b, distance: v });
      rowIndex.push(i);
    }
  });
  return { refs, rowIndex };
}

export function pointInputs(rows: readonly PointRow[]): { refs: PointInput[]; rowIndex: number[] } {
  const refs: PointInput[] = [];
  const rowIndex: number[] = [];
  rows.forEach((r, i) => {
    const x = parseDisplayLength(r.x);
    const y = parseDisplayLength(r.y);
    if (r.p && x !== null && y !== null) {
      refs.push({ drawing: r.p, world: { x, y } });
      rowIndex.push(i);
    }
  });
  return { refs, rowIndex };
}

export interface Preview {
  calibration: Calibration | null;
  fit: FitReport | null;
  /** Per panel row (undefined for incomplete rows). */
  residuals: (number | undefined)[];
  worstRow: number | null;
  error: string | null;
  needed: number;
  have: number;
}

function emptyPreview(needed: number, have: number, error: string | null = null): Preview {
  return { calibration: null, fit: null, residuals: [], worstRow: null, error, needed, have };
}

export function previewTwoPoint(s: CalibrateSession): Preview {
  const { a, b, value } = s.twoPoint;
  const v = parseDisplayLength(value);
  if (!a || !b) return emptyPreview(2, (a ? 1 : 0) + (b ? 1 : 0));
  if (v === null || !(v > 0))
    return emptyPreview(2, 2, value.trim() ? 'Enter a positive length, e.g. 100 or 100 m.' : null);
  try {
    const calibration = twoPointCalibration(a, b, v, nowIso());
    return { ...emptyPreview(2, 2), calibration };
  } catch (e) {
    return emptyPreview(2, 2, (e as Error).message);
  }
}

export function previewDistances(s: CalibrateSession): Preview {
  const { refs, rowIndex } = distanceInputs(s.distances);
  if (refs.length < 3) return emptyPreview(3, refs.length);
  try {
    const { calibration, fit } = distanceCalibration(refs, s.separateXY, nowIso());
    const residuals: (number | undefined)[] = [];
    rowIndex.forEach((row, k) => (residuals[row] = fit.residuals[k]));
    return {
      calibration,
      fit,
      residuals,
      worstRow: rowIndex[fit.worst],
      error: null,
      needed: 3,
      have: refs.length,
    };
  } catch (e) {
    return emptyPreview(3, refs.length, (e as Error).message);
  }
}

export function previewPoints(s: CalibrateSession, list: 'points' | 'coords'): Preview {
  const rows = s[list];
  const kind = list === 'coords' ? s.coordFit : s.pointFit;
  const needed = list === 'points' ? Math.max(3, minPoints(kind)) : minPoints(kind);
  const { refs, rowIndex } = pointInputs(rows);
  if (refs.length < needed) return emptyPreview(needed, refs.length);
  try {
    const { calibration, fit } = pointCalibration(
      refs,
      kind,
      list === 'coords' ? 'coordinates' : 'multi-point',
      nowIso(),
    );
    const residuals: (number | undefined)[] = [];
    rowIndex.forEach((row, k) => (residuals[row] = fit.residuals[k]));
    return {
      calibration,
      fit,
      residuals,
      worstRow: rowIndex[fit.worst],
      error: null,
      needed,
      have: refs.length,
    };
  } catch (e) {
    return emptyPreview(needed, refs.length, (e as Error).message);
  }
}

export function previewRatio(s: CalibrateSession, d: Drawing): Preview & { factor: number | null } {
  const at = nowIso();
  const ratioText = s.ratio.trim().replace(/^1\s*:\s*/, '');
  const ratio = ratioText ? Number(ratioText.replace(',', '.')) : d.source.kind === 'pdf' ? NaN : 1;
  if (d.source.kind === 'pdf') {
    const page = getModel(d.id)?.result?.page;
    if (!(ratio > 0) || !Number.isFinite(ratio))
      return {
        ...emptyPreview(1, 0, ratioText ? 'Enter the stated scale, e.g. 500 for 1:500.' : null),
        factor: null,
      };
    const f = page ? sheetFactor(page.width, page.height, s.sheet) : 1;
    const unit = METRES_PER_PT * f;
    return { ...emptyPreview(1, 1), calibration: ratioCalibration(ratio, unit, at), factor: unit };
  }
  if (!(ratio > 0) || !Number.isFinite(ratio))
    return {
      ...emptyPreview(1, 0, 'Enter the drawing scale, e.g. 1 for full-size CAD drawings.'),
      factor: null,
    };
  const unitFactor = s.unit
    ? METRES_PER[s.unit]
    : defaultUnitScale({ ...d, unitsOverride: undefined }, insunitsOf(d.id));
  const factor = unitFactor * ratio;
  const calibration =
    ratio === 1 ? cadUnitsCalibration(unitFactor, at) : ratioCalibration(ratio, unitFactor, at);
  return { ...emptyPreview(1, 1), calibration, factor };
}

// ------------------------------------------------------------------------------------- applying

function scaleSummary(d: Drawing, c: Calibration): string {
  const k = metresPerUnit(c.transform);
  const unit = drawingUnitName(d);
  const display = getProject()?.display;
  const per = display ? fmtLength(k, { ...display, precision: Math.max(display.precision, 4) }) : `${k} m`;
  const ratio = d.source.kind === 'pdf' ? ` (≈ 1:${Number(equivalentRatio(k).toPrecision(6))})` : '';
  return `1 ${unit} = ${per}${ratio}`;
}

const METHOD_LABEL: Record<Calibration['method'], string> = {
  'two-point': 'two points',
  'multi-point': 'reference fit',
  ratio: 'stated scale',
  coordinates: 'plant coordinates',
  'cad-units': 'drawing units',
};

/** Applies a calibration with the row-33 prompt; closes the panel on success. */
export async function applyCalibration(
  drawingId: string,
  calibration: Calibration,
  extra?: { unitsOverride?: Units | null },
): Promise<boolean> {
  const d = drawingOf(drawingId);
  if (!d) return false;
  const ok = await applyPlacementChange(
    drawingId,
    `Calibrate “${d.name}” (${METHOD_LABEL[calibration.method]})`,
    (x) => {
      x.calibration = structuredClone(calibration);
      if (extra?.unitsOverride === null) delete x.unitsOverride;
      else if (extra?.unitsOverride) x.unitsOverride = extra.unitsOverride;
    },
  );
  if (ok) {
    toast.success(`Calibrated “${d.name}”`, { description: scaleSummary(d, calibration) });
    closeSession();
  }
  return ok;
}

export async function removeCalibration(drawingId: string): Promise<boolean> {
  const d = drawingOf(drawingId);
  if (!d?.calibration) return false;
  const ok = await applyPlacementChange(drawingId, `Remove calibration of “${d.name}”`, (x) => {
    delete x.calibration;
  });
  if (ok) toast.info(`“${d.name}” is uncalibrated again`);
  return ok;
}

/** Applies the units / ratio tab (CAD: also stores the units override). */
export async function applyRatioTab(s: CalibrateSession): Promise<boolean> {
  const d = drawingOf(s.drawingId);
  if (!d) return false;
  const p = previewRatio(s, d);
  if (!p.calibration) return false;
  if (d.source.kind === 'pdf') return applyCalibration(d.id, p.calibration);
  const native =
    d.nativeUnits && d.nativeUnits !== 'unitless' && d.nativeUnits !== 'pt' ? d.nativeUnits : null;
  const override = s.unit && s.unit !== native ? s.unit : null;
  return applyCalibration(d.id, p.calibration, { unitsOverride: override });
}
