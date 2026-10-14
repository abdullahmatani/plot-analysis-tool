import { PALETTE } from '@/core/project';
import type { CellValue, DashStyle, StyleRule } from '@/core/types';

import { cellText, isBlank, normaliseKey, toNumber } from './values';

/**
 * Style rules for contour datasets (row 67): categorical colours (stable per value; new values get
 * the next free palette colour automatically), graduated colour ramps with class breaks (equal
 * interval, quantile, natural breaks), per-row colour lookup and legend entries.
 */

export type Category = NonNullable<StyleRule['categories']>[number];
export type Break = NonNullable<StyleRule['breaks']>[number];
export type BreakMethod = 'equal' | 'quantile' | 'jenks';

/** Key used to match category values: trimmed, case-insensitive. */
export function categoryKey(v: CellValue | undefined): string {
  return normaliseKey(cellText(v));
}

// --- colours ------------------------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

/** Extra distinct colours once the palette is exhausted (golden-angle hue steps). */
function generatedColor(i: number): string {
  return hslToHex((i * 137.508 + 20) % 360, 0.65, 0.45);
}

/** Accepts #rgb / #rrggbb (and #rrggbbaa) colours as written in a colour column; null otherwise. */
export function parseColor(v: CellValue | undefined): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s) || /^#?[0-9a-f]{3}$/i.test(s)) {
    const hex = s.startsWith('#') ? s : `#${s}`;
    return hex.length === 4
      ? hex.replace(/[0-9a-f]/gi, (c) => c + c).toLowerCase()
      : hex.slice(0, 7).toLowerCase();
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i.exec(s);
  if (rgb) return rgbToHex(+rgb[1], +rgb[2], +rgb[3]);
  const named = NAMED_COLORS[s.toLowerCase()];
  return named ?? null;
}

const NAMED_COLORS: Record<string, string> = {
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  black: '#000000',
  white: '#ffffff',
  grey: '#808080',
  gray: '#808080',
  brown: '#a52a2a',
  pink: '#ffc0cb',
};

/**
 * Category colours for the distinct values in `values`. Existing categories keep their colour
 * (and label/hidden flag); values not seen before are appended in order of first appearance with
 * the next palette colour not already in use (then generated colours). Blank values are skipped.
 */
export function assignCategoryColors(
  values: Iterable<CellValue | undefined>,
  existing: Category[] = [],
  palette: readonly string[] = PALETTE,
): Category[] {
  const out = existing.map((c) => ({ ...c }));
  const seen = new Set(out.map((c) => categoryKey(c.value)));
  const usedColors = new Set(out.map((c) => c.color.toLowerCase()));
  let p = 0;
  let generated = 0;
  const nextColor = () => {
    while (p < palette.length) {
      const c = palette[p++];
      if (!usedColors.has(c.toLowerCase())) return c;
    }
    for (;;) {
      const c = generatedColor(generated++);
      if (!usedColors.has(c)) return c;
    }
  };
  for (const v of values) {
    if (isBlank(v)) continue;
    const key = categoryKey(v);
    if (seen.has(key)) continue;
    seen.add(key);
    const color = nextColor();
    usedColors.add(color.toLowerCase());
    out.push({ value: cellText(v).trim(), color });
  }
  return out;
}

// --- ramps -------------------------------------------------------------------------------------------

export interface Ramp {
  label: string;
  kind: 'sequential' | 'diverging';
  stops: string[];
}

/** Colour ramps. Sequential ramps start at a mid-light tone so the first class shows on a white plan. */
export const RAMPS: Record<string, Ramp> = {
  viridis: {
    label: 'Viridis',
    kind: 'sequential',
    stops: [
      '#440154',
      '#482878',
      '#3e4989',
      '#31688e',
      '#26828e',
      '#1f9e89',
      '#35b779',
      '#6ece58',
      '#b5de2b',
      '#fde725',
    ],
  },
  reds: {
    label: 'Reds',
    kind: 'sequential',
    stops: ['#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d'],
  },
  blues: {
    label: 'Blues',
    kind: 'sequential',
    stops: ['#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'],
  },
  oranges: {
    label: 'Oranges',
    kind: 'sequential',
    stops: ['#fdd0a2', '#fdae6b', '#fd8d3c', '#f16913', '#d94801', '#a63603', '#7f2704'],
  },
  greens: {
    label: 'Greens',
    kind: 'sequential',
    stops: ['#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b'],
  },
  'yellow-red': {
    label: 'Yellow–red',
    kind: 'sequential',
    stops: ['#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'],
  },
  'red-blue': {
    label: 'Red–blue (diverging)',
    kind: 'diverging',
    stops: [
      '#67001f',
      '#b2182b',
      '#d6604d',
      '#f4a582',
      '#fddbc7',
      '#f7f7f7',
      '#d1e5f0',
      '#92c5de',
      '#4393c3',
      '#2166ac',
      '#053061',
    ],
  },
  'blue-red': {
    label: 'Blue–red (diverging)',
    kind: 'diverging',
    stops: [
      '#053061',
      '#2166ac',
      '#4393c3',
      '#92c5de',
      '#d1e5f0',
      '#f7f7f7',
      '#fddbc7',
      '#f4a582',
      '#d6604d',
      '#b2182b',
      '#67001f',
    ],
  },
};

