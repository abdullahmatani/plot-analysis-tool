import type { Drawing, Project, ProjectDisplay, Units } from '@/core/types';
import {
  AREA_FACTORS,
  formatArea,
  formatLength,
  formatNumber,
  fromMetres,
  METRES_PER,
  radToDeg,
  UNIT_LABEL,
} from '@/core/units';

/**
 * Display formatting that follows the project's display settings (row 26): length, area and angle
 * units and decimal precision. Values are never rounded in storage, only here for display.
 */

export type AreaUnit = keyof typeof AREA_FACTORS;

export const LENGTH_UNIT_OPTIONS: { value: Units; label: string }[] = [
  { value: 'mm', label: 'Millimetres (mm)' },
  { value: 'cm', label: 'Centimetres (cm)' },
  { value: 'm', label: 'Metres (m)' },
  { value: 'km', label: 'Kilometres (km)' },
  { value: 'in', label: 'Inches (in)' },
  { value: 'ft', label: 'Feet (ft)' },
];

export const AREA_UNIT_OPTIONS: { value: AreaUnit; label: string }[] = [
  { value: 'm2', label: 'Square metres (m²)' },
  { value: 'ha', label: 'Hectares (ha)' },
  { value: 'km2', label: 'Square kilometres (km²)' },
  { value: 'ft2', label: 'Square feet (ft²)' },
  { value: 'acre', label: 'Acres' },
];

export const ANGLE_UNIT_OPTIONS: { value: ProjectDisplay['angleUnits']; label: string }[] = [
  { value: 'deg', label: 'Degrees (°)' },
  { value: 'rad', label: 'Radians (rad)' },
];

export const DEFAULT_DISPLAY: ProjectDisplay = {
  units: 'm',
  precision: 2,
  areaUnits: 'm2',
  angleUnits: 'deg',
  plantCoords: true,
};

export function displayOf(project: Project | null | undefined): ProjectDisplay {
  return project?.display ?? DEFAULT_DISPLAY;
}

export function fmtLength(metres: number, d: ProjectDisplay): string {
  return formatLength(metres, d.units, d.precision);
}

export function fmtArea(m2: number, d: ProjectDisplay): string {
  return formatArea(m2, d.areaUnits, d.precision);
}

/** Angle in the display angle unit (degrees with the display precision, radians with two more digits). */
export function fmtAngle(rad: number, d: Pick<ProjectDisplay, 'angleUnits' | 'precision'>): string {
  return d.angleUnits === 'rad'
    ? `${formatNumber(rad, d.precision + 2)} rad`
    : `${formatNumber(radToDeg(rad), d.precision)}°`;
}

/** Coordinate value (one more decimal than lengths, as in the status bar). */
export function fmtCoord(metres: number, d: ProjectDisplay): string {
  return formatNumber(fromMetres(metres, d.units), d.precision + 1);
}

export function unitLabel(d: ProjectDisplay): string {
  return UNIT_LABEL[d.units];
}

/** True when a drawing is calibrated with plant coordinates, so world X/Y are plant E/N (row 31). */
export function hasPlantCoordinates(project: Pick<Project, 'drawings'>): boolean {
  return project.drawings.some((d) => d.calibration?.method === 'coordinates');
}

/** Axis names for coordinate readouts: E/N when plant coordinates are shown, X/Y otherwise. */
export function coordinateAxes(project: Pick<Project, 'drawings' | 'display'>): ['E', 'N'] | ['X', 'Y'] {
  return project.display.plantCoords && hasPlantCoordinates(project) ? ['E', 'N'] : ['X', 'Y'];
}

/** The supported unit whose size equals `metresPerUnit` (within 1e-12 relative), or null. */
export function unitForFactor(metresPerUnit: number): Units | null {
  for (const u of Object.keys(METRES_PER) as Units[]) {
    if (Math.abs(METRES_PER[u] - metresPerUnit) <= 1e-12 * metresPerUnit) return u;
  }
  return null;
}

/** Human description of a drawing's native units ("Metres ($INSUNITS 6)", "PDF points", "Unitless"). */
export function nativeUnitsLabel(d: Drawing, insunits?: number): string {
  if (d.source.kind === 'pdf') return 'PDF points (1/72 in on paper)';
  const code = insunits !== undefined && insunits >= 0 ? ` ($INSUNITS ${insunits})` : '';
  const n = d.nativeUnits;
  if (!n || n === 'unitless' || n === 'pt') return `Unitless${code}`;
  const opt = LENGTH_UNIT_OPTIONS.find((o) => o.value === n);
  return `${opt?.label ?? n}${code}`;
}
