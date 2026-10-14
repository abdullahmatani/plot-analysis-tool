import type { NorthSettings, Units } from '@/core/types';
import { niceScaleBar, scaleBarLabel } from '@/core/scale-bar';

/**
 * On-canvas scale bar and north arrow geometry (row 36). Lengths come from the shared
 * `niceScaleBar` helper (also used by exports), so the canvas and printed sheets agree.
 */

export interface ScaleBarLayout {
  /** Total length in world metres. */
  metres: number;
  /** Total length on screen, CSS px. */
  px: number;
  divisions: number;
  label: string;
  /** Tick positions (px from the left end) with labels at the ends and the middle. */
  ticks: { px: number; label: string }[];
}

const FT = 0.3048;

function ftLabel(ft: number): string {
  const trim = (v: number) => String(Number(v.toPrecision(6)));
  return ft >= 5280 ? `${trim(ft / 5280)} mi` : `${trim(ft)} ft`;
}

/** Scale bar no longer than `maxPx` at `pxPerMetre`; feet for imperial display units. */
export function scaleBarLayout(pxPerMetre: number, maxPx: number, units: Units): ScaleBarLayout | null {
  if (!(pxPerMetre > 0) || !(maxPx > 0) || !Number.isFinite(pxPerMetre)) return null;
  const imperial = units === 'ft' || units === 'in';
  const factor = imperial ? FT : 1;
  const spec = niceScaleBar(maxPx / pxPerMetre / factor);
  const metres = spec.length * factor;
  const px = metres * pxPerMetre;
  const label = (n: number) => (imperial ? ftLabel(n) : scaleBarLabel(n));
  const ticks = [
    { px: 0, label: '0' },
    { px: px / 2, label: label(spec.length / 2) },
    { px, label: label(spec.length) },
  ];
  return { metres, px, divisions: spec.divisions, label: label(spec.length), ticks };
}

/** Screen angle of the north arrow, radians anticlockwise from screen-up. */
export function northArrowAngle(viewRotation: number, north: NorthSettings): number {
  return viewRotation + (north.arrow === 'true' ? north.trueNorthAngle : 0);
}
