import Papa from 'papaparse';

import type { CellValue } from '@/core/types';

/**
 * Delimited text (CSV / TSV / semicolon / pipe) parsing for table import (row 62). Delimiter
 * detection is our own (quote-aware, consistency based, so semicolon files with decimal commas are
 * recognised); the parsing itself is Papa Parse on the main string — never its worker mode.
 */

export const DELIMITERS = [',', ';', '\t', '|'] as const;

interface LineStats {
  /** Per delimiter: number of occurrences outside quotes, per logical line. */
  counts: Map<string, number[]>;
  /** Per logical line: does it contain anything but whitespace? */
  content: boolean[];
}

/** Scans the first logical lines of `text` (quote-aware) and counts each candidate delimiter. */
function scanLines(text: string, maxLines = 30, maxChars = 65536): LineStats {
  const counts = new Map<string, number[]>(DELIMITERS.map((d) => [d, [0]]));
  const content: boolean[] = [false];
  let inQuotes = false;
  let atFieldStart = true;
  const n = Math.min(text.length, maxChars);
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (content.length >= maxLines) break;
      for (const arr of counts.values()) arr.push(0);
      content.push(false);
      atFieldStart = true;
      continue;
    }
    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      content[content.length - 1] = true;
      continue;
    }
    const arr = counts.get(ch);
    if (arr) {
      arr[arr.length - 1]++;
      atFieldStart = true;
      if (ch !== '\t') content[content.length - 1] = true;
    } else if (ch !== ' ' && ch !== '\ufeff') {
      atFieldStart = false;
      content[content.length - 1] = true;
    }
  }
  return { counts, content };
}

/**
 * Picks the delimiter whose per-line count is most consistent across non-blank lines (including
 * the header line) and non-zero. Ties prefer tab, then semicolon, comma and pipe: a file in which
 * both commas and semicolons appear consistently is a semicolon file with decimal commas.
 * Returns ',' when no candidate occurs (single-column file).
 */
export function detectDelimiter(text: string): string {
  const { counts, content } = scanLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  let best = ',';
  let bestScore = -1;
  for (const d of ['\t', ';', ',', '|']) {
    const perLine = counts.get(d)!.filter((_, i) => content[i]);
    if (perLine.length === 0) continue;
    const freq = new Map<number, number>();
    for (const c of perLine) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    if (freq.size === 0) continue;
    let mode = 0;
    let modeCount = 0;
    for (const [c, f] of freq) {
      if (f > modeCount || (f === modeCount && c > mode)) {
        mode = c;
        modeCount = f;
      }
    }
    const consistent = perLine.filter((c) => c === mode).length / perLine.length;
    const present = perLine.filter((c) => c > 0).length / perLine.length;
    const headerOk = perLine[0] > 0 ? 1 : 0;
    const score = consistent * 100 + present * 10 + headerOk * 5;
    if (score > bestScore + 1e-9) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Parses delimited text into rows of strings. Handles quoted fields with embedded delimiters,
 * newlines and doubled quotes, CRLF/LF/CR line endings, a leading BOM and Excel's `sep=;` hint
 * line. Trailing blank lines are dropped; ragged rows are returned as-is (the table builder pads
 * them).
 */
export function parseDelimited(text: string, opts: { delimiter?: string } = {}): string[][] {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let hinted: string | undefined;
  const sep = /^sep=(.)[ \t]*(\r\n|\n|\r)/i.exec(src);
  if (sep) {
    hinted = sep[1];
    src = src.slice(sep[0].length);
  }
  if (src.trim() === '') return [];
  const delimiter = opts.delimiter ?? hinted ?? detectDelimiter(src);
  const result = Papa.parse<string[]>(src, {
    delimiter,
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    quoteChar: '"',
    escapeChar: '"',
    worker: false,
  });
  const rows = result.data;
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

export interface FormatDelimitedOptions {
  /** Default ','. */
  delimiter?: string;
  /** Prefix a UTF-8 BOM so Excel reads non-ASCII text (e.g. Arabic) correctly. Default true. */
  bom?: boolean;
  /** Default '\r\n' (RFC 4180, what Excel writes). */
  newline?: string;
  /**
   * Prefix text cells that a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, CR at
   * the start) with an apostrophe (CSV injection). Numbers are never altered. Default true.
   */
  escapeFormulas?: boolean;
}

/** Writes a table as CSV/TSV text (tabular export, row 80). */
export function formatDelimited(
  columns: string[],
  rows: CellValue[][],
  opts: FormatDelimitedOptions = {},
): string {
  const d = opts.delimiter ?? ',';
  const nl = opts.newline ?? '\r\n';
  const escapeFormulas = opts.escapeFormulas ?? true;
  const field = (v: CellValue | undefined, isHeader: boolean): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    let s = v;
    if (!isHeader && escapeFormulas && /^[=+\-@\t\r]/.test(s) && s !== '-') s = `'${s}`;
    return s.includes(d) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => field(c, true)).join(d)];
  for (const row of rows) lines.push(row.map((v) => field(v, false)).join(d));
  return (opts.bom === false ? '' : '\ufeff') + lines.join(nl) + nl;
}
