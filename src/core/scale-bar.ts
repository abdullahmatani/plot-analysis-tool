/**
 * Scale bar sizing shared by the canvas overlay and exports (row 36): picks a "nice" total length
 * (1, 2, 2.5 or 5 × 10ⁿ metres) not longer than `maxMetres`, and a division count.
 */
export interface ScaleBarSpec {
  /** Total length in metres. */
  length: number;
  divisions: number;
}

const STEPS = [1, 2, 2.5, 5];

export function niceScaleBar(maxMetres: number): ScaleBarSpec {
  if (!(maxMetres > 0) || !Number.isFinite(maxMetres)) return { length: 1, divisions: 4 };
  const exp = Math.floor(Math.log10(maxMetres));
  let best = Math.pow(10, exp);
  for (const s of STEPS) {
    const v = s * Math.pow(10, exp);
    if (v <= maxMetres * (1 + 1e-12)) best = v;
  }
  const lead = best / Math.pow(10, exp);
  const divisions = lead === 2.5 ? 5 : lead === 2 ? 4 : lead === 5 ? 5 : 4;
  return { length: best, divisions };
}

/** Human-readable length for a scale bar tick ("250 m", "1.5 km", "20 mm"). */
export function scaleBarLabel(metres: number): string {
  const trim = (v: number) => String(Number(v.toPrecision(6)));
  if (metres >= 1000) return `${trim(metres / 1000)} km`;
  if (metres >= 1) return `${trim(metres)} m`;
  if (metres >= 0.01) return `${trim(metres * 100)} cm`;
  return `${trim(metres * 1000)} mm`;
}
