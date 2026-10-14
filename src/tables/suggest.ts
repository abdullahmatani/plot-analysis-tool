import type { CellValue, ContourDataset, Units } from '@/core/types';

import { isBlank, isNotReachedMarker, toNumber } from './values';

/**
 * Column-mapping suggestions (rows 63, 73) from header keywords and value types. The result is a
 * starting point for the mapping dialog; nothing here is binding.
 */

export type Mapping = ContourDataset['mapping'];

const UNIT_WORDS: Record<string, Units> = {
  mm: 'mm',
  millimetre: 'mm',
  millimetres: 'mm',
  millimeter: 'mm',
  millimeters: 'mm',
  cm: 'cm',
  m: 'm',
  metre: 'm',
  metres: 'm',
  meter: 'm',
  meters: 'm',
  km: 'km',
  in: 'in',
  inch: 'in',
  inches: 'in',
  ft: 'ft',
  feet: 'ft',
  foot: 'ft',
};

/**
 * Length unit stated in a header suffix: "Radius (m)", "Radius [ft]", "radius_mm", "Radius, m",
 * "Radius m", "Radius in metres". Returns undefined when the header names no unit.
 */
export function parseUnitSuffix(header: string): Units | undefined {
  const h = header.trim().toLowerCase();
  const patterns = [
    /[([]\s*([a-z]+)\s*[)\]]\s*$/, // (m) / [ft] at the end
    /[_\s,/]([a-z]+)\s*$/, // _mm / " m" / ", m" / "/ft"
    /\bin\s+([a-z]+)\s*$/, // "in metres"
  ];
  for (const re of patterns) {
    const m = re.exec(h);
    if (m && UNIT_WORDS[m[1]]) {
      // "Distance in" alone is not a unit; "Radius (in)" is.
      if (m[1] === 'in' && re === patterns[1] && !/[_]in$/.test(h)) continue;
      return UNIT_WORDS[m[1]];
    }
  }
  return undefined;
}

