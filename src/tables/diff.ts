import type { CellValue } from '@/core/types';

import { isBlank, normaliseKey, toNumber } from './values';

/**
 * Re-import change summary (row 72): which rows were added, removed or changed between the
 * dataset's current table and a newer file, matched by key columns (detected automatically when
 * not given) or, failing that, by row position.
 */

export interface TableLike {
  columns: string[];
  rows: CellValue[][];
}

export interface TableDiff {
  /** Indices into the new table. */
  added: number[];
  /** Indices into the old table. */
  removed: number[];
  changed: { oldIndex: number; newIndex: number; columns: string[] }[];
  unchanged: number;
  /** Key columns used for matching ([] = matched by row position). */
  keyUsed: string[];
  /** True when the set of column names differs (re-import then needs remapping review). */
  headersChanged: boolean;
  addedColumns: string[];
  removedColumns: string[];
}

const KEY_NAME_PRIORITY: RegExp[] = [
  /^(id|key|uid|guid|ref|reference)$/,
  /\b(id|key)\b/,
  /^(anchor|tag|tag no|equipment|item)$/,
  /\b(anchor|tag|equipment|item)\b/,
  /^(label|name|scenario( id| name)?)$/,
  /\b(label|name|scenario)\b/,
];

function cellKey(v: CellValue | undefined): string {
  if (isBlank(v)) return '';
  if (typeof v === 'number') return `n:${v}`;
  const n = toNumber(v);
  return n !== null ? `n:${n}` : `s:${normaliseKey(v as string)}`;
}

function rowKey(row: CellValue[], idx: number[]): string {
  let k = '';
  for (let i = 0; i < idx.length; i++) k += (i ? '\u0001' : '') + cellKey(row[idx[i]]);
  return k;
}

/** True when every row has a non-empty, unique key in the given columns. */
function isUniqueKey(t: TableLike, idx: number[]): boolean {
  const seen = new Set<string>();
  for (const row of t.rows) {
    if (idx.every((i) => isBlank(row[i]))) return false;
    const k = rowKey(row, idx);
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

function priority(name: string): number {
  const n = normaliseKey(name);
  const i = KEY_NAME_PRIORITY.findIndex((re) => re.test(n));
  return i < 0 ? KEY_NAME_PRIORITY.length : i;
}

/**
 * Detects key columns present in both tables: the best-named single column whose values are unique
 * and non-empty in both (ID, anchor/tag, label/name…), else a pair of such named columns (e.g.
 * Tag + Scenario), else [] (match by row position).
 */
export function detectKeyColumns(oldT: TableLike, newT: TableLike): string[] {
  const common = oldT.columns.filter((c) => newT.columns.includes(c));
  const named = common
    .filter((c) => priority(c) < KEY_NAME_PRIORITY.length)
    .sort((a, b) => priority(a) - priority(b));
  const idxOf = (t: TableLike, cs: string[]) => cs.map((c) => t.columns.indexOf(c));
  const ok = (cs: string[]) => isUniqueKey(oldT, idxOf(oldT, cs)) && isUniqueKey(newT, idxOf(newT, cs));
  if (oldT.rows.length === 0 || newT.rows.length === 0) return [];
  for (const c of named) if (ok([c])) return [c];
  for (let a = 0; a < named.length; a++) {
    for (let b = a + 1; b < named.length; b++) if (ok([named[a], named[b]])) return [named[a], named[b]];
  }
  // A unique text column without a key-like name (e.g. a free-form "Description") is a weak but usable key.
  for (const c of common) {
    const i = oldT.columns.indexOf(c);
    const textual = oldT.rows.every((r) => typeof r[i] === 'string');
    if (textual && ok([c])) return [c];
  }
  return [];
}

function sameCell(a: CellValue | undefined, b: CellValue | undefined): boolean {
  return (
    cellKey(a) === cellKey(b) && (typeof a !== 'string' || typeof b !== 'string' || a.trim() === b.trim())
  );
}

/** Compares two versions of a table. */
export function diffTables(oldT: TableLike, newT: TableLike, keyColumns?: string[]): TableDiff {
  const oldSet = new Set(oldT.columns);
  const newSet = new Set(newT.columns);
  const addedColumns = newT.columns.filter((c) => !oldSet.has(c));
  const removedColumns = oldT.columns.filter((c) => !newSet.has(c));
  const common = oldT.columns.filter((c) => newSet.has(c));
  const commonOld = common.map((c) => oldT.columns.indexOf(c));
  const commonNew = common.map((c) => newT.columns.indexOf(c));

  const keys = (keyColumns ?? detectKeyColumns(oldT, newT)).filter((c) => oldSet.has(c) && newSet.has(c));
  const pairs: [number, number][] = [];
  const added: number[] = [];
  const removed: number[] = [];

  if (keys.length > 0) {
    const oIdx = keys.map((c) => oldT.columns.indexOf(c));
    const nIdx = keys.map((c) => newT.columns.indexOf(c));
    // Queue per key so duplicate keys (user-chosen keys need not be unique) pair up in order.
    const byKey = new Map<string, number[]>();
    oldT.rows.forEach((row, i) => {
      const k = rowKey(row, oIdx);
      const q = byKey.get(k);
      if (q) q.push(i);
      else byKey.set(k, [i]);
    });
    const matchedOld = new Uint8Array(oldT.rows.length);
    newT.rows.forEach((row, j) => {
      const q = byKey.get(rowKey(row, nIdx));
      const i = q?.shift();
      if (i === undefined) added.push(j);
      else {
        matchedOld[i] = 1;
        pairs.push([i, j]);
      }
    });
    for (let i = 0; i < oldT.rows.length; i++) if (!matchedOld[i]) removed.push(i);
  } else {
    const n = Math.min(oldT.rows.length, newT.rows.length);
    for (let i = 0; i < n; i++) pairs.push([i, i]);
    for (let j = n; j < newT.rows.length; j++) added.push(j);
    for (let i = n; i < oldT.rows.length; i++) removed.push(i);
  }

  const changed: TableDiff['changed'] = [];
  let unchanged = 0;
  for (const [i, j] of pairs) {
    const a = oldT.rows[i];
    const b = newT.rows[j];
    const cols: string[] = [];
    for (let c = 0; c < common.length; c++)
      if (!sameCell(a[commonOld[c]], b[commonNew[c]])) cols.push(common[c]);
    if (cols.length > 0) changed.push({ oldIndex: i, newIndex: j, columns: cols });
    else unchanged++;
  }

  return {
    added,
    removed,
    changed,
    unchanged,
    keyUsed: keys,
    headersChanged: addedColumns.length > 0 || removedColumns.length > 0,
    addedColumns,
    removedColumns,
  };
}
