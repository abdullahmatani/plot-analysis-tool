import { describe, expect, it } from 'vitest';

import { detectDelimiter, formatDelimited, parseDelimited } from './csv';
import { importTable } from './table';
import { readFixture } from './test-helpers';

describe('detectDelimiter', () => {
  it('detects comma, semicolon, tab and pipe', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t');
    expect(detectDelimiter('a|b|c\n1|2|3\n')).toBe('|');
  });

  it('prefers semicolons when commas are decimal separators', () => {
    expect(detectDelimiter('Name;Value;Other\nA;1,5;2,25\nB;3,75;4\n')).toBe(';');
    expect(detectDelimiter('x;y\n1,5;2,5\n3,5;4,5\n')).toBe(';');
  });

  it('ignores delimiters inside quotes and handles single-column files', () => {
    expect(detectDelimiter('Name\tNote\nA\t"x, y, z"\nB\t"p, q"\n')).toBe('\t');
    expect(detectDelimiter('"a;b",c\n"d;e;f",g\n')).toBe(',');
    expect(detectDelimiter('Radius\n12\n13\n')).toBe(',');
  });
});

describe('parseDelimited', () => {
  it('handles quotes, doubled quotes, embedded delimiters and newlines', () => {
    const text = '\ufeffTag,Note,R\r\nP-1,"a, ""quoted"" note",12\r\nP-2,"multi\r\nline",13\r\n\r\n';
    expect(parseDelimited(text)).toEqual([
      ['Tag', 'Note', 'R'],
      ['P-1', 'a, "quoted" note', '12'],
      ['P-2', 'multi\r\nline', '13'],
    ]);
  });

  it('accepts an explicit delimiter, LF/CR line endings and ragged rows', () => {
    expect(parseDelimited('a;b\n1;2;3\n4', { delimiter: ';' })).toEqual([['a', 'b'], ['1', '2', '3'], ['4']]);
    expect(parseDelimited('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps blank lines inside the table and drops trailing ones', () => {
    expect(parseDelimited('a,b\n\n1,2\n\n\n')).toEqual([['a', 'b'], [''], ['1', '2']]);
    expect(parseDelimited('')).toEqual([]);
    expect(parseDelimited('  \n')).toEqual([]);
  });
});

describe('Excel sep= hint', () => {
  it('uses and removes the hint line', () => {
    expect(parseDelimited('sep=;\r\na;b,c\r\n1;2,5\r\n')).toEqual([
      ['a', 'b,c'],
      ['1', '2,5'],
    ]);
  });
});

describe('formatDelimited (row 80 export)', () => {
  it('quotes where needed, writes a BOM and CRLF, escapes formula-like text', () => {
    const text = formatDelimited(
      ['Tag', 'Note, with comma'],
      [
        ['P-1', 'say "hi"'],
        ['=1+1', 12.5],
        ['-', null],
        [' padded', 'a\nb'],
      ],
    );
    expect(text).toBe(
      '\ufeffTag,"Note, with comma"\r\nP-1,"say ""hi"""\r\n\'=1+1,12.5\r\n-,\r\n" padded","a\nb"\r\n',
    );
    expect(formatDelimited(['a'], [['@x']], { bom: false, escapeFormulas: false, delimiter: '\t' })).toBe(
      'a\r\n@x\r\n',
    );
  });

  it('round-trips the fixture through CSV export and import', () => {
    const original = importTable({ kind: 'csv', bytes: readFixture('consequences.csv') }).table;
    const again = importTable({ kind: 'csv', text: formatDelimited(original.columns, original.rows) }).table;
    expect(again).toEqual(original);
  });
});
