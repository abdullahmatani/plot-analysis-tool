import type { Units } from './types';

/** Metres per unit. */
export const METRES_PER: Record<Units, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
};

export const UNIT_LABEL: Record<Units, string> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  km: 'km',
  in: 'in',
  ft: 'ft',
};

export const ALL_UNITS: Units[] = ['mm', 'cm', 'm', 'km', 'in', 'ft'];

/** One PDF point in metres (1/72 inch). */
export const METRES_PER_PT = 0.0254 / 72;

export function toMetres(value: number, unit: Units): number {
  return value * METRES_PER[unit];
}

export function fromMetres(metres: number, unit: Units): number {
  return metres / METRES_PER[unit];
}

export const AREA_FACTORS = {
  m2: 1,
  ha: 1e4,
  km2: 1e6,
  ft2: 0.3048 * 0.3048,
  acre: 4046.8564224,
} as const;

export const AREA_LABEL: Record<keyof typeof AREA_FACTORS, string> = {
  m2: 'm²',
  ha: 'ha',
  km2: 'km²',
  ft2: 'ft²',
  acre: 'acre',
};

/**
 * DXF $INSUNITS codes → units. Codes not representable in the tool (miles, microinches, etc.)
 * map to the nearest supported unit with a conversion handled by `insunitsToMetres`.
 */
export function insunitsToMetres(code: number): number | null {
  switch (code) {
    case 1:
      return 0.0254; // inches
    case 2:
      return 0.3048; // feet
    case 3:
      return 1609.344; // miles
    case 4:
      return 0.001; // millimetres
    case 5:
      return 0.01; // centimetres
    case 6:
      return 1; // metres
    case 7:
      return 1000; // kilometres
    case 8:
      return 0.0254e-6; // microinches
    case 9:
      return 0.0254e-3; // mils
    case 10:
      return 0.9144; // yards
    case 11:
      return 1e-10; // angstroms
    case 12:
      return 1e-9; // nanometres
    case 13:
      return 1e-6; // microns
    case 14:
      return 0.1; // decimetres
    case 15:
      return 10; // decametres
    case 16:
      return 100; // hectometres
    case 17:
      return 1e9; // gigametres
    case 18:
      return 149597870700; // astronomical units
    case 19:
      return 9.4607e15; // light years
    case 20:
      return 3.0857e16; // parsecs
    case 21:
      return 1200 / 3937; // US survey feet
    default:
      return null; // 0 = unitless
  }
}

export function insunitsToUnits(code: number): Units | 'unitless' {
  switch (code) {
    case 1:
      return 'in';
    case 2:
    case 21:
      return 'ft';
    case 4:
      return 'mm';
    case 5:
      return 'cm';
    case 6:
      return 'm';
    case 7:
      return 'km';
    default:
      return 'unitless';
  }
}

/** Format a length in metres in the given display unit. */
export function formatLength(metres: number, unit: Units, precision: number): string {
  return `${formatNumber(fromMetres(metres, unit), precision)} ${UNIT_LABEL[unit]}`;
}

export function formatArea(m2: number, unit: keyof typeof AREA_FACTORS, precision: number): string {
  return `${formatNumber(m2 / AREA_FACTORS[unit], precision)} ${AREA_LABEL[unit]}`;
}

/** Number with thin-space thousands grouping (e.g. "612 345.120"). */
export function formatNumber(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '—';
  const fixed = Math.abs(v).toFixed(Math.max(0, Math.min(10, precision)));
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = v < 0 && Number(fixed) !== 0 ? '-' : '';
  return sign + (frac !== undefined ? `${grouped}.${frac}` : grouped);
}

/** Parses a user-typed length like "15", "15 m", "1500mm", "-3.5 ft" → metres. */
export function parseLength(input: string, defaultUnit: Units): number | null {
  const m = /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?)\s*(mm|cm|m|km|in|ft|"|')?\s*$/i.exec(input);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  let unit = (m[2]?.toLowerCase() ?? defaultUnit) as string;
  if (unit === '"') unit = 'in';
  if (unit === "'") unit = 'ft';
  return toMetres(value, unit as Units);
}

export function radToDeg(r: number): number {
  return (r * 180) / Math.PI;
}

export function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}
