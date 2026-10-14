import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { readFixture } from './test-helpers';
import {
  columnIndex,
  columnLetters,
  dateKindOfFormat,
  openXlsx,
  readXlsx,
  sanitizeSheetNames,
  serialToIso,
  writeXlsx,
} from './xlsx';

describe('readXlsx — openpyxl fixtures', () => {
  it('reads value types, dates, sparse cells and an Arabic sheet name', () => {
    const { sheets } = readXlsx(readFixture('features.xlsx'));
    expect(sheets.map((s) => s.name)).toEqual(['Types', 'بيانات']);
    const rows = sheets[0].rows;
    const byKind = new Map(rows.filter((r) => typeof r[0] === 'string').map((r) => [r[0] as string, r[1]]));
    expect(byKind.get('date')).toBe('2024-03-15');
    expect(byKind.get('datetime')).toBe('2024-03-15T13:45:30');
    expect(byKind.get('time')).toBe('06:30:00');
    expect(byKind.get('builtin14')).toBe('1999-12-31');
    expect(byKind.get('true')).toBe('TRUE');
    expect(byKind.get('false')).toBe('FALSE');
    expect(byKind.get('error')).toBe('#DIV/0!');
    expect(byKind.get('formula')).toBeUndefined(); // openpyxl stores no cached value
    expect(byKind.get('float')).toBe(1234.5678);
    expect(byKind.get('percent')).toBe(0.125);
    expect(byKind.get('quoted unit')).toBe(42);
    expect(byKind.get('rich')).toBe('Bold and plain');
    expect(byKind.get('entities')).toBe('a < b & c > "d" \'e\'');
    expect(byKind.get('arabic')).toBe('مرحبا بالعالم');
    expect(byKind.get('big int')).toBe(12345678901);
    expect(byKind.get('negative')).toBe(-0.5);
    // Sparse cells: A20, D20, F22; merged A24:B24 keeps its value in A24.
    expect(rows[19]).toEqual(['sparse', null, null, 7]);
    expect(rows[20]).toEqual([]);
    expect(rows[21]).toEqual([null, null, null, null, null, 'far']);
    expect(rows[23]).toEqual(['merged']);
    expect(sheets[1].rows).toEqual([
      ['اسم', 'قيمة'],
      ['أ', 1],
      ['ب', 2],
    ]);
  });

  it('reads the 1904 date system', () => {
    const { sheets } = readXlsx(readFixture('dates1904.xlsx'));
    expect(sheets[0].rows[1][0]).toBe('2024-03-15');
  });

  it('marks hidden sheets', () => {
    const wb = openXlsx(readFixture('consequences.xlsx'));
    expect(wb.sheets.map((s) => [s.name, s.hidden])).toEqual([
      ['Results', false],
      ['Info', false],
      ['Hidden calc', true],
    ]);
  });

  it('rejects non-XLSX input with readable errors', () => {
    expect(() => readXlsx(strToU8('a,b\n1,2'))).toThrow(/not a ZIP/);
    expect(() => readXlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).toThrow(/Legacy \.xls/);
    expect(() => readXlsx(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/no workbook/);
  });
});

/** A hand-written workbook exercising features openpyxl does not produce. */
function handmade(): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets>' +
      '<x:sheet name="Second &amp; last" sheetId="2" rel:id="rId2"/>' +
      '<x:sheet name="Chart" sheetId="3" rel:id="rId3"/>' +
      '</x:sheets></x:workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/data.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/>' +
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="strings.xml"/>' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
    'xl/strings.xml':
      '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<si><t>Tag</t></si>' +
      '<si><r><rPr><b/></rPr><t xml:space="preserve">Rich </t></r><r><t>text</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>' +
      '<si><t>Line_x000D_&#10;break &#x41;&#65;</t></si>' +
      '<si/>' +
      '</sst>',
    'xl/styles.xml':
      '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="[$-409]d\\-mmm\\-yyyy;@"/><numFmt numFmtId="165" formatCode="0.00&quot; m&quot;"/></numFmts>' +
      '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
      '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="22"/></cellXfs>' +
      '</styleSheet>',
    'xl/worksheets/data.xml':
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
      // Row without r and cells without r: sequential.
      '<row><c t="str"><f>CONCAT("a","b")</f><v>ab</v></c><c><f>1+1</f><v>2</v></c><c t="b"><v>1</v></c><c t="e"><v>#N/A</v></c></row>' +
      '<row r="5"><c r="B5" s="1"><v>45366</v></c><c r="C5" s="2"><v>12.5</v></c><c r="D5" s="3"><v>45366.75</v></c>' +
      '<c r="E5" t="inlineStr"><is><r><t>in</t></r><r><t>line</t></r></is></c><c r="AA5" t="d"><v>2024-03-15T00:00:00Z</v></c></row>' +
      '<row r="6" spans="1:3"><c r="A6" s="1"/><c r="B6"><v></v></c></row>' +
      '</sheetData></worksheet>',
  };
  const zipped: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) zipped[k] = strToU8(v);
  return zipSync(zipped);
}

