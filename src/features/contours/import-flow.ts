import type { CellValue, Project } from '@/core/types';
import { detectFileType } from '@/import/detect';
import { importTable, type ImportInput, type ImportKind, type ImportResult } from '@/tables/table';
import { suggestMapping, type Mapping } from '@/tables/suggest';

/**
 * Table import flow (rows 62, 72): every route (CSV / TSV file, XLSX with sheet picker, clipboard
 * paste) goes through `importTable`, so the same data produces an identical table and — with the same
 * mapping — an identical dataset.
 */

/**
 * Calibration guard (row 32) — STUB, to be wired after merge to
 * `warnIfUncalibrated('Import contour dataset')` from `src/features/calibration/guard.ts`.
 * Resolves false when the user cancels the import.
 */
export async function calibrationGuard(): Promise<boolean> {
  return true;
}

/** A table source held by the import dialog (bytes for files, text/html for pasted ranges). */
export interface TableSource {
  kind: ImportKind;
  name: string;
  bytes?: Uint8Array;
  text?: string;
  html?: string;
}

/** Table kind of a file by signature (row 13), with the extension deciding CSV vs TSV. */
export function tableKindOf(name: string, head: Uint8Array): ImportKind | null {
  const det = detectFileType(head, name);
  if (det.kind === 'xlsx') return 'xlsx';
  if (det.kind !== 'csv') return null;
  return /\.(tsv|tab)$/i.test(name) ? 'tsv' : 'csv';
}

export async function readTableSource(file: File): Promise<TableSource> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = tableKindOf(file.name, bytes.subarray(0, 64 * 1024));
  if (!kind) {
    const det = detectFileType(bytes.subarray(0, 64 * 1024), file.name);
    throw new Error(`“${file.name}” is not a table (detected: ${det.label}). Use CSV, TSV or XLSX.`);
  }
  return { kind, name: file.name, bytes };
}

export interface ParseOptions {
  sheet?: string;
  headerRow?: number;
  delimiter?: string;
}

/** Parses a source into a table (throws a readable error on bad input). */
export function parseSource(src: TableSource, opts: ParseOptions = {}): ImportResult {
  const input: ImportInput = { kind: src.kind };
  if (src.bytes) input.bytes = src.bytes;
  if (src.text !== undefined) input.text = src.text;
  if (src.html !== undefined) input.html = src.html;
  if (opts.sheet !== undefined) input.sheet = opts.sheet;
  if (opts.headerRow !== undefined) input.headerRow = opts.headerRow;
  if (opts.delimiter !== undefined) input.delimiter = opts.delimiter;
  return importTable(input);
}

/** Complete starting mapping for a table: suggestions with defaults for missing roles. */
export function initialMapping(columns: string[], rows: CellValue[][]): Mapping {
  const s = suggestMapping(columns, rows);
  return {
    position: s.position ?? { mode: 'xy' },
    sizeColumns: s.sizeColumns ?? [],
    sizeMode: s.sizeMode ?? 'radius',
    sizeUnit: s.sizeUnit ?? 'm',
    ...(s.label ? { label: s.label } : {}),
    ...(s.group ? { group: s.group } : {}),
    ...(s.color ? { color: s.color } : {}),
    ...(s.shape ? { shape: s.shape } : {}),
    ...(s.width ? { width: s.width } : {}),
    ...(s.height ? { height: s.height } : {}),
    ...(s.rotation ? { rotation: s.rotation } : {}),
  };
}

/** Dataset name from a file name ("results.xlsx" → "results"), with the sheet when not the first. */
export function datasetNameFor(src: TableSource, sheet?: string, sheets?: string[]): string {
  const base = src.name.replace(/\.[a-z0-9]+$/i, '') || 'Pasted table';
  return sheet && sheets && sheets.length > 1 && sheet !== sheets[0] ? `${base} – ${sheet}` : base;
}

/** Plant positioning (row 64) needs a drawing calibrated by coordinates (row 31). */
export function hasPlantCalibration(p: Project): boolean {
  return p.drawings.some((d) => d.calibration?.method === 'coordinates');
}
