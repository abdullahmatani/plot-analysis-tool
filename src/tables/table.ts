import type { CellValue } from '@/core/types';

import { parseClipboard } from './clipboard';
import { parseDelimited } from './csv';
import { decodeText } from './decode';
import { openXlsx } from './xlsx';
import { decimalEvidence, isBlank, parseNumber, trimCell } from './values';

/**
 * Table import pipeline (row 62): raw rows from CSV / TSV / XLSX / clipboard → header-row
 * detection → a clean table with unique column names and typed cells. Every route goes through
 * `buildTable`, so the same data imported by any route produces an identical table.
 */

export interface Table {
  columns: string[];
  rows: CellValue[][];
}

export type ImportKind = 'csv' | 'tsv' | 'xlsx' | 'clipboard';

export interface ImportInput {
  kind: ImportKind;
  /** File contents (csv/tsv/xlsx). */
  bytes?: Uint8Array;
  /** Already-decoded text (csv/tsv) or the clipboard's text/plain flavour. */
  text?: string;
  /** Clipboard text/html flavour. */
  html?: string;
  /** XLSX sheet name; default: the first visible sheet. */
  sheet?: string;
  /** Header row index (0-based into the raw rows, -1 = no header); default: detected. */
  headerRow?: number;
  /** CSV delimiter override; default: detected. */
  delimiter?: string;
}

export interface ImportResult {
  table: Table;
  /** Raw rows as read, so the UI can re-run `buildTable` when the user picks another header row. */
  raw: CellValue[][];
  /** XLSX only: sheet names in workbook order (for the sheet picker), and the sheet read. */
  sheets?: string[];
  sheet?: string;
  headerRow: number;
  /** First 50 data rows of the table. */
  preview: CellValue[][];
}

export const PREVIEW_ROWS = 50;

function nonEmptyCount(row: CellValue[] | undefined): number {
  if (!row) return 0;
  let n = 0;
  for (const v of row) if (!isBlank(v)) n++;
  return n;
}

function isNumericCell(v: CellValue | undefined): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && parseNumber(v) !== null;
}

function textRatio(row: CellValue[]): number {
  let ne = 0;
  let text = 0;
  for (const v of row) {
    if (isBlank(v)) continue;
    ne++;
    if (!isNumericCell(v)) text++;
  }
  return ne === 0 ? 0 : text / ne;
}

/**
 * Index of the header row: the first row (within the first 30) that is reasonably full, mostly
 * non-numeric text and followed by a row that looks like data (has a number, or less text). Title
 * rows above the header (a single cell) are skipped. Falls back to the first non-empty row when it
 * is mostly text (all-text tables), else -1 (no header: all rows are data).
 */
export function detectHeaderRow(rows: CellValue[][]): number {
  const scan = Math.min(rows.length, 30);
  let width = 0;
  for (let i = 0; i < Math.min(rows.length, 50); i++) width = Math.max(width, nonEmptyCount(rows[i]));
  if (width === 0) return rows.length > 0 ? 0 : -1;
  const minFill = Math.max(1, Math.ceil(width * 0.5));
  let firstNonEmpty = -1;
  const headerLike = (i: number) => nonEmptyCount(rows[i]) >= minFill && textRatio(rows[i]) >= 0.75;
  for (let i = 0; i < scan; i++) {
    const row = rows[i];
    const ne = nonEmptyCount(row);
    if (ne === 0) continue;
    if (firstNonEmpty < 0) firstNonEmpty = i;
    if (!headerLike(i)) continue;
    let k = i + 1;
    while (k < rows.length && nonEmptyCount(rows[k]) === 0) k++;
    if (k >= rows.length) {
      // A lone text row is a header without data; a last text row after others is data.
      if (i === firstNonEmpty) return i;
      break;
    }
    const next = rows[k];
    if (next.some((v) => isNumericCell(v)) || textRatio(next) < textRatio(row)) {
      // Header blocks (header + units row): prefer the fullest text row directly above.
      let h = i;
      for (let j = i - 1; j >= 0; j--) {
        if (nonEmptyCount(rows[j]) === 0) continue;
        if (!headerLike(j) || nonEmptyCount(rows[j]) < nonEmptyCount(rows[h])) break;
        h = j;
      }
      return h;
    }
  }
  if (firstNonEmpty >= 0 && textRatio(rows[firstNonEmpty]) >= 0.75) return firstNonEmpty;
  return -1;
}

/** Header cell → column name: trimmed, whitespace (incl. line breaks) collapsed. */
function headerName(v: CellValue | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : v;
  return trimCell(s.replace(/[\s\u00a0]+/g, ' '));
}