describe('readXlsx — handmade workbook', () => {
  it('handles prefixes, absolute targets, rich/phonetic text, escapes, cached formulas and sparse rows', () => {
    const { sheets } = readXlsx(handmade());
    expect(sheets.map((s) => s.name)).toEqual(['Second & last']); // chart sheet skipped
    const rows = sheets[0].rows;
    expect(rows[0]).toEqual(['Tag', 'Rich text', 'Line\r\nbreak AA']);
    expect(rows[1]).toEqual(['ab', 2, 'TRUE', '#N/A']);
    expect(rows[2]).toEqual([]);
    expect(rows[3]).toEqual([]);
    const r5 = rows[4];
    expect(r5[1]).toBe('2024-03-15'); // custom d-mmm-yyyy with locale prefix and text section
    expect(r5[2]).toBe(12.5); // 0.00" m" is not a date format
    expect(r5[3]).toBe('2024-03-15T18:00:00'); // built-in 22
    expect(r5[4]).toBe('inline');
    expect(r5[26]).toBe('2024-03-15T00:00:00Z');
    expect(rows).toHaveLength(5); // row 6 has no values
  });
});

describe('number formats and serial dates', () => {
  it('classifies format codes', () => {
    expect(dateKindOfFormat('yyyy-mm-dd')).toBe('date');
    expect(dateKindOfFormat('[$-F800]dddd, mmmm dd, yyyy')).toBe('date');
    expect(dateKindOfFormat('h:mm AM/PM')).toBe('time');
    expect(dateKindOfFormat('[h]:mm:ss')).toBe('time');
    expect(dateKindOfFormat('mm:ss.0')).toBe('time');
    expect(dateKindOfFormat('dd/mm/yyyy hh:mm')).toBe('datetime');
    expect(dateKindOfFormat('#,##0.00')).toBeNull();
    expect(dateKindOfFormat('0.0 "days"')).toBeNull();
    expect(dateKindOfFormat('0.00E+00')).toBeNull();
    expect(dateKindOfFormat('General')).toBeNull();
    expect(dateKindOfFormat('[Red]0.00;[Blue]-0.00')).toBeNull();
    expect(dateKindOfFormat('@')).toBeNull();
  });

  it('converts serials in both date systems', () => {
    expect(serialToIso(1, false, 'date')).toBe('1900-01-01');
    expect(serialToIso(59, false, 'date')).toBe('1900-02-28');
    expect(serialToIso(61, false, 'date')).toBe('1900-03-01');
    expect(serialToIso(45366, false, 'date')).toBe('2024-03-15');
    expect(serialToIso(0, true, 'date')).toBe('1904-01-01');
    expect(serialToIso(0.5, false, 'time')).toBe('12:00:00');
    expect(serialToIso(1.25, false, 'time')).toBe('30:00:00');
    expect(serialToIso(45366.999999, false, 'datetime')).toBe('2024-03-16T00:00:00');
    expect(serialToIso(-1, false, 'date')).toBeNull();
  });

  it('maps column letters both ways', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('z9')).toBe(25);
    expect(columnIndex('AA10')).toBe(26);
    expect(columnIndex('XFD1')).toBe(16383);
    for (const i of [0, 25, 26, 51, 52, 701, 702, 16383]) expect(columnIndex(columnLetters(i))).toBe(i);
  });
});

