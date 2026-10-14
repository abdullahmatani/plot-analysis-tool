import { parseNumber } from './values';

/**
 * Paste-from-clipboard parsing for a copied spreadsheet range (row 62). Excel puts two flavours on
 * the clipboard: `text/plain` (TSV; cells containing tabs, newlines or quotes are wrapped in quotes
 * with doubled inner quotes) and `text/html` (a <table>). The HTML flavour is preferred when it
 * holds a table because it carries unrounded numbers (`x:num`) and unambiguous cell boundaries;
 * it is read with a tiny tag scanner (no DOMParser, so this runs in workers).
 */

/** Lenient TSV parser matching Excel's clipboard text. */
export function parseClipboardText(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const n = src.length;
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  if (n === 0) return rows;
  for (;;) {
    let field: string;
    const close = src[i] === '"' ? findClosingQuote(src, i) : -1;
    if (close >= 0) {
      field = src.slice(i + 1, close).replace(/""/g, '"');
      i = close + 1;
    } else {
      let j = i;
      while (j < n) {
        const c = src.charCodeAt(j);
        if (c === 9 || c === 10 || c === 13) break;
        j++;
      }
      field = src.slice(i, j);
      i = j;
    }
    row.push(field);
    if (i >= n) {
      rows.push(row);
      break;
    }
    const c = src[i];
    if (c === '\t') {
      i++;
      continue;
    }
    // Row break: \r\n, \n or \r.
    i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= n) break;
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

/**
 * For a field starting with a quote at `start`, returns the index of the closing quote when the
 * field is a well-formed quoted field (closing quote followed by tab, newline or end of text), else
 * -1, in which case the quote is literal text (Excel does not quote e.g. `12" pipe`).
 */
function findClosingQuote(src: string, start: number): number {
  let i = start + 1;
  for (;;) {
    const q = src.indexOf('"', i);
    if (q < 0) return -1;
    if (src[q + 1] === '"') {
      i = q + 2;
      continue;
    }
    const next = src.charCodeAt(q + 1);
    return Number.isNaN(next) || next === 9 || next === 10 || next === 13 ? q : -1;
  }
}

// --- HTML ---------------------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  minus: '−',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  micro: 'µ',
  middot: '·',
  sup2: '²',
  sup3: '³',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  copy: '©',
  reg: '®',
  trade: '™',
  sect: '§',
  para: '¶',
  shy: '\u00ad',
  zwnj: '\u200c',
  zwj: '\u200d',
  lrm: '\u200e',
  rlm: '\u200f',
};

/** Decodes HTML character references (named subset, decimal and hex). Unknown ones are kept. */
export function decodeHtmlEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});?/gi, (m, body: string) => {
    if (body[0] === '#') {
      const cp =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v !== undefined && (m.endsWith(';') || body.length <= 4) ? v : m;
  });
}

interface HtmlTag {
  name: string;
  closing: boolean;
  attrs: Record<string, string>;
  /** Index just after the tag. */
  end: number;
}

/** Reads one tag starting at `<` (index `lt`). Attribute values may be quoted or unquoted. */
function readTag(html: string, lt: number): HtmlTag | null {
  let i = lt + 1;
  const closing = html[i] === '/';
  if (closing) i++;
  const nameStart = i;
  while (i < html.length && /[A-Za-z0-9:_-]/.test(html[i])) i++;
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();
  const attrs: Record<string, string> = {};
  const n = html.length;
  for (;;) {
    while (i < n && /[\s/]/.test(html[i])) i++;
    if (i >= n) return { name, closing, attrs, end: n };
    if (html[i] === '>') return { name, closing, attrs, end: i + 1 };
    const aStart = i;
    while (i < n && !/[\s=>/]/.test(html[i])) i++;
    const aName = html.slice(aStart, i).toLowerCase();
    while (i < n && /\s/.test(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < n && /\s/.test(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const e = html.indexOf(q, i + 1);
        const end = e < 0 ? n : e;
        value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const vStart = i;
        while (i < n && !/[\s>]/.test(html[i])) i++;
        value = html.slice(vStart, i);
      }
    }
    if (aName) attrs[aName] = decodeHtmlEntities(value);
  }
}

/** Collapses HTML whitespace within each line of a cell and trims the lines. */
function finishCellText(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f]+/g, ' ').trim())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/**
 * Parses the first <table> of an HTML clipboard fragment into rows of strings, honouring colspan
 * and rowspan (merged cells become empty cells). Returns null when there is no table.
 */
