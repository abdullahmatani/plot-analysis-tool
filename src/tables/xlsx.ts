import { unzipSync, zipSync, type Unzipped } from 'fflate';

import type { CellValue } from '@/core/types';

import { decodeText } from './decode';
import { escapeXmlAttr, escapeXmlText, scanXml } from './xml';
import { wellFormed } from './values';

/**
 * Minimal OOXML (XLSX) reader and writer on fflate (decision D-5: no SheetJS/ExcelJS). Worker-safe:
 * no DOMParser, no eval. The reader covers what consequence-result tables use: sheet names and
 * order via relationships, shared strings (incl. rich text runs, without phonetic runs), inline
 * strings, numbers, booleans ('TRUE'/'FALSE'), errors (as their text, e.g. '#DIV/0!'), cached
 * formula results, dates (via number formats, returned as ISO strings) and sparse rows/cells.
 * Formatting, merged cells, comments and charts are ignored.
 */

export interface XlsxSheetInfo {
  name: string;
  hidden: boolean;
  /** Zip path of the worksheet part. */
  path: string;
}

export interface XlsxWorkbook {
  sheets: XlsxSheetInfo[];
  date1904: boolean;
  /** Parses one worksheet (by index into `sheets`) into rows of cell values. */
  readSheet(index: number): CellValue[][];
}

export interface XlsxReadSheet {
  name: string;
  rows: CellValue[][];
  hidden?: boolean;
}

const REL_OFFICE_DOC = '/officeDocument';
const REL_WORKSHEET = '/worksheet';
const REL_SHARED_STRINGS = '/sharedStrings';
const REL_STYLES = '/styles';

/** Upper bound on the declared uncompressed size of the parts we read (zip-bomb guard). */
const MAX_PART_BYTES = 512 * 1024 * 1024;

/** Excel limits. */
export const XLSX_MAX_ROWS = 1048576;
export const XLSX_MAX_COLS = 16384;
const XLSX_MAX_CELL_CHARS = 32767;

// --- helpers --------------------------------------------------------------------------------------

/** Decodes OOXML `_xHHHH_` escapes (used for control characters, e.g. `_x000D_`). */
export function decodeOoxmlEscapes(s: string): string {
  return s.indexOf('_x') < 0
    ? s
    : s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Zero-based column index from a cell reference or column letters ("AB12" → 27). */
export function columnIndex(ref: string): number {
  let col = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i) | 0x20; // lower-case
    if (c < 97 || c > 122) break;
    col = col * 26 + (c - 96);
  }
  return i === 0 ? -1 : col - 1;
}

/** Zero-based row index from a cell reference ("AB12" → 11), or -1. */
function rowIndexFromRef(ref: string): number {
  const m = /\d+$/.exec(ref);
  return m ? parseInt(m[0], 10) - 1 : -1;
}

