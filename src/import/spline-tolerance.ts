import { insunitsToMetres } from '@/core/units';

/**
 * Largest chord deviation of a tessellated spline, in metres: half of NFR-7's 1 mm, so a distance
 * between two points snapped on splines stays within it. Splines are stored as polylines that
 * snapping, measuring, tracing and offsets use, so the tessellation is part of their accuracy.
 * Without it, the tolerance is relative to each spline's size (5 × 10⁻⁵ of its control polygon):
 * 2.5 cm on a 500 m spline. It costs points: a winding 1 km spline gets about 2 200 instead of 240.
 */
export const SPLINE_TOL_METRES = 5e-4;

/** SPLINE_TOL_METRES in drawing units, or undefined when the drawing's units are not known. */
export function splineTolerance(insunits: number | undefined): number | undefined {
  const m = insunits === undefined ? null : insunitsToMetres(insunits);
  return m ? SPLINE_TOL_METRES / m : undefined;
}

/** The tolerance for geometry that a block insert transforms with `xf`: its stretch enlarges errors. */
export function tolUnder(
  tol: number | undefined,
  xf: { m0: number; m1: number; m4: number; m5: number } | null,
): number | undefined {
  if (tol === undefined || !xf) return tol;
  const stretch = Math.max(Math.hypot(xf.m0, xf.m4), Math.hypot(xf.m1, xf.m5));
  return stretch > 0 ? tol / stretch : tol;
}

/** Whether a tessellation made at tolerance `had` serves one that needs `need` (undefined: relative only). */
export function fineEnough(had: number | undefined, need: number | undefined): boolean {
  if (need === undefined) return had === undefined;
  return had !== undefined && had <= need;
}