/** Makes column names non-empty and unique (case-insensitive): "Column 3", "Radius (2)". */
export function uniqueColumnNames(names: string[]): string[] {
  const used = new Set<string>();
  const base = names.map((n, i) => (n === '' ? `Column ${i + 1}` : n));
  // Reserve every original non-empty name first so generated names never collide with later ones.
  const out: string[] = [];
  const taken = new Set(base.map((n) => n.toLowerCase()));
  for (const name of base) {
    let candidate = name;
    if (used.has(candidate.toLowerCase())) {
      for (let k = 2; ; k++) {
        candidate = `${name} (${k})`;
        if (!used.has(candidate.toLowerCase()) && !taken.has(candidate.toLowerCase())) break;
      }
    }
    used.add(candidate.toLowerCase());
    out.push(candidate);
  }
  return out;
}

/** Decides whether string numbers in this table use a decimal comma (only when unambiguous). */
function detectDecimalComma(rows: CellValue[][]): boolean {
  let comma = 0;
  let point = 0;
  for (const row of rows) {
    for (const v of row) {
      if (typeof v !== 'string') continue;
      const e = decimalEvidence(v);
      if (e === 'comma') comma++;
      else if (e === 'point') point++;
    }
  }
  return comma > 0 && point === 0;
}

/** Normalises one data cell: trims, '' → null, CRLF → LF, numeric strings → numbers. */
function normaliseCell(v: CellValue | undefined, decimalComma: boolean): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = trimCell(v.replace(/\r\n?/g, '\n'));
  if (s === '') return null;
  const n = parseNumber(s, decimalComma || undefined);
  return n === null ? s : n;
}

/**
 * Builds a clean table from raw rows: header from `headerRow` (-1 = none), unique non-empty column
 * names, trimmed cells, numeric strings converted (thousands separators; decimal commas when the
 * table shows unambiguous evidence for them), fully empty rows dropped, rows padded/trimmed to the
 * column count. Columns that are empty in the header and every row are dropped from the right.
 */
export function buildTable(raw: CellValue[][], headerRow: number): Table {
  const header = headerRow >= 0 ? (raw[headerRow] ?? []) : [];
  const data = raw.slice(Math.max(0, headerRow + 1));
  const decimalComma = detectDecimalComma(data);
  const rows: CellValue[][] = [];
  let width = 0;
  for (let i = 0; i < header.length; i++) if (headerName(header[i]) !== '') width = Math.max(width, i + 1);
  for (const r of data) {
    const row = r.map((v) => normaliseCell(v, decimalComma));
    let last = row.length - 1;
    while (last >= 0 && row[last] === null) last--;
    if (last < 0) continue;
    row.length = last + 1;
    width = Math.max(width, row.length);
    rows.push(row);
  }
  const names: string[] = [];
  for (let i = 0; i < width; i++) names.push(headerName(header[i]));
  for (const row of rows) while (row.length < width) row.push(null);
  return { columns: uniqueColumnNames(names), rows };
}

function readRaw(input: ImportInput): { raw: CellValue[][]; sheets?: string[]; sheet?: string } {
  switch (input.kind) {
    case 'csv':
    case 'tsv': {
      const text = input.text ?? (input.bytes ? decodeText(input.bytes) : '');
      const delimiter = input.delimiter ?? (input.kind === 'tsv' ? '\t' : undefined);
      return { raw: parseDelimited(text, { delimiter }) };
    }
    case 'clipboard':
      return { raw: parseClipboard(input.text ?? '', input.html) };
    case 'xlsx': {
      if (!input.bytes) throw new Error('No XLSX data.');
      const wb = openXlsx(input.bytes);
      const names = wb.sheets.map((s) => s.name);
      if (wb.sheets.length === 0) throw new Error('The workbook has no worksheets.');
      let index: number;
      if (input.sheet !== undefined) {
        index = names.indexOf(input.sheet);
        if (index < 0) index = names.findIndex((n) => n.toLowerCase() === input.sheet!.toLowerCase());
        if (index < 0) throw new Error(`Sheet "${input.sheet}" not found.`);
      } else {
        index = Math.max(
          0,
          wb.sheets.findIndex((s) => !s.hidden),
        );
      }
      return { raw: wb.readSheet(index), sheets: names, sheet: names[index] };
    }
    default:
      throw new Error(`Unknown import kind: ${String((input as { kind: unknown }).kind)}`);
  }
}

/** Imports a table from any supported route (row 62). Throws with a readable message on bad input. */
export function importTable(input: ImportInput): ImportResult {
  const { raw, sheets, sheet } = readRaw(input);
  const headerRow = input.headerRow ?? detectHeaderRow(raw);
  const table = buildTable(raw, headerRow);
  return {
    table,
    raw,
    ...(sheets ? { sheets, sheet } : {}),
    headerRow,
    preview: table.rows.slice(0, PREVIEW_ROWS),
  };
}
