import type { CellValue } from '@/core/types';

/**
 * Cell value helpers shared by the table modules (import, filters, validation, contours).
 * Everything here is pure and worker-safe.
 */

const SPACE_RE = /[\s\u00a0\u2007\u2009\u202f\ufeff]+/g;
const EDGE_SPACE_RE = /^[\s\u00a0\u2007\u2009\u202f\ufeff]+|[\s\u00a0\u2007\u2009\u202f\ufeff]+$/g;

/** Trims ASCII and Unicode spaces (incl. NBSP, thin spaces and stray BOMs). */
export function trimCell(s: string): string {
  return s.replace(EDGE_SPACE_RE, '');
}

/** True for null/undefined, empty strings and whitespace-only strings. */
export function isBlank(v: CellValue | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'number') return false;
  return trimCell(v) === '';
}

/** Display text of a cell ('' for null). */
export function cellText(v: CellValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return v;
}

/** Normalised comparison key: NFC, trimmed, internal whitespace collapsed, lower case. */
export function normaliseKey(s: string): string {
  return trimCell(s).normalize('NFC').replace(SPACE_RE, ' ').toLowerCase();
}

const PLAIN_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const COMMA_THOUSANDS_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const DOT_THOUSANDS_RE = /^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/;
const SPACE_THOUSANDS_RE = /^[+-]?\d{1,3}(?:[ \u00a0\u2009\u202f']\d{3})+(?:[.,]\d+)?$/;
const DECIMAL_COMMA_RE = /^[+-]?\d*,\d+$/;
const LEADING_ZERO_RE = /^[+-]?0\d/;

/** "Not reached" style markers used in consequence tables for an endpoint that does not occur. */
const NOT_REACHED = new Set(['-', '–', '—', 'n/a', 'na', 'n.a.', 'nr', 'n/r', 'not reached', 'none', 'nil']);

export function isNotReachedMarker(s: string): boolean {
  return NOT_REACHED.has(trimCell(s).toLowerCase());
}

/**
 * Parses a number typed by a person or written by a spreadsheet. Accepts plain and scientific
 * notation, thousands separators (`1,234.5`, `1 234,5`, `1'234`) and decimal commas. With
 * `decimalComma` undefined the comma is a decimal separator only when that is unambiguous
 * (`12,5`, `0,125`, `1234,5`); `1,234` is read as one thousand two hundred thirty-four. With
 * `decimalComma` true, `1,234` → 1.234 and `1.234` → 1234. Strings with a leading zero followed by
 * a digit (`007`, `0101`) are identifiers, not numbers. Returns null when not a number.
 */
export function parseNumber(input: string, decimalComma?: boolean): number | null {
  let s = trimCell(input);
  if (s === '' || s.length > 64) return null;
  if (s.charCodeAt(0) === 0x2212) s = '-' + s.slice(1); // Unicode minus
  if (LEADING_ZERO_RE.test(s) && !/^[+-]?0[.,]/.test(s)) return null;
  let norm: string | null = null;
  if (PLAIN_RE.test(s)) {
    norm = decimalComma && DOT_THOUSANDS_RE.test(s) ? s.replace(/\./g, '') : s;
  } else if (SPACE_THOUSANDS_RE.test(s)) {
    norm = s.replace(/[ \u00a0\u2009\u202f']/g, '').replace(',', '.');
  } else if (DECIMAL_COMMA_RE.test(s)) {
    const frac = s.length - s.indexOf(',') - 1;
    const intDigits = s.indexOf(',') - (/^[+-]/.test(s) ? 1 : 0);
    // A single comma followed by exactly three digits after 1–3 non-zero-led digits could be a
    // thousands separator; anything else can only be a decimal comma.
    const unambiguous = frac !== 3 || intDigits === 0 || intDigits > 3 || /^[+-]?0,/.test(s);
    norm = decimalComma === true || unambiguous ? s.replace(',', '.') : s.replace(',', '');
  } else if (COMMA_THOUSANDS_RE.test(s) && !decimalComma) {
    norm = s.replace(/,/g, '');
  } else if (DOT_THOUSANDS_RE.test(s) && decimalComma !== false) {
    norm = s.replace(/\./g, '').replace(',', '.');
  } else if (COMMA_THOUSANDS_RE.test(s) && decimalComma) {
    // "1,234,567" can only be thousands even in a decimal-comma table.
    if ((s.match(/,/g) ?? []).length > 1) norm = s.replace(/,/g, '');
  }
  if (norm === null) return null;
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

/** Number from a cell (numbers pass through; numeric strings are parsed). */
export function toNumber(v: CellValue | undefined, decimalComma?: boolean): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  return parseNumber(v, decimalComma);
}

/**
 * Locale evidence for a set of strings: counts values whose separator use is only consistent
 * with a decimal comma (`12,5`) or a decimal point (`12.5`).
 */
export function decimalEvidence(s: string): 'comma' | 'point' | null {
  const t = trimCell(s);
  if (/^[+-]?(?:\d+,\d{1,2}|\d+,\d{4,}|0,\d+|\d{4,},\d+|\d{1,3}(?:\.\d{3})+,\d+)$/.test(t)) return 'comma';
  if (/^[+-]?(?:\d+\.\d{1,2}|\d+\.\d{4,}|0\.\d+|\d{4,}\.\d+|\d{1,3}(?:,\d{3})+\.\d+)$/.test(t))
    return 'point';
  return null;
}

/** Strips lone UTF-16 surrogates (invalid in XML and UTF-8). */
export function wellFormed(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
}
