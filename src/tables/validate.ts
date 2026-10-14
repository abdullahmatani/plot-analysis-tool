import type { Bounds, ContourDataset, Pt } from '@/core/types';
import { METRES_PER } from '@/core/units';

import { parseShape, readPosition, readSize, resolveColumns } from './access';
import { parseColor } from './style-rules';
import { mappingErrors } from './suggest';
import { cellText, isBlank, toNumber } from './values';

/**
 * Row validation for contour datasets (row 69). Errors make a row invalid (it is skipped when
 * drawing): missing or non-numeric positions, unknown anchors, points outside the drawing extent,
 * non-numeric or negative sizes, rectangles without a usable width/height. Warnings are listed but
 * do not invalidate the row: zero sizes (that ring is not drawn), unrecognised shapes (drawn as a
 * circle) and unrecognised colours. Empty size cells and "not reached" markers (N/R, n/a, -, …) are
 * not issues; a row with no drawable size at all is invalid with a warning.
 */

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  /** 1-based data row number; 0 for dataset-level problems (e.g. incomplete mapping). */
  row: number;
  column?: string;
  message: string;
  severity: IssueSeverity;
}

export interface ValidationResult {
  /** Per data row: 1 = valid (drawn), 0 = invalid (skipped). */
  validRows: Uint8Array;
  issues: ValidationIssue[];
  counts: { total: number; valid: number; invalid: number; errors: number; warnings: number };
}

export interface ValidationContext {
  /** Anchors keyed by normalised name (see `normaliseAnchorName`). */
  anchors: Map<string, Pt>;
  /** Drawing extent in world metres; points outside are errors. */
  extent?: Bounds;
  plantToWorld?: (p: Pt) => Pt;
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

export function validateDataset(ds: ContourDataset, ctx: ValidationContext): ValidationResult {
  const { rows, columns } = ds.table;
  const m = ds.mapping;
  const validRows = new Uint8Array(rows.length);
  const issues: ValidationIssue[] = [];
  const add = (row: number, message: string, severity: IssueSeverity, column?: string) =>
    issues.push(column === undefined ? { row, message, severity } : { row, column, message, severity });

  const mapErrors = mappingErrors(m, columns);
  if (mapErrors.length > 0) {
    for (const e of mapErrors) add(0, e, 'error');
    return summarise(validRows, issues);
  }

  const cols = resolveColumns(ds);
  const unit = METRES_PER[m.sizeUnit] ?? 1;
  const pos = m.position;
  const xName = pos.mode === 'plant' ? 'Easting' : 'X';
  const yName = pos.mode === 'plant' ? 'Northing' : 'Y';
  const ext = ctx.extent;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const n = i + 1;
    let errors = 0;
    const err = (message: string, column?: string) => {
      errors++;
      add(n, message, 'error', column);
    };

    const p = readPosition(row, ds, cols, ctx.anchors, ctx.plantToWorld);
    if (!p.ok) {
      switch (p.reason) {
        case 'missing-x':
          err(`Missing ${xName} coordinate`, pos.x);
          break;
        case 'missing-y':
          err(`Missing ${yName} coordinate`, pos.y);
          break;
        case 'bad-x':
          err(`${xName} coordinate "${p.text}" is not a number`, pos.x);
          break;
        case 'bad-y':
          err(`${yName} coordinate "${p.text}" is not a number`, pos.y);
          break;
        case 'missing-anchor':
          err('Missing anchor name', pos.anchor);
          break;
        case 'unknown-anchor':
          err(`Unknown anchor "${p.text}"`, pos.anchor);
          break;
        default:
          err('Position columns are not mapped');
      }
    } else if (ext && (p.p.x < ext.minX || p.p.x > ext.maxX || p.p.y < ext.minY || p.p.y > ext.maxY)) {
      err(
        `Position (${fmt(p.p.x)}, ${fmt(p.p.y)}) is outside the drawing extent`,
        pos.mode === 'anchor' ? pos.anchor : pos.x,
      );
    }

    let drawable = 0;
    let sizeIssues = 0;
    m.sizeColumns.forEach((name, k) => {
      const s = readSize(row[cols.sizes[k]], unit);
      if (s.ok) {
        drawable++;
        return;
      }
      const raw = cellText(row[cols.sizes[k]]);
      if (s.reason === 'non-numeric') err(`Size "${raw}" is not a number`, name);
      else if (s.reason === 'negative') err(`Size is negative (${raw})`, name);
      else if (s.reason === 'zero') add(n, 'Size is zero; no contour drawn', 'warning', name);
      else return;
      sizeIssues++;
    });
    if (drawable === 0 && sizeIssues === 0) add(n, 'No size value in any size column', 'warning');

    const shape = cols.shape >= 0 ? parseShape(row[cols.shape]) : undefined;
    if (shape === null)
      add(n, `Unknown shape "${cellText(row[cols.shape])}"; drawn as a circle`, 'warning', m.shape);
    if (shape === 'rect') {
      for (const [idx, name, what] of [
        [cols.width, m.width, 'width'],
        [cols.height, m.height, 'height'],
      ] as const) {
        if (idx < 0) {
          err(`Rectangle needs a ${what} column`);
          continue;
        }
        const v = toNumber(row[idx]);
        if (v === null || v <= 0)
          err(`Rectangle ${what} "${cellText(row[idx])}" is not a positive number`, name);
      }
    }
    if (cols.rotation >= 0 && !isBlank(row[cols.rotation]) && toNumber(row[cols.rotation]) === null) {
      add(n, `Rotation "${cellText(row[cols.rotation])}" is not a number; 0° used`, 'warning', m.rotation);
    }
    if (cols.color >= 0 && !isBlank(row[cols.color]) && parseColor(row[cols.color]) === null) {
      add(n, `Colour "${cellText(row[cols.color])}" is not recognised`, 'warning', m.color);
    }

    validRows[i] = errors === 0 && drawable > 0 ? 1 : 0;
  }
  return summarise(validRows, issues);
}

function summarise(validRows: Uint8Array, issues: ValidationIssue[]): ValidationResult {
  let valid = 0;
  for (const v of validRows) valid += v;
  let errors = 0;
  for (const i of issues) if (i.severity === 'error') errors++;
  return {
    validRows,
    issues,
    counts: {
      total: validRows.length,
      valid,
      invalid: validRows.length - valid,
      errors,
      warnings: issues.length - errors,
    },
  };
}
