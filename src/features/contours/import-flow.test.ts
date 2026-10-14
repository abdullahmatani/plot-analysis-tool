import { describe, expect, it } from 'vitest';

import { createProject } from '@/core/project';
import { readFixture } from '@/tables/test-helpers';

import { datasetNameFor, initialMapping, parseSource, tableKindOf, type TableSource } from './import-flow';
import { buildDataset } from './ops';

const text = (name: string) => new TextDecoder().decode(readFixture(name));

const ROUTES: [string, TableSource][] = [
  ['CSV (UTF-8 BOM)', { kind: 'csv', name: 'consequences.csv', bytes: readFixture('consequences.csv') }],
  ['TSV (UTF-16LE)', { kind: 'tsv', name: 'consequences.tsv', bytes: readFixture('consequences.tsv') }],
  [
    'CSV (semicolon, decimal comma)',
    { kind: 'csv', name: 'c.csv', bytes: readFixture('consequences-semicolon.csv') },
  ],
  ['CSV (windows-1256)', { kind: 'csv', name: 'c.csv', bytes: readFixture('consequences-1256.csv') }],
  [
    'XLSX (title rows above the header)',
    { kind: 'xlsx', name: 'consequences.xlsx', bytes: readFixture('consequences.xlsx') },
  ],
  [
    'clipboard (text + html)',
    {
      kind: 'clipboard',
      name: 'Pasted table',
      text: text('consequences-clipboard.txt'),
      html: text('consequences-clipboard.html'),
    },
  ],
  [
    'clipboard (text only)',
    { kind: 'clipboard', name: 'Pasted table', text: text('consequences-clipboard.txt') },
  ],
];

function datasetOf(src: TableSource) {
  const r = parseSource(src);
  return buildDataset(createProject('T'), {
    name: 'x',
    table: r.table,
    mapping: initialMapping(r.table.columns, r.table.rows),
  });
}

describe('row 62: the same data imported by each route produces identical datasets', () => {
  const ref = datasetOf(ROUTES[0][1]);

  it('suggests a complete mapping for the consequence table', () => {
    expect(ref.mapping).toMatchObject({
      position: { mode: 'xy', x: 'X', y: 'Y', anchor: 'Tag' },
      sizeColumns: ['Radiation 4 kW/m2 (m)', 'Radiation 12.5 kW/m2 (m)', 'Radiation 37.5 kW/m2 (m)'],
      sizeMode: 'radius',
      sizeUnit: 'm',
      label: 'Scenario',
      group: 'Category',
    });
    expect(ref.table.rows).toHaveLength(30);
    expect(ref.table.rows[0][8]).toBe('حريق نفاث عند P-101');
  });

  it.each(ROUTES.slice(1))('%s', (_name, src) => {
    const ds = datasetOf(src);
    expect(ds.table).toEqual(ref.table);
    expect(ds.mapping).toEqual(ref.mapping);
    expect(ds.sizeStyles).toEqual(ref.sizeStyles);
  });
});

describe('table sources', () => {
  it('detects table kinds by signature (UTF-16 TSV included) and extension', () => {
    expect(tableKindOf('consequences.tsv', readFixture('consequences.tsv'))).toBe('tsv');
    expect(tableKindOf('consequences.csv', readFixture('consequences.csv'))).toBe('csv');
    expect(tableKindOf('results.dat', readFixture('consequences.xlsx'))).toBe('xlsx');
    expect(tableKindOf('drawing.csv', new TextEncoder().encode('%PDF-1.7\n'))).toBeNull();
  });

  it('lets the user pick the sheet and header row', () => {
    const src: TableSource = {
      kind: 'xlsx',
      name: 'consequences.xlsx',
      bytes: readFixture('consequences.xlsx'),
    };
    const r = parseSource(src);
    expect(r.sheets!.length).toBeGreaterThan(1);
    expect(r.headerRow).toBeGreaterThan(0);
    const none = parseSource(src, { headerRow: -1 });
    expect(none.table.columns[0]).toBe('Column 1');
    expect(datasetNameFor(src, r.sheet, r.sheets)).toBe('consequences');
    expect(datasetNameFor(src, r.sheets![1], r.sheets)).toBe(`consequences – ${r.sheets![1]}`);
  });

  it('previews the first 50 rows', () => {
    const rows = Array.from({ length: 80 }, (_, i) => `${i},${i},${i + 1}`).join('\n');
    const r = parseSource({ kind: 'csv', name: 'a.csv', text: `X,Y,Radius\n${rows}` });
    expect(r.table.rows).toHaveLength(80);
    expect(r.preview).toHaveLength(50);
  });
});
