import { beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '@/core/project';
import type { ContourDataset } from '@/core/types';
import { getProject, useProjectStore } from '@/store/project';

import { datasetContours, datasetLegend } from './compute';
import {
  addDataset,
  addRow,
  buildDataset,
  deleteRows,
  moveDataset,
  nextDatasetName,
  parseCellInput,
  reconcileSizeStyles,
  replaceData,
  resolveMappingColumns,
  setCell,
  updateDataset,
} from './ops';

const NO_EXTENT = { extent: null } as const;

const table = {
  columns: ['Tag', 'Category', 'X', 'Y', 'R4', 'R12'],
  rows: [
    ['P-101', 'Jet fire', 0, 0, 30, 12],
    ['P-102', 'Pool fire', 100, 0, 40, 20],
  ],
};

function load() {
  useProjectStore.getState().load({ project: createProject('Ops'), undo: [], redo: [] });
}

function makeDs(): ContourDataset {
  return buildDataset(getProject()!, {
    name: 'Fires',
    table,
    mapping: {
      position: { mode: 'xy', x: 'X', y: 'Y' },
      sizeColumns: ['R4', 'R12'],
      sizeMode: 'radius',
      sizeUnit: 'm',
      label: 'Tag',
      group: 'Category',
    },
    styleRules: [{ id: 'rule', kind: 'categorical', column: 'Category', categories: [] }],
  });
}

const ds = () => getProject()!.datasets[0];
const rings = () => datasetContours(getProject()!, ds(), NO_EXTENT).rings;
const undo = () => useProjectStore.getState().undo();

describe('dataset commands (one user action = one undo step)', () => {
  beforeEach(load);

  it('imports a dataset in one undo step with default ring-set styles', () => {
    expect(addDataset(makeDs())).toBe(true);
    expect(ds().sizeStyles.map((s) => [s.column, s.visible])).toEqual([
      ['R4', true],
      ['R12', true],
    ]);
    expect(new Set(ds().sizeStyles.map((s) => s.color)).size).toBe(2);
    expect(useProjectStore.getState().history!.undo).toHaveLength(1);
    undo();
    expect(getProject()!.datasets).toHaveLength(0);
  });

  it('editing a radius cell updates its contour immediately (row 68)', () => {
    addDataset(makeDs());
    expect(rings().find((r) => r.row === 0 && r.sizeColumn === 'R4')!.item.r).toBe(30);
    expect(setCell(ds().id, 0, 4, '45.5')).toBe(true);
    expect(ds().table.rows[0][4]).toBe(45.5);
    expect(rings().find((r) => r.row === 0 && r.sizeColumn === 'R4')!.item.r).toBe(45.5);
    undo();
    expect(rings().find((r) => r.row === 0 && r.sizeColumn === 'R4')!.item.r).toBe(30);
  });

  it('a new category value gets a colour and a legend entry automatically (row 67)', () => {
    addDataset(makeDs());
    const before = ds().styleRules[0].categories!.map((c) => c.value);
    expect(before).toEqual(['Jet fire', 'Pool fire']);
    setCell(ds().id, 1, 1, 'Fireball');
    const cats = ds().styleRules[0].categories!;
    expect(cats.map((c) => c.value)).toEqual(['Jet fire', 'Pool fire', 'Fireball']);
    expect(new Set(cats.map((c) => c.color)).size).toBe(3);
    const legend = datasetLegend(getProject()!, ds(), NO_EXTENT).entries.map((e) => e.label);
    expect(legend).toContain('Fireball');
  });

  it('adds, duplicates and deletes rows', () => {
    addDataset(makeDs());
    const i = addRow(ds().id);
    expect(i).toBe(2);
    expect(ds().table.rows[2]).toEqual([null, null, null, null, null, null]);
    expect(addRow(ds().id, 0)).toBe(3);
    expect(ds().table.rows[3]).toEqual(table.rows[0]);
    deleteRows(ds().id, [2, 3]);
    expect(ds().table.rows).toEqual(table.rows);
  });

  it('re-import replaces data and keeps mapping, styles and rules (row 72)', () => {
    addDataset(makeDs());
    updateDataset(ds().id, 'style', (d) => {
      d.sizeStyles[0].color = '#123456';
      d.labelTemplate = '{label} {radius} m';
    });
    const newTable = {
      columns: table.columns,
      rows: [...table.rows, ['P-103', 'Flash fire', 50, 50, 10, 5]],
    };
    expect(replaceData(ds().id, newTable, { source: { fileName: 'v2.csv', importedAt: 'now' } })).toBe(true);
    expect(ds().table.rows).toHaveLength(3);
    expect(ds().sizeStyles[0].color).toBe('#123456');
    expect(ds().labelTemplate).toBe('{label} {radius} m');
    expect(ds().styleRules[0].categories!.map((c) => c.value)).toContain('Flash fire');
    expect(rings().filter((r) => r.row === 2)).toHaveLength(2);
  });

  it('reorders datasets (draw order, row 71)', () => {
    addDataset(makeDs());
    const second = makeDs();
    second.name = nextDatasetName(getProject()!, 'Fires');
    expect(second.name).toBe('Fires (2)');
    addDataset(second);
    const [a, b] = getProject()!.datasets;
    expect(a.order).toBeLessThan(b.order);
    moveDataset(b.id, -1);
    const p = getProject()!;
    expect(p.datasets.find((d) => d.id === b.id)!.order).toBeLessThan(
      p.datasets.find((d) => d.id === a.id)!.order,
    );
  });
});

describe('helpers', () => {
  it('parses typed cells like the import pipeline', () => {
    expect(parseCellInput(' 12.5 ')).toBe(12.5);
    expect(parseCellInput('1,234')).toBe(1234);
    expect(parseCellInput('12,5')).toBe(12.5);
    expect(parseCellInput('')).toBeNull();
    expect(parseCellInput('P-101')).toBe('P-101');
    expect(parseCellInput('007')).toBe('007');
  });

  it('keeps size styles of removed columns and gives new columns unused colours', () => {
    const s = reconcileSizeStyles(
      ['A', 'B'],
      [{ column: 'A', visible: false, color: '#2563eb', dash: 'dot', fillOpacity: 0, strokeWidth: 1 }],
    );
    expect(s[0]).toMatchObject({ column: 'A', visible: false, dash: 'dot' });
    expect(s[1].column).toBe('B');
    expect(s[1].color).not.toBe('#2563eb');
    expect(reconcileSizeStyles(['B'], s).map((x) => x.column)).toEqual(['A', 'B']);
  });

  it('resolves mapping columns case-insensitively', () => {
    const m = resolveMappingColumns(
      {
        position: { mode: 'xy', x: 'x', y: 'Y ' },
        sizeColumns: ['r4'],
        sizeMode: 'radius',
        sizeUnit: 'm',
        label: 'tag',
      },
      table.columns,
    );
    expect(m.position).toMatchObject({ x: 'X', y: 'Y' });
    expect(m.sizeColumns).toEqual(['R4']);
    expect(m.label).toBe('Tag');
  });
});
