import { describe, expect, it } from 'vitest';

import type { CellValue } from '@/core/types';

import { detectKeyColumns, diffTables } from './diff';

const columns = ['Tag', 'Scenario', 'Radius'];
const oldRows: CellValue[][] = [
  ['P-101', 'Jet fire', 25],
  ['P-101', 'Pool fire', 15],
  ['V-201', 'Jet fire', 30],
  ['T-301', 'Fireball', 50],
];

describe('diffTables (row 72)', () => {
  it('detects a composite key and reports added, removed and changed rows', () => {
    const newRows: CellValue[][] = [
      ['V-201', 'Jet fire', 32], // changed radius, moved
      ['P-101', 'Jet fire', 25],
      ['P-101', 'pool fire', '15'], // case change in a key → still the same key, but a change in Scenario
      ['K-601', 'Jet fire', 12], // added
    ];
    const d = diffTables({ columns, rows: oldRows }, { columns, rows: newRows });
    expect(d.keyUsed).toEqual(['Tag', 'Scenario']);
    expect(d.added).toEqual([3]);
    expect(d.removed).toEqual([3]);
    expect(d.changed).toEqual([
      { oldIndex: 2, newIndex: 0, columns: ['Radius'] },
      { oldIndex: 1, newIndex: 2, columns: ['Scenario'] },
    ]);
    expect(d.unchanged).toBe(1);
    expect(d.headersChanged).toBe(false);
  });

  it('uses a unique ID column when available', () => {
    const a = {
      columns: ['ID', 'Name', 'R'],
      rows: [
        [1, 'a', 1],
        [2, 'a', 2],
      ] as CellValue[][],
    };
    const b = {
      columns: ['R', 'Name', 'ID'],
      rows: [
        [3, 'a', 2],
        [1, 'a', 1],
      ] as CellValue[][],
    };
    expect(detectKeyColumns(a, b)).toEqual(['ID']);
    const d = diffTables(a, b);
    expect(d.changed).toEqual([{ oldIndex: 1, newIndex: 0, columns: ['R'] }]);
    expect(d.unchanged).toBe(1);
    expect(d.headersChanged).toBe(false);
  });

  it('falls back to row position and reports header changes', () => {
    const a = {
      columns: ['A', 'B'],
      rows: [
        [1, 1],
        [1, 2],
        [1, 3],
      ] as CellValue[][],
    };
    const b = {
      columns: ['A', 'C'],
      rows: [
        [1, 9],
        [2, 9],
      ] as CellValue[][],
    };
    const d = diffTables(a, b);
    expect(d.keyUsed).toEqual([]);
    expect(d.headersChanged).toBe(true);
    expect(d.addedColumns).toEqual(['C']);
    expect(d.removedColumns).toEqual(['B']);
    expect(d.changed).toEqual([{ oldIndex: 1, newIndex: 1, columns: ['A'] }]);
    expect(d.unchanged).toBe(1);
    expect(d.removed).toEqual([2]);
    expect(d.added).toEqual([]);
  });

  it('honours explicit (possibly non-unique) key columns', () => {
    const d = diffTables({ columns, rows: oldRows }, { columns, rows: [oldRows[1], oldRows[0]] }, ['Tag']);
    expect(d.keyUsed).toEqual(['Tag']);
    expect(d.removed).toEqual([2, 3]);
    expect(d.changed).toEqual([
      { oldIndex: 0, newIndex: 0, columns: ['Scenario', 'Radius'] },
      { oldIndex: 1, newIndex: 1, columns: ['Scenario', 'Radius'] },
    ]);
  });

  it('treats number and numeric string as equal', () => {
    const d = diffTables(
      { columns: ['K', 'V'], rows: [['a', 12.5]] },
      { columns: ['K', 'V'], rows: [['a', '12.5']] },
    );
    expect(d.unchanged).toBe(1);
  });
});