/** Column letters for a zero-based index (0 → "A", 27 → "AB"). */
export function columnLetters(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (baseDir + target).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

function relsPathFor(partPath: string): string {
  return `${dirOf(partPath)}_rels/${partPath.slice(dirOf(partPath).length)}.rels`;
}

interface Rel {
  id: string;
  type: string;
  target: string;
}

function parseRels(xml: string | null, partPath: string): Rel[] {
  if (!xml) return [];
  // Targets are relative to the directory of the part the .rels file describes.
  const base = dirOf(partPath).replace(/_rels\/$/, '');
  const rels: Rel[] = [];
  scanXml(xml, {
    open(name, a) {
      if (name !== 'Relationship' || a.TargetMode === 'External' || !a.Target) return;
      rels.push({ id: a.Id ?? '', type: a.Type ?? '', target: resolvePath(base, a.Target) });
    },
  });
  return rels;
}

// --- number formats and dates --------------------------------------------------------------------

type DateKind = 'date' | 'datetime' | 'time';

const BUILTIN_DATE_FORMATS: Record<number, DateKind> = {
  14: 'date',
  15: 'date',
  16: 'date',
  17: 'date',
  18: 'time',
  19: 'time',
  20: 'time',
  21: 'time',
  22: 'datetime',
  45: 'time',
  46: 'time',
  47: 'time',
};
// East Asian built-in date formats (ECMA-376 §18.8.30).
for (let id = 27; id <= 36; id++) BUILTIN_DATE_FORMATS[id] = 'date';
for (let id = 50; id <= 58; id++) BUILTIN_DATE_FORMATS[id] = 'date';

/** Classifies a number format code as a date/time format (first section only). */
export function dateKindOfFormat(code: string): DateKind | null {
  // First section, honouring quotes.
  let section = '';
  let inQuote = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ';' && !inQuote) break;
    else if (c === '\\' && !inQuote) {
      section += c + (code[i + 1] ?? '');
      i++;
      continue;
    }
    section += c;
  }
  let s = section
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[(h+|m+|s+)\]/gi, (_, x: string) => x)
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase()
    .replace(/general/g, '')
    .replace(/am\/pm|a\/p/g, 'h');
  s = s.replace(/s+\.0+/g, 's');
  if (/[0#?@]/.test(s)) return null;
  const hasTime = /[hs]/.test(s);
  const hasDate = /[dy]/.test(s) || (/m/.test(s) && !hasTime) || /[eg]/.test(s);
  if (!hasDate && !hasTime) return null;
  return hasDate && hasTime ? 'datetime' : hasDate ? 'date' : 'time';
}

const pad2 = (n: number) => (n < 10 ? '0' : '') + n;

/**
 * Excel serial date → ISO string: 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM:SS' or 'HH:MM:SS' (time-only
 * formats; elapsed hours may exceed 24). Returns null when outside Excel's date range.
 */
export function serialToIso(v: number, date1904: boolean, kind: DateKind): string | null {
  if (!Number.isFinite(v) || v < 0 || v > 2958465.99999) return null;
  let days = Math.floor(v);
  let secs = Math.round((v - days) * 86400);
  if (secs >= 86400) {
    days++;
    secs -= 86400;
  }
  const hh = Math.floor(secs / 3600);
  const time = `${pad2(hh)}:${pad2(Math.floor((secs % 3600) / 60))}:${pad2(secs % 60)}`;
  if (kind === 'time') return days > 0 ? `${pad2(days * 24 + hh)}${time.slice(2)}` : time;
  // 1900 system: serial 1 = 1900-01-01 and Excel's fictitious 1900-02-29 is serial 60.
  const ms = date1904
    ? Date.UTC(1904, 0, 1) + days * 86400000
    : Date.UTC(1899, 11, 30) + (days < 60 ? days + 1 : days) * 86400000;
  const date = new Date(ms).toISOString().slice(0, 10);
  return kind === 'date' ? date : `${date}T${time}`;
}

interface Styles {
  /** cellXfs index → date kind (null = not a date). */
  xfDateKind: (DateKind | null)[];
}

function parseStyles(xml: string | null): Styles {
  if (!xml) return { xfDateKind: [] };
  const custom = new Map<number, string>();
  const xfFmt: number[] = [];
  let inCellXfs = false;
  scanXml(xml, {
    open(name, a, selfClosing) {
      if (name === 'numFmt' && a.numFmtId !== undefined)
        custom.set(parseInt(a.numFmtId, 10), a.formatCode ?? '');
      else if (name === 'cellXfs' && !selfClosing) inCellXfs = true;
      else if (name === 'xf' && inCellXfs) xfFmt.push(parseInt(a.numFmtId ?? '0', 10) || 0);
    },
    close(name) {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });
  return {
    xfDateKind: xfFmt.map((id) => {
      const code = custom.get(id);
      return code !== undefined ? dateKindOfFormat(code) : (BUILTIN_DATE_FORMATS[id] ?? null);
    }),
  };
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  let inSi = false;
  let inT = false;
  let phonetic = 0;
  let parts = '';
  scanXml(xml, {
    open(name) {
      if (name === 'si') {
        inSi = true;
        parts = '';
      } else if (name === 't') inT = inSi && phonetic === 0;
      else if (name === 'rPh') phonetic++;
    },
    close(name) {
      if (name === 't') inT = false;
      else if (name === 'rPh') phonetic--;
      else if (name === 'si') {
        out.push(decodeOoxmlEscapes(parts));
        inSi = false;
      }
    },
    text(t) {
      if (inT) parts += t;
    },
  });
  return out;
}

function parseWorksheet(xml: string, shared: string[], styles: Styles, date1904: boolean): CellValue[][] {
  const rows: CellValue[][] = [];
  let inSheetData = false;
  let rowIdx = -1;
  let colIdx = -1;
  let type = 'n';
  let style = 0;
  let hasV = false;
  let inV = false;
  let inIs = false;
  let inT = false;
  let phonetic = 0;
  let vText = '';
  let isText = '';

  const value = (): CellValue => {
    switch (type) {
      case 's': {
        const s = shared[parseInt(vText, 10)];
        return s === undefined ? null : s;
      }
      case 'inlineStr':
        return decodeOoxmlEscapes(isText || vText);
      case 'str':
        return hasV ? decodeOoxmlEscapes(vText) : null;
      case 'b': {
        if (!hasV) return null;
        const t = vText.trim().toLowerCase();
        return t === '1' || t === 'true' ? 'TRUE' : 'FALSE';
      }
      case 'e':
      case 'd':
        return vText.trim() || null;
      default: {
        const t = vText.trim();
        if (!hasV || t === '') return null;
        const num = Number(t);
        if (!Number.isFinite(num)) return t;
        const kind = styles.xfDateKind[style];
        if (kind) return serialToIso(num, date1904, kind) ?? num;
        return num;
      }
    }
  };

  scanXml(xml, {
    open(name, a) {
      if (!inSheetData) {
        if (name === 'sheetData') inSheetData = true;
        return;
      }
      switch (name) {
        case 'row':
          rowIdx = a.r ? parseInt(a.r, 10) - 1 : rowIdx + 1;
          colIdx = -1;
          break;
        case 'c': {
          const ref = a.r;
          if (ref) {
            const c = columnIndex(ref);
            colIdx = c >= 0 ? c : colIdx + 1;
            const r = rowIndexFromRef(ref);
            if (r >= 0) rowIdx = r;
          } else {
            colIdx++;
          }
          type = a.t ?? 'n';
          style = a.s ? parseInt(a.s, 10) || 0 : 0;
          hasV = false;
          vText = '';
          isText = '';
          break;
        }
        case 'v':
          inV = true;
          hasV = true;
          break;
        case 'is':
          inIs = true;
          break;
        case 't':
          inT = inIs && phonetic === 0;
          break;
        case 'rPh':
          phonetic++;
          break;
      }
    },
    close(name) {
      if (!inSheetData) return;
      switch (name) {
        case 'sheetData':
          inSheetData = false;
          break;
        case 'v':
          inV = false;
          break;
        case 'is':
          inIs = false;
          break;
        case 't':
          inT = false;
          break;
        case 'rPh':
          phonetic--;
          break;
        case 'c': {
          const v = value();
          if (
            v === null ||
            v === '' ||
            rowIdx < 0 ||
            colIdx < 0 ||
            rowIdx >= XLSX_MAX_ROWS ||
            colIdx >= XLSX_MAX_COLS
          )
            break;
          let row = rows[rowIdx];
          if (!row) row = rows[rowIdx] = [];
          while (row.length < colIdx) row.push(null);
          row[colIdx] = v;
          break;
        }
      }
    },
    text(t) {
      if (inV) vText += t;
      else if (inT) isText += t;
    },
  });
  // Fill sparse gaps.
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

// --- reader ----------------------------------------------------------------------------------------

/** Opens an XLSX workbook: lists sheets and parses worksheets on demand. Throws on invalid input. */
export function openXlsx(bytes: Uint8Array): XlsxWorkbook {
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new Error('Legacy .xls (Excel 97–2003) files are not supported; save the file as .xlsx or CSV.');
  }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('Not an XLSX file (not a ZIP archive).');
  }
  let files: Unzipped;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!/\.(xml|rels)$/i.test(f.name) || /^xl\/(media|embeddings|printerSettings)\//i.test(f.name))
          return false;
        if (f.originalSize > MAX_PART_BYTES) throw new Error(`XLSX part ${f.name} is too large.`);
        return true;
      },
    });
  } catch (e) {
    throw new Error(`Cannot read XLSX file: ${(e as Error).message}`);
  }
  const byLower = new Map<string, string>();
  for (const k of Object.keys(files)) byLower.set(k.toLowerCase(), k);
  const read = (path: string): string | null => {
    const key = files[path] ? path : byLower.get(path.toLowerCase());
    return key ? decodeText(files[key]) : null;
  };

  const rootRels = parseRels(read('_rels/.rels'), '_rels/.rels');
  const workbookPath = rootRels.find((r) => r.type.endsWith(REL_OFFICE_DOC))?.target ?? 'xl/workbook.xml';
  const workbookXml = read(workbookPath);
  if (!workbookXml) throw new Error('Not an XLSX file (no workbook part).');
  const wbRels = parseRels(read(relsPathFor(workbookPath)), relsPathFor(workbookPath));
  const relById = new Map(wbRels.map((r) => [r.id, r]));

  let date1904 = false;
  const sheets: XlsxSheetInfo[] = [];
  scanXml(workbookXml, {
    open(name, a) {
      if (name === 'workbookPr') date1904 = a.date1904 === '1' || a.date1904 === 'true';
      else if (name === 'sheet') {
        const rel = relById.get(a['r:id'] ?? a.id ?? '');
        // Chart sheets, dialog and macro sheets have no cell data.
        if (!rel || !rel.type.endsWith(REL_WORKSHEET)) return;
        sheets.push({
          name: a.name ?? `Sheet${sheets.length + 1}`,
          hidden: a.state === 'hidden' || a.state === 'veryHidden',
          path: rel.target,
        });
      }
    },
  });
  // Files without workbook relationships: fall back to the conventional paths.
  if (sheets.length === 0 && wbRels.length === 0) {
    for (let i = 1; read(`xl/worksheets/sheet${i}.xml`) !== null; i++) {
      sheets.push({ name: `Sheet${i}`, hidden: false, path: `xl/worksheets/sheet${i}.xml` });
    }
  }

  let shared: string[] | null = null;
  let styles: Styles | null = null;
  const sharedPath =
    wbRels.find((r) => r.type.endsWith(REL_SHARED_STRINGS))?.target ?? 'xl/sharedStrings.xml';
  const stylesPath = wbRels.find((r) => r.type.endsWith(REL_STYLES))?.target ?? 'xl/styles.xml';

  return {
    sheets,
    date1904,
    readSheet(index: number): CellValue[][] {
      const info = sheets[index];
      if (!info) throw new Error(`No sheet at index ${index}.`);
      shared ??= parseSharedStrings(read(sharedPath));
      styles ??= parseStyles(read(stylesPath));
      const xml = read(info.path);
      if (xml === null) throw new Error(`Worksheet part ${info.path} is missing.`);
      return parseWorksheet(xml, shared, styles, date1904);
    },
  };
}

