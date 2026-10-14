import { multiply } from '@/core/affine';
import type { Affine2D, Calibration, CalibrationReference, Drawing, Pt, Units } from '@/core/types';
import { METRES_PER_PT } from '@/core/units';
import {
  fitAffine,
  fitDistanceScale,
  fitDistanceScaleXY,
  fitScaleXYTranslation,
  fitSimilarity,
  ratioTransform,
  scaleFromTwoPoints,
  uniformScaleTransform,
  type DistanceScaleFit,
  type PointFit,
  type ResidualReport,
} from '@/geometry/calibration';
import { defaultUnitScale } from '@/underlay/models';

import { unitForFactor } from '@/features/units/format';

/**
 * Builds `Calibration` records (drawing units → world metres) from user input (rows 28–31) and
 * sub-drawing alignments (row 34). Pure functions: picked points are in drawing units, real values
 * in metres; nothing is rounded.
 */

export interface DistanceInput {
  a: Pt;
  b: Pt;
  /** Real distance, metres. */
  distance: number;
}

export interface PointInput {
  /** Drawing units. */
  drawing: Pt;
  /** World metres (or plant E/N for the coordinates method). */
  world: Pt;
}

export type PointFitKind = 'similarity' | 'scale-xy' | 'affine';

export interface FitReport extends ResidualReport {
  /** Uniform scale, metres per drawing unit. */
  scale: number;
  kx?: number;
  ky?: number;
  /** Rotation of the drawing x axis in the world (radians CCW), point fits only. */
  rotation?: number;
}

/** Row 28: two picked points and their real distance → uniform scale. */
export function twoPointCalibration(a: Pt, b: Pt, metres: number, at: string): Calibration {
  const k = scaleFromTwoPoints(a, b, metres);
  return {
    method: 'two-point',
    transform: uniformScaleTransform(k),
    references: [
      { drawing: { ...a }, world: null, pair: 1, distance: metres },
      { drawing: { ...b }, world: null, pair: 0, distance: metres },
    ],
    at,
  };
}

/** Row 29: least-squares scale from ≥ 1 reference distances (UI requires 3), optionally separate X/Y. */
export function distanceCalibration(
  refs: readonly DistanceInput[],
  separateXY: boolean,
  at: string,
): { calibration: Calibration; fit: FitReport } {
  const f: DistanceScaleFit & { kx?: number; ky?: number } = separateXY
    ? fitDistanceScaleXY(refs)
    : fitDistanceScale(refs);
  const references: CalibrationReference[] = [];
  refs.forEach((r, i) => {
    references.push(
      { drawing: { ...r.a }, world: null, pair: 2 * i + 1, distance: r.distance, residual: f.residuals[i] },
      { drawing: { ...r.b }, world: null, pair: 2 * i, distance: r.distance, residual: f.residuals[i] },
    );
  });
  const xy = f.kx !== undefined ? { kx: f.kx, ky: f.ky } : {};
  return {
    calibration: {
      method: 'multi-point',
      transform: f.transform,
      references,
      residualRms: f.rms,
      separateXY,
      at,
    },
    fit: { residuals: f.residuals, rms: f.rms, worst: f.worst, scale: f.k, ...xy },
  };
}

function pointFit(refs: readonly PointInput[], kind: PointFitKind): PointFit & { kx?: number; ky?: number } {
  if (kind === 'affine') return fitAffine(refs);
  if (kind === 'scale-xy') return fitScaleXYTranslation(refs);
  return fitSimilarity(refs);
}

/** Minimum number of point references for a fit kind. */
export function minPoints(kind: PointFitKind): number {
  return kind === 'similarity' ? 2 : 3;
}

/**
 * Rows 29 and 31: least-squares fit to ≥ 2 points with known world (or plant E/N) coordinates.
 * Similarity = scale + rotation + translation; 'scale-xy' adds separate X/Y scales; 'affine' is general.
 */
export function pointCalibration(
  refs: readonly PointInput[],
  kind: PointFitKind,
  method: 'multi-point' | 'coordinates',
  at: string,
): { calibration: Calibration; fit: FitReport } {
  const f = pointFit(refs, kind);
  return {
    calibration: {
      method,
      transform: f.transform,
      references: refs.map((r, i) => ({
        drawing: { ...r.drawing },
        world: { ...r.world },
        residual: f.residuals[i],
      })),
      residualRms: f.rms,
      separateXY: kind !== 'similarity',
      at,
    },
    fit: {
      residuals: f.residuals,
      rms: f.rms,
      worst: f.worst,
      scale: f.scale,
      rotation: f.rotation,
      ...(f.kx !== undefined ? { kx: f.kx, ky: f.ky } : {}),
    },
  };
}

/**
 * Row 30: stated ratio. For PDFs `unitToMetres` is the paper size of one point (scaled when the stated
 * ratio refers to another sheet size); for CAD it is the confirmed unit-to-metre factor.
 */
export function ratioCalibration(ratio: number, unitToMetres: number, at: string): Calibration {
  return { method: 'ratio', transform: ratioTransform(ratio, unitToMetres), references: [], ratio, at };
}

/** Row 30 (CAD): confirmed drawing unit → metres factor. */
export function cadUnitsCalibration(unitToMetres: number, at: string): Calibration {
  if (!(unitToMetres > 0) || !Number.isFinite(unitToMetres))
    throw new Error('The unit factor must be positive');
  return { method: 'cad-units', transform: uniformScaleTransform(unitToMetres), references: [], at };
}