describe('writeXlsx', () => {
  it('sanitises sheet names (≤ 31 chars, no []:*?/\\, unique, not "History")', () => {
    expect(
      sanitizeSheetNames([
        'a/b:c',
        'A/B:C',
        '',
        "'quoted'",
        'History',
        'x'.repeat(40),
        'x'.repeat(40),
        'نتائج [2024]',
      ]),
    ).toEqual([
      'a_b_c',
      'A_B_C (2)',
      'Sheet',
      'quoted',
      'History_',
      'x'.repeat(31),
      `${'x'.repeat(27)} (2)`,
      'نتائج _2024_',
    ]);
  });

  it('round-trips text (incl. Arabic, newlines, control characters), numbers and empty cells', () => {
    const columns = ['Tag', 'الوصف', 'Radius (m)', 'Notes'];
    const rows = [
      ['P-101', 'حريق نفاث', 25.5, 'Line one\nLine two'],
      ['P-102', null, -0.125, '  padded  '],
      ['<&>"\'', 'tab\there', 1e-7, 'bell\u0007 and _x0041_'],
      ['big', '', 12345678901234, null],
    ];
    const bytes = writeXlsx(
      [
        { name: 'Results', columns, rows },
        { name: 'Results', columns: ['A'], rows: [[1]] },
      ],
      { date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) },
    );
    const { sheets } = readXlsx(bytes);
    expect(sheets.map((s) => s.name)).toEqual(['Results', 'Results (2)']);
    expect(sheets[0].rows).toEqual([
      columns,
      ['P-101', 'حريق نفاث', 25.5, 'Line one\nLine two'],
      ['P-102', null, -0.125, '  padded  '],
      ['<&>"\'', 'tab\there', 1e-7, 'bell\u0007 and _x0041_'],
      ['big', null, 12345678901234],
    ]);
    expect(sheets[1].rows).toEqual([['A'], [1]]);
  });

  it('writes the parts Excel requires, a bold frozen header and is deterministic for a fixed date', () => {
    const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    const a = writeXlsx([{ name: 'S', columns: ['A', 'B'], rows: [[1, 'x']], columnWidths: [12, 30] }], {
      date,
    });
    const b = writeXlsx([{ name: 'S', columns: ['A', 'B'], rows: [[1, 'x']], columnWidths: [12, 30] }], {
      date,
    });
    expect(a).toEqual(b);
    const parts = unzipSync(a);
    expect(Object.keys(parts).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const sheet = new TextDecoder().decode(parts['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t>A</t></is></c>');
    expect(sheet).toContain('<col min="2" max="2" width="30" customWidth="1"/>');
    expect(sheet).toContain('<dimension ref="A1:B2"/>');
    const styles = new TextDecoder().decode(parts['xl/styles.xml']);
    expect(styles).toContain('<font><b/>');
    const core = new TextDecoder().decode(parts['docProps/core.xml']);
    expect(core).toContain(
      '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:created>',
    );
  });

  it('writes an empty workbook as one empty sheet', () => {
    const { sheets } = readXlsx(writeXlsx([]));
    expect(sheets).toEqual([{ name: 'Sheet1', rows: [] }]);
  });

  it('re-imports an exported fixture to the same table', async () => {
    const { importTable } = await import('./table');
    const original = importTable({ kind: 'csv', bytes: readFixture('consequences.csv') }).table;
    const bytes = writeXlsx([{ name: 'Contours', ...original }]);
    const again = importTable({ kind: 'xlsx', bytes }).table;
    expect(again).toEqual(original);
  });
});
