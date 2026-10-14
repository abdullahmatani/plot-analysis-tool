import { describe, expect, it } from 'vitest';

import { buildTable, detectHeaderRow, importTable, uniqueColumnNames } from './table';
import { readFixture } from './test-helpers';

const EXPECTED_COLUMNS = [
  'Tag',
  'Scenario',
  'Category',
  'X',
  'Y',
  'Radiation 4 kW/m2 (m)',
  'Radiation 12.5 kW/m2 (m)',
  'Radiation 37.5 kW/m2 (m)',
  'الوصف',
  'Notes',
];

describe('importTable — row 62 acceptance: every route gives the identical dataset', () => {
  const csv = importTable({ kind: 'csv', bytes: readFixture('consequences.csv') });

  it('reads the CSV (UTF-8 BOM) with Arabic text, multi-line cells and trimmed values', () => {
    expect(csv.headerRow).toBe(0);
    expect(csv.table.columns).toEqual(EXPECTED_COLUMNS);
    expect(csv.table.rows).toHaveLength(30);
    expect(csv.table.rows[0]).toEqual([
      'P-101',
      'P-101 10 mm leak',
      'Jet fire',
      100,
      50,
      31,
      19.2,
      10.8,
      'حريق نفاث عند P-101',
      null,
    ]);
    expect(csv.table.rows[3][9]).toBe('Line one\nLine two');
    expect(csv.table.rows[4][7]).toBe('N/R');
    expect(csv.table.rows[5][0]).toBe('C-401');
    expect(csv.table.rows[7][9]).toBe('Release of 12" line, see "Case B"');
    expect(csv.preview).toHaveLength(30);
  });

  const routes: [string, () => ReturnType<typeof importTable>][] = [
    ['TSV (UTF-16LE BOM)', () => importTable({ kind: 'tsv', bytes: readFixture('consequences.tsv') })],
    [
      'CSV with semicolons and decimal commas',
      () => importTable({ kind: 'csv', bytes: readFixture('consequences-semicolon.csv') }),
    ],
    ['CSV in windows-1256', () => importTable({ kind: 'csv', bytes: readFixture('consequences-1256.csv') })],
    [
      'XLSX (title rows above the header)',
      () => importTable({ kind: 'xlsx', bytes: readFixture('consequences.xlsx') }),
    ],
    [
      'clipboard text/plain',
      () =>
        importTable({
          kind: 'clipboard',
          text: new TextDecoder().decode(readFixture('consequences-clipboard.txt')),
        }),
    ],
    [
      'clipboard text/html',
      () =>
        importTable({
          kind: 'clipboard',
          text: '',
          html: new TextDecoder().decode(readFixture('consequences-clipboard.html')),
        }),
    ],
  ];
  for (const [name, run] of routes) {
    it(`${name} equals the CSV import`, () => {
      const r = run();
      expect(r.table.columns).toEqual(csv.table.columns);
      expect(r.table.rows).toEqual(csv.table.rows);
    });
  }

  it('XLSX lists sheets for the picker, skips the title rows and can read another sheet', () => {
    const r = importTable({ kind: 'xlsx', bytes: readFixture('consequences.xlsx') });
    expect(r.sheets).toEqual(['Results', 'Info', 'Hidden calc']);
    expect(r.sheet).toBe('Results');
    expect(r.headerRow).toBe(2);
    const info = importTable({ kind: 'xlsx', bytes: readFixture('consequences.xlsx'), sheet: 'info' });
    expect(info.sheet).toBe('Info');
    expect(() =>
      importTable({ kind: 'xlsx', bytes: readFixture('consequences.xlsx'), sheet: 'Nope' }),
    ).toThrow(/not found/);
  });

  it('accepts a header-row override', () => {
    const r = importTable({ kind: 'csv', text: 'a,b\n1,2\n3,4', headerRow: -1 });
    expect(r.table.columns).toEqual(['Column 1', 'Column 2']);
    expect(r.table.rows).toEqual([
      ['a', 'b'],
      [1, 2],
      [3, 4],
    ]);
  });

  it('limits the preview to 50 rows', () => {
    const text = ['n', ...Array.from({ length: 120 }, (_, i) => String(i))].join('\n');
    const r = importTable({ kind: 'csv', text });
    expect(r.table.rows).toHaveLength(120);
    expect(r.preview).toHaveLength(50);
  });
});