export const DEFAULT_RAMP = 'viridis';

/** Colour at position t ∈ [0, 1] along a ramp (linear interpolation between stops). */
export function rampColor(ramp: string, t: number): string {
  const stops = (RAMPS[ramp] ?? RAMPS[DEFAULT_RAMP]).stops;
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return rgbToHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

/** n evenly spaced colours along a ramp. */
export function rampColors(ramp: string, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [rampColor(ramp, 1)];
  return Array.from({ length: n }, (_, i) => rampColor(ramp, i / (n - 1)));
}

// --- class breaks -------------------------------------------------------------------------------------

function finiteSorted(values: Iterable<CellValue | number | undefined>): number[] {
  const out: number[] = [];
  for (const v of values) {
    const n = typeof v === 'number' ? v : toNumber(v);
    if (n !== null && Number.isFinite(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function dedupe(breaks: number[]): number[] {
  return breaks.filter((b, i) => i === 0 || b > breaks[i - 1]);
}

/** Equal-interval upper bounds (ascending; the last equals the maximum). */
export function equalIntervalBreaks(values: Iterable<CellValue | number | undefined>, n: number): number[] {
  const s = finiteSorted(values);
  if (s.length === 0 || n < 1) return [];
  const min = s[0];
  const max = s[s.length - 1];
  if (min === max) return [max];
  const out: number[] = [];
  for (let k = 1; k < n; k++) out.push(min + ((max - min) * k) / n);
  out.push(max);
  return out;
}

/** Quantile upper bounds (each class holds about the same number of values). */
export function quantileBreaks(values: Iterable<CellValue | number | undefined>, n: number): number[] {
  const s = finiteSorted(values);
  if (s.length === 0 || n < 1) return [];
  const out: number[] = [];
  for (let k = 1; k <= n; k++) out.push(s[Math.max(0, Math.ceil((k * s.length) / n) - 1)]);
  return dedupe(out);
}

/**
 * Natural breaks (Jenks): optimal 1-D classification minimising within-class squared deviation,
 * computed exactly with the Ckmeans.1d.dp dynamic programme (Wang & Song 2011) using its
 * divide-and-conquer O(k·n·log n) fill, so 5 000 values take a few milliseconds.
 */
export function jenksBreaks(values: Iterable<CellValue | number | undefined>, n: number): number[] {
  const s = finiteSorted(values);
  if (s.length === 0 || n < 1) return [];
  let unique = 1;
  for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1]) unique++;
  const k = Math.min(n, unique);
  if (k === 1) return [s[s.length - 1]];
  const len = s.length;
  const cost: Float64Array[] = [];
  const back: Int32Array[] = [];
  for (let c = 0; c < k; c++) {
    cost.push(new Float64Array(len));
    back.push(new Int32Array(len));
  }
  const shift = s[Math.floor(len / 2)];
  const sums = new Float64Array(len);
  const sumSq = new Float64Array(len);
  const ssq = (j: number, i: number): number => {
    let v: number;
    if (j > 0) {
      const mu = (sums[i] - sums[j - 1]) / (i - j + 1);
      v = sumSq[i] - sumSq[j - 1] - (i - j + 1) * mu * mu;
    } else {
      v = sumSq[i] - (sums[i] * sums[i]) / (i + 1);
    }
    return v < 0 ? 0 : v;
  };
  for (let i = 0; i < len; i++) {
    const x = s[i] - shift;
    sums[i] = (i > 0 ? sums[i - 1] : 0) + x;
    sumSq[i] = (i > 0 ? sumSq[i - 1] : 0) + x * x;
    cost[0][i] = ssq(0, i);
    back[0][i] = 0;
  }
  const prevCost = (c: number, j: number) => (j < 0 ? Infinity : cost[c][j]);
  const fill = (iMin: number, iMax: number, c: number): void => {
    if (iMin > iMax) return;
    const i = (iMin + iMax) >> 1;
    cost[c][i] = prevCost(c - 1, i - 1);
    back[c][i] = i;
    let jlow = c;
    if (iMin > c) jlow = Math.max(jlow, back[c][iMin - 1]);
    jlow = Math.max(jlow, back[c - 1][i]);
    let jhigh = i - 1;
    if (iMax < len - 1) jhigh = Math.min(jhigh, back[c][iMax + 1]);
    for (let j = jhigh; j >= jlow; j--) {
      const sji = ssq(j, i);
      if (sji + prevCost(c - 1, jlow - 1) >= cost[c][i]) break;
      const sjlowi = ssq(jlow, i);
      const low = sjlowi + prevCost(c - 1, jlow - 1);
      if (low < cost[c][i]) {
        cost[c][i] = low;
        back[c][i] = jlow;
      }
      jlow++;
      const here = sji + prevCost(c - 1, j - 1);
      if (here < cost[c][i]) {
        cost[c][i] = here;
        back[c][i] = j;
      }
    }
    fill(iMin, i - 1, c);
    fill(i + 1, iMax, c);
  };
  for (let c = 1; c < k; c++) fill(c < k - 1 ? c : len - 1, len - 1, c);
  // Backtrack the cluster boundaries.
  const uppers: number[] = new Array<number>(k);
  let right = len - 1;
  for (let c = k - 1; c >= 0; c--) {
    const left = back[c][right];
    uppers[c] = s[right];
    right = left - 1;
  }
  return dedupe(uppers);
}

export function computeBreaks(
  values: Iterable<CellValue | number | undefined>,
  n: number,
  method: BreakMethod,
): number[] {
  switch (method) {
    case 'equal':
      return equalIntervalBreaks(values, n);
    case 'quantile':
      return quantileBreaks(values, n);
    default:
      return jenksBreaks(values, n);
  }
}

/**
 * Class index of `value` for ascending upper bounds (`value ≤ upTo`). Values above the last bound
 * fall in the last class (data edited after the breaks were made); non-numbers return -1.
 */
export function classify(
  value: number | null | undefined,
  breaks: readonly (number | { upTo: number })[],
): number {
  if (value === null || value === undefined || !Number.isFinite(value) || breaks.length === 0) return -1;
  let lo = 0;
  let hi = breaks.length - 1;
  const ub = (i: number) => {
    const b = breaks[i];
    return typeof b === 'number' ? b : b.upTo;
  };
  if (value > ub(hi)) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (value <= ub(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Compact number for legend labels (≤ 4 significant digits for fractions, integers kept). */
export function formatBreakValue(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (Math.abs(v) >= 1000 || Number.isInteger(v)) return String(Math.round(v * 100) / 100);
  return String(Number(v.toPrecision(4)));
}

/** Default label for class `i`: "≤ b0" for the first, "b(i-1) – b(i)" for the others. */
export function breakLabel(breaks: readonly { upTo: number }[], i: number, min?: number): string {
  const hi = formatBreakValue(breaks[i].upTo);
  if (i === 0)
    return min !== undefined && min < breaks[0].upTo ? `${formatBreakValue(min)} – ${hi}` : `≤ ${hi}`;
  return `${formatBreakValue(breaks[i - 1].upTo)} – ${hi}`;
}

/** Graduated classes for a rule: breaks by `method`, colours from `ramp`, default labels. */
export function makeGraduatedBreaks(
  values: Iterable<CellValue | number | undefined>,
  n: number,
  method: BreakMethod,
  ramp: string = DEFAULT_RAMP,
): Break[] {
  const all = [...values];
  const uppers = computeBreaks(all, n, method);
  const colors = rampColors(ramp, uppers.length);
  const min = finiteSorted(all)[0];
  const breaks: Break[] = uppers.map((upTo, i) => ({ upTo, color: colors[i] }));
  return breaks.map((b, i) => ({ ...b, label: breakLabel(breaks, i, min) }));
}

// --- rule evaluation ----------------------------------------------------------------------------------

export interface RuleStyle {
  color: string;
  dash?: DashStyle;
  fillOpacity?: number;
  /** The row's category is hidden by the rule: draw nothing. */
  hidden?: boolean;
  /** Legend entry key (matches `legendEntriesForRule`). */
  legendKey?: string;
}

export type CompiledRules = (row: CellValue[]) => RuleStyle | null;

function columnIndexOf(columns: string[], name: string): number {
  const exact = columns.indexOf(name);
  if (exact >= 0) return exact;
  const k = normaliseKey(name);
  return columns.findIndex((c) => normaliseKey(c) === k);
}

export function categoryLegendKey(ruleId: string, value: string): string {
  return `${ruleId}:cat:${categoryKey(value)}`;
}

export function breakLegendKey(ruleId: string, index: number): string {
  return `${ruleId}:brk:${index}`;
}

/** Compiles rules into a fast per-row lookup; the first rule that matches the row wins. */
export function compileStyleRules(rules: StyleRule[], columns: string[]): CompiledRules {
  const compiled: CompiledRules[] = [];
  for (const rule of rules) {
    const idx = columnIndexOf(columns, rule.column);
    if (idx < 0) continue;
    if (rule.kind === 'categorical') {
      const map = new Map<string, RuleStyle>();
      for (const c of rule.categories ?? []) {
        const key = categoryKey(c.value);
        if (map.has(key)) continue;
        const dash = c.dash ?? rule.dash;
        const fillOpacity = c.fillOpacity ?? rule.fillOpacity;
        map.set(key, {
          color: c.color,
          ...(dash ? { dash } : {}),
          ...(fillOpacity !== undefined ? { fillOpacity } : {}),
          ...(c.hidden ? { hidden: true } : {}),
          legendKey: categoryLegendKey(rule.id, c.value),
        });
      }
      // Memo on the raw cell value: a column has few distinct categories, so normalising each
      // row's value once per distinct string keeps large datasets fast.
      const memo = new Map<string | number, RuleStyle | null>();
      compiled.push((row) => {
        const v = row[idx];
        if (v === null || v === undefined) return null;
        let s = memo.get(v);
        if (s === undefined) {
          s = isBlank(v) ? null : (map.get(categoryKey(v)) ?? null);
          if (memo.size < 10000) memo.set(v, s);
        }
        return s;
      });
    } else {
      const breaks = [...(rule.breaks ?? [])].sort((a, b) => a.upTo - b.upTo);
      if (breaks.length === 0) continue;
      const styles: RuleStyle[] = breaks.map((b) => {
        const dash = b.dash ?? rule.dash;
        const fillOpacity = b.fillOpacity ?? rule.fillOpacity;
        return {
          color: b.color,
          ...(dash ? { dash } : {}),
          ...(fillOpacity !== undefined ? { fillOpacity } : {}),
          legendKey: breakLegendKey(rule.id, (rule.breaks ?? []).indexOf(b)),
        };
      });
      compiled.push((row) => {
        const i = classify(toNumber(row[idx]), breaks);
        return i < 0 ? null : styles[i];
      });
    }
  }
  if (compiled.length === 0) return () => null;
  if (compiled.length === 1) return compiled[0];
  return (row) => {
    for (const f of compiled) {
      const s = f(row);
      if (s) return s;
    }
    return null;
  };
}

const ruleCache = new WeakMap<StyleRule[], { columns: string[]; fn: CompiledRules }>();

/**
 * Colour (and optional dash / fill opacity) for one row: the first matching rule, else `fallback`.
 * Compiled rules are cached per rules array, so calling this per row is cheap.
 */
export function colorForRow(
  rules: StyleRule[],
  row: CellValue[],
  columns: string[],
  fallback: { color: string; dash?: DashStyle; fillOpacity?: number },
): { color: string; dash?: DashStyle; fillOpacity?: number; hidden?: boolean; legendKey?: string } {
  let entry = ruleCache.get(rules);
  if (!entry || entry.columns !== columns) {
    entry = { columns, fn: compileStyleRules(rules, columns) };
    ruleCache.set(rules, entry);
  }
  const s = entry.fn(row);
  if (!s) return { ...fallback };
  return {
    color: s.color,
    dash: s.dash ?? fallback.dash,
    fillOpacity: s.fillOpacity ?? fallback.fillOpacity,
    ...(s.hidden ? { hidden: true } : {}),
    ...(s.legendKey ? { legendKey: s.legendKey } : {}),
  };
}

export interface LegendEntry {
  key: string;
  label: string;
  color: string;
}

/** Legend entries generated from a rule (hidden categories omitted). */
export function legendEntriesForRule(rule: StyleRule): LegendEntry[] {
  if (rule.kind === 'categorical') {
    return (rule.categories ?? [])
      .filter((c) => !c.hidden)
      .map((c) => ({
        key: categoryLegendKey(rule.id, c.value),
        label: c.label ?? (c.value === '' ? '(blank)' : c.value),
        color: c.color,
      }));
  }
  const breaks = rule.breaks ?? [];
  const sorted = [...breaks].sort((a, b) => a.upTo - b.upTo);
  return sorted.map((b, i) => ({
    key: breakLegendKey(rule.id, breaks.indexOf(b)),
    label: b.label ?? breakLabel(sorted, i),
    color: b.color,
  }));
}
