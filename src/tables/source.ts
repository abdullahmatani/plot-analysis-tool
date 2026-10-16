import { importTable, type ImportInput, type ImportKind, type ImportResult } from './table';

/**
 * A table to import (row 62) and its parse options. Pure and DOM-free: the import dialog parses it
 * in a Web Worker (`src/workers/table.worker.ts`, row 21) so a large table never blocks the UI.
 */

/** A table source held by the import dialog (bytes for files, text/html for pasted ranges). */
export interface TableSource {
  kind: ImportKind;
  name: string;
  bytes?: Uint8Array;
  text?: string;
  html?: string;
}

export interface ParseOptions {
  sheet?: string;
  headerRow?: number;
  delimiter?: string;
}

/** Raw rows offered as header-row choices in the import dialog. */
export const HEADER_CHOICES = 30;

/** Parses a source into a table (throws a readable error on bad input). */
export function parseSource(src: TableSource, opts: ParseOptions = {}): ImportResult {
  const input: ImportInput = { kind: src.kind };
  if (src.bytes) input.bytes = src.bytes;
  if (src.text !== undefined) input.text = src.text;
  if (src.html !== undefined) input.html = src.html;
  if (opts.sheet !== undefined) input.sheet = opts.sheet;
  if (opts.headerRow !== undefined) input.headerRow = opts.headerRow;
  if (opts.delimiter !== undefined) input.delimiter = opts.delimiter;
  return importTable(input);
}

/**
 * What the import dialog needs from a parse: the whole table, but only the raw rows it offers as
 * header choices (another header row is applied by parsing again). Keeps the copy back from the
 * worker, which is made on the main thread, as small as possible.
 */
export function forImportDialog(r: ImportResult): ImportResult {
  return { ...r, raw: r.raw.slice(0, HEADER_CHOICES) };
}
