/**
 * DWG import errors and LibreDWG error-code descriptions (FDR rows 22, 23).
 *
 * Every failure carries a readable message that says what went wrong and what the user can do
 * (supply a DXF or PDF of the same drawing), so no DWG ends in a blank screen without explanation.
 */

/** Guidance appended to messages when a DWG cannot be read completely. */
export const DWG_FALLBACK_GUIDANCE =
  'Export the drawing from your CAD application as DXF (any version) or plot it to PDF, and import that instead.';

export type DwgErrorCode =
  /** The bytes are not a DWG file (or the file is empty). */
  | 'not-dwg'
  /** DWG format newer than AC1032 (or an unknown format code). */
  | 'unsupported-version'
  /** The file is larger than the configured limit. */
  | 'too-large'
  /** LibreDWG (WebAssembly) could not be loaded. */
  | 'reader-unavailable'
  /** LibreDWG reported a fatal error and nothing could be recovered. */
  | 'read-failed'
  /** LibreDWG crashed (WebAssembly trap) while reading or converting. */
  | 'reader-crashed'
  /** Reading took longer than the time limit and was stopped. */
  | 'timeout'
  /** The requested layout does not exist. */
  | 'layout-not-found';

/** Error thrown by the DWG importer; `message` is suitable for showing to the user. */
export class DwgReadError extends Error {
  readonly code: DwgErrorCode;
  /** DWG format code from the file header (e.g. "AC1032") when known. */
  readonly version?: string;

  constructor(code: DwgErrorCode, message: string, version?: string) {
    super(message);
    this.name = 'DwgReadError';
    this.code = code;
    this.version = version;
  }
}

/** LibreDWG `DWG_ERROR` bit flags (include/dwg.h). */
export const DWG_ERR = {
  WRONGCRC: 1,
  NOTYETSUPPORTED: 2,
  UNHANDLEDCLASS: 4,
  INVALIDTYPE: 8,
  INVALIDHANDLE: 16,
  INVALIDEED: 32,
  VALUEOUTOFBOUNDS: 64,
  CLASSESNOTFOUND: 128,
  SECTIONNOTFOUND: 256,
  PAGENOTFOUND: 512,
  INTERNALERROR: 1024,
  INVALIDDWG: 2048,
  IOERROR: 4096,
  OUTOFMEM: 8192,
} as const;

/** Errors at or above this value are "critical" in LibreDWG (the file may be incomplete). */
export const DWG_ERR_CRITICAL = DWG_ERR.CLASSESNOTFOUND;

/** Errors after which nothing usable can be expected (conversion is not attempted). */
export const DWG_ERR_FATAL = DWG_ERR.INVALIDDWG | DWG_ERR.IOERROR | DWG_ERR.OUTOFMEM;

const DESCRIPTIONS: [number, string][] = [
  [DWG_ERR.WRONGCRC, 'checksum mismatch (the file may be damaged)'],
  [DWG_ERR.NOTYETSUPPORTED, 'features the DWG reader does not support yet'],
  [DWG_ERR.UNHANDLEDCLASS, 'custom or proxy object classes the DWG reader cannot interpret'],
  [DWG_ERR.INVALIDTYPE, 'objects of an invalid type'],
  [DWG_ERR.INVALIDHANDLE, 'broken object references'],
  [DWG_ERR.INVALIDEED, 'invalid extended entity data'],
  [DWG_ERR.VALUEOUTOFBOUNDS, 'values outside the valid range'],
  [DWG_ERR.CLASSESNOTFOUND, 'a missing class section'],
  [DWG_ERR.SECTIONNOTFOUND, 'a missing section (the file may be truncated or damaged)'],
  [DWG_ERR.PAGENOTFOUND, 'a missing data page (the file may be truncated or damaged)'],
  [DWG_ERR.INTERNALERROR, 'an internal error of the DWG reader'],
  [DWG_ERR.INVALIDDWG, 'an invalid DWG structure'],
  [DWG_ERR.IOERROR, 'a read error'],
  [DWG_ERR.OUTOFMEM, 'running out of memory'],
];

/** Human-readable descriptions of the bits set in a LibreDWG error code. */
export function describeReaderErrors(code: number): string[] {
  const out: string[] = [];
  for (const [bit, text] of DESCRIPTIONS) if (code & bit) out.push(text);
  return out;
}

/** Joins descriptions as "a, b and c". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