/** Stated 1:N equivalent of a PDF calibration scale (metres per point). */
export function equivalentRatio(metresPerPt: number): number {
  return metresPerPt / METRES_PER_PT;
}

// ------------------------------------------------------------------------------------------ paper

export interface PaperSize {
  name: string;
  w: number;
  h: number;
}

/** Sheet sizes in millimetres (portrait). */
export const PAPER_SIZES: PaperSize[] = [
  { name: 'A0', w: 841, h: 1189 },
  { name: 'A1', w: 594, h: 841 },
  { name: 'A2', w: 420, h: 594 },
  { name: 'A3', w: 297, h: 420 },
  { name: 'A4', w: 210, h: 297 },
  { name: 'ANSI A', w: 215.9, h: 279.4 },
  { name: 'ANSI B', w: 279.4, h: 431.8 },
  { name: 'ANSI C', w: 431.8, h: 558.8 },
  { name: 'ANSI D', w: 558.8, h: 863.6 },
  { name: 'ANSI E', w: 863.6, h: 1117.6 },
];

export const PT_TO_MM = 25.4 / 72;

/** Standard sheet name for a page size in points (either orientation, ±1 mm), or null. */
export function paperName(widthPt: number, heightPt: number): string | null {
  const w = widthPt * PT_TO_MM;
  const h = heightPt * PT_TO_MM;
  const lo = Math.min(w, h);
  const hi = Math.max(w, h);
  return PAPER_SIZES.find((p) => Math.abs(p.w - lo) <= 1 && Math.abs(p.h - hi) <= 1)?.name ?? null;
}

/**
 * Size factor when the stated scale refers to another sheet than the PDF page (e.g. an A1 drawing
 * plotted to an A3 PDF): ratio of the long sides. 1 when `target` is null.
 */
export function sheetFactor(widthPt: number, heightPt: number, target: string | null): number {
  if (!target) return 1;
  const p = PAPER_SIZES.find((s) => s.name === target);
  if (!p) return 1;
  return p.h / (Math.max(widthPt, heightPt) * PT_TO_MM);
}

// ------------------------------------------------------------------------------------ alignment

/**
 * Row 34: world → world similarity that maps two source points (on the sub-drawing) onto two
 * destination points (on the plot plan). With `keepScale` only rotation and translation are fitted
 * (the sub-drawing keeps its calibrated scale; the midpoints coincide).
 */
export function twoPointAlignment(
  src: readonly [Pt, Pt],
  dst: readonly [Pt, Pt],
  keepScale: boolean,
): Affine2D {
  const ls = Math.hypot(src[1].x - src[0].x, src[1].y - src[0].y);
  const ld = Math.hypot(dst[1].x - dst[0].x, dst[1].y - dst[0].y);
  if (!(ls > 0) || !(ld > 0)) throw new Error('The two points of each pair must be different');
  if (!keepScale) {
    return fitSimilarity([
      { drawing: src[0], world: dst[0] },
      { drawing: src[1], world: dst[1] },
    ]).transform;
  }
  const theta =
    Math.atan2(dst[1].y - dst[0].y, dst[1].x - dst[0].x) -
    Math.atan2(src[1].y - src[0].y, src[1].x - src[0].x);
  // Rotate about the source midpoint, then move it onto the destination midpoint (local coordinates
  // keep precision at plant-sized coordinates).
  const ms = { x: (src[0].x + src[1].x) / 2, y: (src[0].y + src[1].y) / 2 };
  const md = { x: (dst[0].x + dst[1].x) / 2, y: (dst[0].y + dst[1].y) / 2 };
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c, s, -s, c, md.x - (c * ms.x - s * ms.y), md.y - (s * ms.x + c * ms.y)];
}

/** Describes a similarity: scale, rotation (radians CCW) and translation. */
export function describeSimilarity(m: Affine2D): { scale: number; rotation: number } {
  return { scale: Math.hypot(m[0], m[1]), rotation: Math.atan2(m[1], m[0]) };
}

/** New alignment after applying a world → world correction `s` to a drawing placed with `alignment`. */
export function composeAlignment(s: Affine2D, alignment: Affine2D | undefined): Affine2D {
  return alignment ? multiply(s, alignment) : s;
}

/**
 * Row 34 "shared coordinates": the sub-drawing is drawn in the same coordinate system as the base,
 * so it gets the base's placement: the base calibration (or, when the base is uncalibrated, its unit
 * scaling) and alignment. Returns the drawing fields to set on the sub-drawing.
 */
export function sharedCoordinates(
  base: Drawing,
  baseInsunits: number | undefined,
  at: string,
): Pick<Drawing, 'calibration' | 'alignment' | 'unitsOverride'> {
  const alignment = base.alignment ? ([...base.alignment] as Affine2D) : undefined;
  if (base.calibration) {
    return {
      calibration: structuredClone({ ...base.calibration, at }),
      alignment,
      unitsOverride: undefined,
    };
  }
  const f = defaultUnitScale(base, baseInsunits);
  const unit: Units | null = unitForFactor(f);
  if (unit) return { calibration: undefined, alignment, unitsOverride: unit };
  return { calibration: cadUnitsCalibration(f, at), alignment, unitsOverride: undefined };
}

// --------------------------------------------------------------------------------------- helpers

/** Uniform metres-per-unit of a transform (geometric mean of the axis scales). */
export function metresPerUnit(m: Affine2D): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}
