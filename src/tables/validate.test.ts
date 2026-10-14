import { describe, expect, it } from 'vitest';

import type { Pt } from '@/core/types';

import { normaliseAnchorName } from './access';
import { importTable } from './table';
import { makeDataset, readFixture } from './test-helpers';
import { validateDataset } from './validate';

function errorsTable() {
  return importTable({ kind: 'csv', bytes: readFixture('consequences-errors.csv') }).table;
}

function anchors(): Map<string, Pt> {
  const m = new Map<string, Pt>();
  for (const tag of ['P-101', 'P-102', 'P-103', 'P-104', 'P-105', 'P-106', 'P-107', 'P-110', 'P-111']) {
    m.set(normaliseAnchorName(tag), { x: 10, y: 20 });
  }
  return m;
}

describe('validateDataset — row 69 acceptance: deliberate errors are reported by row number', () => {
  it('XY mode with a drawing extent', () => {
    const ds = makeDataset(errorsTable(), {
      mapping: {
        position: { mode: 'xy', x: 'X', y: 'Y' },
        sizeColumns: ['Radius (m)'],
        sizeMode: 'radius',
        sizeUnit: 'm',
      },
    });
    const r = validateDataset(ds, {
      anchors: new Map(),
      extent: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
    });
    expect(r.issues.map((i) => [i.row, i.severity, i.column ?? '', i.message])).toEqual([
      [2, 'error', 'X', 'Missing X coordinate'],
      [3, 'error', 'Y', 'Y coordinate "abc" is not a number'],
      [4, 'error', 'Radius (m)', 'Size is negative (-5)'],
      [5, 'error', 'Radius (m)', 'Size "twelve" is not a number'],
      [6, 'warning', 'Radius (m)', 'Size is zero; no contour drawn'],
      [7, 'error', 'X', 'Position (5000, 5000) is outside the drawing extent'],
      [10, 'warning', '', 'No size value in any size column'],
    ]);
    expect([...r.validRows]).toEqual([1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1]);
    expect(r.counts).toEqual({ total: 11, valid: 4, invalid: 7, errors: 5, warnings: 2 });
  });

  it('anchor mode lists unknown and missing anchors', () => {
    const ds = makeDataset(errorsTable(), {
      mapping: {
        position: { mode: 'anchor', anchor: 'Tag' },
        sizeColumns: ['Radius (m)'],
        sizeMode: 'radius',
        sizeUnit: 'm',
      },
    });
    const r = validateDataset(ds, { anchors: anchors() });
    const anchorIssues = r.issues.filter((i) => i.column === 'Tag');
    expect(anchorIssues.map((i) => [i.row, i.message])).toEqual([
      [8, 'Unknown anchor "P-999"'],
      [9, 'Missing anchor name'],
    ]);
    expect(r.validRows[0]).toBe(1);
    expect(r.validRows[7]).toBe(0);
  });

  it('reports an incomplete mapping as dataset-level errors and invalidates every row', () => {
    const ds = makeDataset(errorsTable(), {
      mapping: { position: { mode: 'xy', x: 'X' }, sizeColumns: [], sizeMode: 'radius', sizeUnit: 'm' },
    });
    const r = validateDataset(ds, { anchors: new Map() });
    expect(r.issues.map((i) => [i.row, i.message])).toEqual([
      [0, 'Map the Y column.'],
      [0, 'Map at least one size column.'],
    ]);
    expect(r.counts.valid).toBe(0);
  });

  it('checks rectangles, shapes, rotations and colours', () => {
    const table = {
      columns: ['X', 'Y', 'R', 'Shape', 'W', 'H', 'Rot', 'Colour'],
      rows: [
        [0, 0, 5, 'rect', 10, 4, 30, '#ff0000'],
        [0, 0, 5, 'rect', null, 4, 'abc', 'blurple'],
        [0, 0, 5, 'hexagon', null, null, null, null],
        [0, 0, 'N/R', 'circle', null, null, null, null],
      ],
    };
    const ds = makeDataset(table, {
      mapping: {
        position: { mode: 'xy', x: 'X', y: 'Y' },
        sizeColumns: ['R'],
        sizeMode: 'radius',
        sizeUnit: 'm',
        shape: 'Shape',
        width: 'W',
        height: 'H',
        rotation: 'Rot',
        color: 'Colour',
      },
    });
    const r = validateDataset(ds, { anchors: new Map() });
    expect(r.issues.map((i) => [i.row, i.severity, i.message])).toEqual([
      [2, 'error', 'Rectangle width "" is not a positive number'],
      [2, 'warning', 'Rotation "abc" is not a number; 0° used'],
      [2, 'warning', 'Colour "blurple" is not recognised'],
      [3, 'warning', 'Unknown shape "hexagon"; drawn as a circle'],
      [4, 'warning', 'No size value in any size column'],
    ]);
    expect([...r.validRows]).toEqual([1, 0, 1, 0]);
  });

  it('accepts the clean consequence fixture', () => {
    const { table } = importTable({ kind: 'csv', bytes: readFixture('consequences.csv') });
    const r = validateDataset(makeDataset(table), {
      anchors: new Map(),
      extent: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
    });
    expect(r.counts).toEqual({ total: 30, valid: 30, invalid: 0, errors: 0, warnings: 0 });
  });
});