describe('detectHeaderRow', () => {
  it('finds a header below title rows', () => {
    expect(
      detectHeaderRow([['Consequence results'], [], ['Tag', 'X', 'Y', 'Radius'], ['P-101', 1, 2, 3]]),
    ).toBe(2);
  });

  it('returns -1 for all-numeric tables and 0 for all-text tables', () => {
    expect(
      detectHeaderRow([
        [1, 2],
        [3, 4],
      ]),
    ).toBe(-1);
    expect(
      detectHeaderRow([
        ['Name', 'Description'],
        ['P-101', 'Pump'],
      ]),
    ).toBe(0);
  });

  it('keeps the header when a units row follows it', () => {
    expect(
      detectHeaderRow([
        ['Tag', 'X', 'Y', 'R1', 'R2', 'R3'],
        ['', 'm', 'm', 'm', 'm', ''],
        ['P-101', 1, 2, 3, 4, 5],
      ]),
    ).toBe(0);
  });

  it('accepts numeric strings as data (CSV)', () => {
    expect(
      detectHeaderRow([
        ['Tag', 'Radius'],
        ['P-1', '12.5'],
      ]),
    ).toBe(0);
  });
});

describe('buildTable', () => {
  it('names empty and duplicate headers uniquely', () => {
    expect(uniqueColumnNames(['Radius', '', 'radius', 'Radius', 'Radius (2)'])).toEqual([
      'Radius',
      'Column 2',
      'radius (3)',
      'Radius (4)',
      'Radius (2)',
    ]);
    const t = buildTable(
      [
        ['A', '', 'A'],
        [1, 2, 3],
      ],
      0,
    );
    expect(t.columns).toEqual(['A', 'Column 2', 'A (2)']);
  });

  it('converts numbers, keeps identifiers, trims, drops empty rows, pads ragged rows', () => {
    const t = buildTable(
      [
        ['Tag', 'Value', 'Code', 'Extra'],
        [' P-1 ', '1,234.5', '007', null],
        ['', '', '  ', ''],
        ['P-2', '-3e2', '0.5'],
        ['P-3', '12'],
      ],
      0,
    );
    expect(t.rows).toEqual([
      ['P-1', 1234.5, '007', null],
      ['P-2', -300, 0.5, null],
      ['P-3', 12, null, null],
    ]);
  });

  it('reads decimal commas only when the table shows unambiguous evidence', () => {
    const european = buildTable(
      [
        ['a', 'b'],
        ['1,234', '12,5'],
      ],
      0,
    );
    expect(european.rows[0]).toEqual([1.234, 12.5]);
    const english = buildTable(
      [
        ['a', 'b'],
        ['1,234', '12.5'],
      ],
      0,
    );
    expect(english.rows[0]).toEqual([1234, 12.5]);
    const ambiguous = buildTable([['a'], ['1,234']], 0);
    expect(ambiguous.rows[0]).toEqual([1234]);
    const spaces = buildTable([['a'], ['1 234,5']], 0);
    expect(spaces.rows[0]).toEqual([1234.5]);
  });

  it('drops trailing columns that are empty everywhere and normalises line breaks', () => {
    const t = buildTable(
      [
        ['A', 'B', null, ''],
        ['x\r\ny', 1, null, ''],
      ],
      0,
    );
    expect(t.columns).toEqual(['A', 'B']);
    expect(t.rows).toEqual([['x\ny', 1]]);
  });

  it('collapses whitespace and line breaks in header names', () => {
    const t = buildTable([['Radiation\n4 kW/m2  (m)'], [1]], 0);
    expect(t.columns).toEqual(['Radiation 4 kW/m2 (m)']);
  });
});