export function parseHtmlTable(html: string): string[][] | null {
  const lower = html.toLowerCase();
  const tableStart = lower.indexOf('<table');
  if (tableStart < 0) return null;
  const rows: string[][] = [];
  let row: string[] | null = null;
  let cell: string[] | null = null;
  let cellAttrs: Record<string, string> = {};
  let colspanPending = 1;
  let depth = 0;
  /** Column index → remaining rows covered by a rowspan from above. */
  const rowspans = new Map<number, number>();

  const fillRowspans = () => {
    if (!row) return;
    for (;;) {
      const left = rowspans.get(row.length);
      if (left === undefined || left <= 0) break;
      row.push('');
      if (left === 1) rowspans.delete(row.length - 1);
      else rowspans.set(row.length - 1, left - 1);
    }
  };
  const endCell = () => {
    if (!row || !cell) return;
    const text = finishCellText(decodeHtmlEntities(cell.join('')).replace(/\u00a0/g, ' '));
    const num = cellAttrs['x:num'];
    // Excel's x:num holds the unrounded value; use it when the displayed text is a plain number
    // (dates and percentages keep their displayed text, like the text/plain flavour).
    const value = num && parseNumber(num) !== null && parseNumber(text) !== null ? num : text;
    fillRowspans();
    const col = row.length;
    row.push(value);
    for (let k = 1; k < colspanPending; k++) row.push('');
    const rs = Math.max(1, Math.min(10000, parseInt(cellAttrs.rowspan ?? '1', 10) || 1));
    if (rs > 1) for (let k = 0; k < colspanPending; k++) rowspans.set(col + k, rs - 1);
    cell = null;
  };
  const endRow = () => {
    if (!row) return;
    endCell();
    fillRowspans();
    rows.push(row);
    row = null;
  };

  let i = tableStart;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (cell && textEnd > i) cell.push(html.slice(i, textEnd).replace(/[\r\n]+/g, ' '));
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const e = html.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const tag = readTag(html, lt);
    if (!tag) {
      if (cell) cell.push('<');
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (tag.name === 'style' || tag.name === 'script') {
      if (!tag.closing) {
        const e = lower.indexOf(`</${tag.name}`, i);
        i = e < 0 ? n : e;
      }
      continue;
    }
    if (tag.name === 'table') {
      depth += tag.closing ? -1 : 1;
      if (depth <= 0) break;
      continue;
    }
    if (depth > 1) {
      // Nested table: keep its text in the current cell.
      if (cell && (tag.name === 'tr' || tag.name === 'br') && !tag.closing) cell.push('\n');
      if (cell && (tag.name === 'td' || tag.name === 'th') && !tag.closing) cell.push(' ');
      continue;
    }
    switch (tag.name) {
      case 'tr':
        endRow();
        if (!tag.closing) row = [];
        break;
      case 'td':
      case 'th':
        endCell();
        if (!tag.closing) {
          if (!row) row = [];
          cell = [];
          cellAttrs = tag.attrs;
          colspanPending = Math.max(1, Math.min(1000, parseInt(tag.attrs.colspan ?? '1', 10) || 1));
        }
        break;
      case 'br':
        if (cell) cell.push('\n');
        break;
      case 'p':
      case 'div':
      case 'li':
        if (cell && tag.closing) cell.push('\n');
        break;
      default:
        break;
    }
  }
  endRow();
  // Equalise widths and drop trailing empty rows.
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

/**
 * Parses a clipboard paste: the HTML table flavour when present and non-empty, else the text
 * flavour as Excel-style TSV.
 */
export function parseClipboard(text: string, html?: string): string[][] {
  if (html) {
    const fromHtml = parseHtmlTable(html);
    if (fromHtml && fromHtml.length > 0) return fromHtml;
  }
  return parseClipboardText(text);
}