/** Header with unit suffixes and punctuation removed, lower case: "Radius (m)" → "radius". */
export function headerStem(header: string): string {
  return header
    .toLowerCase()
    .replace(/[([][^)\]]*[)\]]\s*$/, '')
    .replace(/[_\s,/](mm|cm|m|km|ft|in)\s*$/, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ColumnProfile {
  name: string;
  stem: string;
  lower: string;
  nonEmpty: number;
  numeric: number;
  /** numeric / non-empty (not-reached markers count as numeric-compatible). */
  numericRatio: number;
  distinct: number;
}

function profile(columns: string[], rows: CellValue[][]): ColumnProfile[] {
  const sample = rows.length > 2000 ? rows.slice(0, 2000) : rows;
  return columns.map((name, c) => {
    let nonEmpty = 0;
    let numeric = 0;
    let markers = 0;
    const seen = new Set<string>();
    for (const row of sample) {
      const v = row[c];
      if (isBlank(v)) continue;
      nonEmpty++;
      if (toNumber(v) !== null) numeric++;
      else if (typeof v === 'string' && isNotReachedMarker(v)) markers++;
      if (seen.size < 1000) seen.add(String(v).toLowerCase());
    }
    const nonMarker = nonEmpty - markers;
    return {
      name,
      stem: headerStem(name),
      lower: name.toLowerCase(),
      nonEmpty,
      numeric,
      numericRatio: nonMarker > 0 ? numeric / nonMarker : 0,
      distinct: seen.size,
    };
  });
}

const isNumericCol = (p: ColumnProfile) => p.nonEmpty > 0 && p.numericRatio >= 0.8;
const isTextCol = (p: ColumnProfile) => p.nonEmpty > 0 && p.numericRatio < 0.5;

const X_RE = /^(x|x coord(inate)?|pos(ition)? x|x pos(ition)?|x centre|x center|centre x|center x|x m)$/;
const Y_RE = /^(y|y coord(inate)?|pos(ition)? y|y pos(ition)?|y centre|y center|centre y|center y|y m)$/;
const E_RE = /^(e|easting|east|eastings|plant e|plant east(ing)?|e coord(inate)?)$/;
const N_RE = /^(n|northing|north|northings|plant n|plant north(ing)?|n coord(inate)?)$/;
const ANCHOR_RE = /\b(anchor|tag|tag no|tag number|equipment|equip|item|item no|asset|source|location)\b/;
const SIZE_RE =
  /\b(radius|radii|distance|dist|diameter|dia|range|extent|zone|hazard distance|kw\/m|kw\/m2|kw\/m²|lfl|ufl|lel|uel|idlh|erpg\s*\d?|aegl\s*\d?|stel|overpressure|over pressure|psi|mbar|kpa|radiation|thermal|heat flux|flux|dose|toxic|lc50|lc01|probit|blast|fireball|jet fire|pool fire|flash fire|vce|bleve|effect|endpoint|contour|ring|buffer)\b|ø|⌀|^[rd]$/;
const SIZE_EXCLUDE_RE =
  /\b(frequency|freq|probability|prob|mass|rate|duration|time|temperature|temp|inventory|volume|elevation|height|width|length|rotation|angle|id|no|number|count|qty|quantity|year)\b/;
const DIAMETER_RE = /\b(diameter|dia)\b|ø|⌀/;
const LABEL_PRIORITY: RegExp[] = [
  /^label$/,
  /^name$/,
  /^scenario( name)?$/,
  /^description$|^desc$/,
  /^title$/,
  /\blabel\b/,
  /\bname\b/,
  /\bscenario\b/,
];
const GROUP_PRIORITY: RegExp[] = [
  /^category$/,
  /^group$/,
  /^class$/,
  /^type$/,
  /\bcategory\b/,
  /\bgroup\b/,
  /\b(hazard|event|scenario) type\b/,
  /^scenario$/,
  /\btype\b/,
];
const COLOR_RE = /^(colou?r|rgb|hex|colou?r code|fill|stroke)$/;
const SHAPE_RE = /^(shape|geometry|form|contour shape)$/;
const WIDTH_RE = /^(width|w|size x|x size|length|l)$/;
const HEIGHT_RE = /^(height|h|depth|size y|y size|breadth|b)$/;
const ROT_RE = /^(rotation|rot|angle|bearing|orientation|heading|azimuth|direction)$/;

/**
 * Suggests a column mapping from headers and values: position (X/Y → 'xy'; E/N/Easting/Northing →
 * 'plant'; otherwise an anchor/tag column → 'anchor'; an anchor column is also returned alongside
 * X/Y so the mode can be switched without remapping), numeric size columns named like radii,
 * distances or hazard endpoints (4 kW/m², LFL, IDLH, overpressure…), size mode (diameter when a
 * size header says diameter/dia/Ø), size and coordinate units from header suffixes, label, group,
 * colour, shape, width, height and rotation.
 */
export function suggestMapping(columns: string[], rows: CellValue[][]): Partial<Mapping> {
  const prof = profile(columns, rows);
  const used = new Set<string>();
  const find = (re: RegExp, pred: (p: ColumnProfile) => boolean) =>
    prof.find((p) => !used.has(p.name) && pred(p) && (re.test(p.stem) || re.test(p.lower)));
  const take = (p: ColumnProfile | undefined) => {
    if (p) used.add(p.name);
    return p?.name;
  };
  const out: Partial<Mapping> = {};

  // Position.
  const x = find(X_RE, isNumericCol);
  const y = x ? find(Y_RE, isNumericCol) : undefined;
  const e = !x || !y ? find(E_RE, isNumericCol) : undefined;
  const n = e ? find(N_RE, isNumericCol) : undefined;
  const anchor = prof.find((p) => ANCHOR_RE.test(p.stem) && p.nonEmpty > 0 && p.numericRatio < 1);
  let position: Mapping['position'] | undefined;
  if (x && y) {
    position = { mode: 'xy', x: take(x), y: take(y) };
    const unit = parseUnitSuffix(x.name) ?? parseUnitSuffix(y.name);
    if (unit) position.coordUnit = unit;
  } else if (e && n) {
    position = { mode: 'plant', x: take(e), y: take(n) };
    const unit = parseUnitSuffix(e.name) ?? parseUnitSuffix(n.name);
    if (unit) position.coordUnit = unit;
  }
  if (anchor) {
    if (position) position.anchor = anchor.name;
    else position = { mode: 'anchor', anchor: take(anchor) };
  }
  if (position) out.position = position;

  // Geometry columns (claimed before sizes so "Width" is never a size column).
  const width = take(find(WIDTH_RE, isNumericCol));
  const height = take(find(HEIGHT_RE, isNumericCol));
  const rotation = take(find(ROT_RE, isNumericCol));
  if (width) out.width = width;
  if (height) out.height = height;
  if (rotation) out.rotation = rotation;

  // Size columns.
  const sizes = prof.filter(
    (p) =>
      !used.has(p.name) &&
      isNumericCol(p) &&
      (SIZE_RE.test(p.lower) || SIZE_RE.test(p.stem)) &&
      !SIZE_EXCLUDE_RE.test(p.stem),
  );
  if (sizes.length > 0) {
    out.sizeColumns = sizes.map((p) => p.name);
    for (const p of sizes) used.add(p.name);
    out.sizeMode =
      sizes.some((p) => DIAMETER_RE.test(p.lower)) && !sizes.some((p) => /\bradi(us|i)\b/.test(p.lower))
        ? 'diameter'
        : 'radius';
    const unit = sizes.map((p) => parseUnitSuffix(p.name)).find((u) => u !== undefined);
    out.sizeUnit = unit ?? 'm';
  }

  // Label and group (may share a column, e.g. "Scenario").
  const textOrAny = (p: ColumnProfile) => p.nonEmpty > 0 && !used.has(p.name);
  const pick = (patterns: RegExp[], exclude?: string) => {
    for (const re of patterns) {
      const p = prof.find(
        (q) => textOrAny(q) && q.name !== exclude && isTextCol(q) && (re.test(q.stem) || re.test(q.lower)),
      );
      if (p) return p.name;
    }
    return undefined;
  };
  const label = pick(LABEL_PRIORITY) ?? (anchor && position?.mode !== 'anchor' ? anchor.name : undefined);
  const group = pick(GROUP_PRIORITY, label);
  if (label) out.label = label;
  if (group) out.group = group;

  const color = prof.find((p) => !used.has(p.name) && COLOR_RE.test(p.stem));
  if (color) out.color = take(color);
  const shape = prof.find((p) => !used.has(p.name) && SHAPE_RE.test(p.stem) && isTextCol(p));
  if (shape) out.shape = take(shape);
  return out;
}

/**
 * Mapping problems that must block saving the mapping dialog (row 63): required roles unmapped
 * or mapped to columns that do not exist.
 */
export function mappingErrors(mapping: Partial<Mapping>, columns: string[]): string[] {
  const errors: string[] = [];
  const has = (c: string | undefined) => c !== undefined && columns.includes(c);
  const pos = mapping.position;
  if (!pos) errors.push('Choose how rows are positioned.');
  else if (pos.mode === 'anchor') {
    if (!has(pos.anchor)) errors.push('Map the anchor name column.');
  } else {
    const what = pos.mode === 'plant' ? ['Easting', 'Northing'] : ['X', 'Y'];
    if (!has(pos.x)) errors.push(`Map the ${what[0]} column.`);
    if (!has(pos.y)) errors.push(`Map the ${what[1]} column.`);
  }
  if (!mapping.sizeColumns || mapping.sizeColumns.length === 0) errors.push('Map at least one size column.');
  else
    for (const c of mapping.sizeColumns) if (!has(c)) errors.push(`Size column "${c}" is not in the table.`);
  for (const key of ['label', 'group', 'color', 'shape', 'width', 'height', 'rotation'] as const) {
    const c = mapping[key];
    if (c !== undefined && c !== '' && !has(c)) errors.push(`Column "${c}" (${key}) is not in the table.`);
  }
  return errors;
}
