import type { CellValue, Project } from '@/core/types';
import { warnIfUncalibrated } from '@/features/calibration/guard';
import { detectFileType } from '@/import/detect';
import type { ImportKind } from '@/tables/table';
import type { TableSource } from '@/tables/source';
import { suggestMapping, type Mapping } from '@/tables/suggest';

export { parseSource, type ParseOptions, type TableSource } from '@/tables/source';

/**
 * Table import flow (rows 62, 72): every route (CSV / TSV file, XLSX with sheet picker, clipboard
 * paste) goes through `importTable`, so the same data produces an identical table and — with the same
 * mapping — an identical dataset.
 */

/** Calibration guard (row 32): contour positions and sizes need a calibrated drawing. Resolves false to cancel. */
export function calibrationGuard(): Promise<boolean> {
  return warnIfUncalibrated('Import contour dataset');
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
