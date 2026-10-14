import { describe, expect, it } from 'vitest';

import { decodeHtmlEntities, parseClipboard, parseClipboardText, parseHtmlTable } from './clipboard';

describe('parseClipboardText (Excel text/plain)', () => {
  it('splits tabs and CRLF rows and drops the trailing newline', () => {
    expect(parseClipboardText('Tag\tR\r\nP-1\t12\r\n')).toEqual([
      ['Tag', 'R'],
      ['P-1', '12'],
    ]);
  });

  it('reads quoted multi-line cells with doubled quotes', () => {
    expect(parseClipboardText('a\t"line 1\nline ""2"""\tc\r\nd\t\te\r\n')).toEqual([
      ['a', 'line 1\nline "2"', 'c'],
      ['d', '', 'e'],
    ]);
  });

  it('treats stray quotes as text (Excel does not quote them)', () => {
    expect(parseClipboardText('12" pipe\t"open\r\nx\ty')).toEqual([
      ['12" pipe', '"open'],
      ['x', 'y'],
    ]);
  });

  it('handles a single cell and empty input', () => {
    expect(parseClipboardText('42\r\n')).toEqual([['42']]);
    expect(parseClipboardText('')).toEqual([]);
  });
});

describe('parseHtmlTable (Excel text/html)', () => {
  it('reads cells with unquoted attributes, entities, <br> and x:num', () => {
    const html =
      '<html><head><style>td {color:red}</style></head><body><table border=0>' +
      '<!--StartFragment--><col width=64><tr><td class=xl65>Tag</td><th>R&amp;D</th><td>Note</td></tr>' +
      '<tr><td>P&#8209;1&nbsp;</td><td align=right x:num="12.3456">12.35</td><td>a<br style=\'mso-data-placement:same-cell\'>\r\n  b</td></tr>' +
      '<tr><td>P-2</td><td x:num="0.125">12.5%</td><td>  spaced   out  </td></tr>' +
      '<!--EndFragment--></table></body></html>';
    expect(parseHtmlTable(html)).toEqual([
      ['Tag', 'R&D', 'Note'],
      ['P‑1', '12.3456', 'a\nb'],
      ['P-2', '12.5%', 'spaced out'],
    ]);
  });

  it('expands colspan and rowspan into empty cells', () => {
    const html =
      '<table><tr><td colspan=2>A</td><td rowspan="2">B</td></tr><tr><td>c</td><td>d</td></tr></table>';
    expect(parseHtmlTable(html)).toEqual([
      ['A', '', 'B'],
      ['c', 'd', ''],
    ]);
  });

  it('returns null without a table', () => {
    expect(parseHtmlTable('<p>hello</p>')).toBeNull();
  });

  it('prefers the HTML flavour and falls back to text', () => {
    expect(parseClipboard('x\ty', '<table><tr><td>1</td><td>2</td></tr></table>')).toEqual([['1', '2']]);
    expect(parseClipboard('x\ty', '<b>no table</b>')).toEqual([['x', 'y']]);
  });

  it('decodes entities', () => {
    expect(decodeHtmlEntities('&lt;&gt;&amp;&quot;&#39;&#x41;&deg;&unknown;')).toBe('<>&"\'A°&unknown;');
  });
});