/** Reads every worksheet of an XLSX file. */
export function readXlsx(bytes: Uint8Array): { sheets: XlsxReadSheet[] } {
  const wb = openXlsx(bytes);
  return {
    sheets: wb.sheets.map((s, i) => ({
      name: s.name,
      rows: wb.readSheet(i),
      ...(s.hidden ? { hidden: true } : {}),
    })),
  };
}

// --- writer ----------------------------------------------------------------------------------------

export interface XlsxWriteSheet {
  name: string;
  columns: string[];
  rows: CellValue[][];
  /** Column widths in characters (Excel width units); estimated from content when omitted. */
  columnWidths?: number[];
}

export interface XlsxWriteOptions {
  creator?: string;
  title?: string;
  /** Created/modified timestamp (also the zip entry time). Default: now. */
  date?: Date;
}

const RESERVED_SHEET_NAMES = new Set(['history']);

/** Makes one sheet name valid for Excel: ≤ 31 characters, none of []:*?/\, no leading/trailing '. */
export function sanitizeSheetName(name: string): string {
  let s = wellFormed(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[[\]:*?/\\\u0000-\u001f]/g, '_')
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim();
  if (!s) s = 'Sheet';
  if (RESERVED_SHEET_NAMES.has(s.toLowerCase())) s += '_';
  return truncateUnits(s, 31);
}

function truncateUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

/** Sanitises sheet names and makes them unique (case-insensitive, as Excel requires). */
export function sanitizeSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = sanitizeSheetName(raw);
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) {
      const suffix = ` (${k})`;
      name = truncateUnits(base, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/** Cell text for XML: well-formed, LF line ends, OOXML-escaped control characters, ≤ 32 767 chars. */
function cellXmlText(value: string): string {
  let s = wellFormed(value).replace(/\r\n?/g, '\n');
  if (s.length > XLSX_MAX_CELL_CHARS) s = truncateUnits(s, XLSX_MAX_CELL_CHARS);
  s = s.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1');
  s = s.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,
    (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`,
  );
  return escapeXmlText(s);
}

function inlineStringCell(ref: string, text: string, style: number): string {
  const t = cellXmlText(text);
  const preserve = /^\s|\s$|\n|\t/.test(t) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t${preserve}>${t}</t></is></c>`;
}

function estimateWidths(sheet: XlsxWriteSheet, nCols: number): number[] {
  const widths: number[] = [];
  const sample = Math.min(sheet.rows.length, 2000);
  for (let c = 0; c < nCols; c++) {
    let w = (sheet.columns[c] ?? '').length * 1.15 + 2;
    for (let r = 0; r < sample; r++) {
      const v = sheet.rows[r]?.[c];
      if (v === null || v === undefined) continue;
      const text = typeof v === 'number' ? String(v) : v;
      for (const line of text.split('\n')) w = Math.max(w, line.length + 2);
    }
    widths.push(Math.min(80, Math.max(8, Math.ceil(w))));
  }
  return widths;
}

function worksheetXml(sheet: XlsxWriteSheet, selected: boolean): string {
  const nRows = sheet.rows.length;
  if (nRows + 1 > XLSX_MAX_ROWS) throw new Error(`Sheet "${sheet.name}" has too many rows for XLSX.`);
  let nCols = sheet.columns.length;
  for (const row of sheet.rows) if (row.length > nCols) nCols = row.length;
  if (nCols > XLSX_MAX_COLS) throw new Error(`Sheet "${sheet.name}" has too many columns for XLSX.`);
  const letters: string[] = [];
  for (let c = 0; c < nCols; c++) letters.push(columnLetters(c));
  const hasHeader = sheet.columns.length > 0;

  const out: string[] = [];
  out.push(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<dimension ref="${nCols > 0 ? `A1:${letters[nCols - 1]}${nRows + 1}` : 'A1'}"/>`,
    '<sheetViews>',
    `<sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0">`,
  );
  if (hasHeader && nRows > 0) {
    out.push(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>',
    );
  }
  out.push('</sheetView></sheetViews>', '<sheetFormatPr defaultRowHeight="15"/>');
  if (nCols > 0) {
    const given = sheet.columnWidths;
    const widths = given && given.length >= nCols ? given : estimateWidths(sheet, nCols);
    out.push('<cols>');
    for (let c = 0; c < nCols; c++) {
      const w = Math.min(255, Math.max(0.5, Number.isFinite(widths[c]) ? widths[c] : 10));
      out.push(`<col min="${c + 1}" max="${c + 1}" width="${Math.round(w * 100) / 100}" customWidth="1"/>`);
    }
    out.push('</cols>');
  }
  out.push('<sheetData>');
  if (hasHeader) {
    out.push('<row r="1">');
    for (let c = 0; c < sheet.columns.length; c++)
      out.push(inlineStringCell(`${letters[c]}1`, sheet.columns[c] ?? '', 1));
    out.push('</row>');
  }
  const first = hasHeader ? 2 : 1;
  for (let r = 0; r < nRows; r++) {
    const row = sheet.rows[r] ?? [];
    const rn = r + first;
    out.push(`<row r="${rn}">`);
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      const ref = letters[c] + rn;
      if (typeof v === 'number') {
        if (Number.isFinite(v)) out.push(`<c r="${ref}"><v>${Object.is(v, -0) ? 0 : v}</v></c>`);
      } else if (v !== '') {
        out.push(inlineStringCell(ref, v, 0));
      }
    }
    out.push('</row>');
  }
  out.push('</sheetData>', '</worksheet>');
  return out.join('');
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const STYLES_XML =
  XML_HEAD +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2">' +
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '</fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '<dxfs count="0"/>' +
  '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
  '</styleSheet>';

/**
 * Writes a workbook Excel opens without repair: one worksheet per entry with a bold, frozen header
 * row, numbers as numbers, text as inline strings (UTF-8, any script) and sanitised unique sheet
 * names. Non-finite numbers and nulls are written as empty cells.
 */
export function writeXlsx(sheetsIn: XlsxWriteSheet[], opts: XlsxWriteOptions = {}): Uint8Array {
  const sheets = sheetsIn.length > 0 ? sheetsIn : [{ name: 'Sheet1', columns: [], rows: [] }];
  const names = sanitizeSheetNames(sheets.map((s) => s.name));
  const date = opts.date ?? new Date();
  const iso = new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const creator = escapeXmlText(wellFormed(opts.creator ?? 'Plot Analysis Tool'));
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, xml: string) => {
    files[path] = enc.encode(xml);
  };

  put(
    '[Content_Types].xml',
    XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      names
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>',
  );
  put(
    '_rels/.rels',
    XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>',
  );
  put(
    'docProps/app.xml',
    XML_HEAD +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>Plot Analysis Tool</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
      '<HeadingPairs><vt:vector size="2" baseType="variant">' +
      `<vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${names.length}</vt:i4></vt:variant>` +
      '</vt:vector></HeadingPairs>' +
      `<TitlesOfParts><vt:vector size="${names.length}" baseType="lpstr">` +
      names.map((n) => `<vt:lpstr>${escapeXmlText(n)}</vt:lpstr>`).join('') +
      '</vt:vector></TitlesOfParts>' +
      '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>' +
      '</Properties>',
  );
  put(
    'docProps/core.xml',
    XML_HEAD +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      (opts.title ? `<dc:title>${escapeXmlText(wellFormed(opts.title))}</dc:title>` : '') +
      `<dc:creator>${creator}</dc:creator><cp:lastModifiedBy>${creator}</cp:lastModifiedBy>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
      '</cp:coreProperties>',
  );
  put(
    'xl/workbook.xml',
    XML_HEAD +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<workbookPr/>' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000" activeTab="0"/></bookViews>' +
      '<sheets>' +
      names
        .map((n, i) => `<sheet name="${escapeXmlAttr(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('') +
      '</sheets>' +
      '</workbook>',
  );
  put(
    'xl/_rels/workbook.xml.rels',
    XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      names
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  put('xl/styles.xml', STYLES_XML);
  sheets.forEach((s, i) =>
    put(`xl/worksheets/sheet${i + 1}.xml`, worksheetXml({ ...s, name: names[i] }, i === 0)),
  );

  // DOS timestamps only cover 1980–2099.
  const year = date.getFullYear();
  const mtime = year < 1980 ? new Date(1980, 0, 1) : year > 2099 ? new Date(2099, 11, 31) : date;
  return zipSync(files, { level: 6, mtime });
}
