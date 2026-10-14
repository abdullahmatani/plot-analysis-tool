import type { DwgDatabase, LibreDwgEx } from '@mlightcad/libredwg-web';

import type { DrawingParseResult } from '@/underlay/entity-store';

import { dwgDatabaseToStore } from './convert';
import {
  DWG_ERR,
  DWG_ERR_CRITICAL,
  DWG_ERR_FATAL,
  DWG_FALLBACK_GUIDANCE,
  DwgReadError,
  describeReaderErrors,
  joinList,
} from './errors';
import { discardLibreDwg, loadLibreDwg } from './libredwg';
import { MAX_DWG_BYTES } from './limits';
import { applyRawSupplement, scanRawObjects, type RawSupplement } from './raw';
import { dwgVersionInfo, readDwgVersionCode, unsupportedVersionMessage } from './version';

/**
 * DWG import (FDR rows 22, 23): bytes → LibreDWG (WebAssembly) → DwgDatabase → EntityStore.
 *
 * Failure handling:
 * - not a DWG / newer than AC1032 / larger than `maxBytes` → DwgReadError before LibreDWG runs;
 * - LibreDWG errors are mapped to readable text; when the reader reports problems but entities could
 *   still be read, the partial result is returned with the problems in `report.errors` (plus the
 *   DXF/PDF guidance); when nothing could be read, a DwgReadError is thrown;
 * - a WebAssembly trap ("memory access out of bounds", "unreachable") becomes a DwgReadError and the
 *   cached LibreDWG instance is discarded, because it is unusable afterwards.
 * LibreDWG runs synchronously; the time limit is enforced by the DWG worker, which runs this code in
 * a child worker it can terminate (see `src/workers/dwg.worker.ts`).
 */

export interface ReadDwgOptions {
  /** Layout name; default (undefined or "Model") reads model space. */
  layout?: string;
  onProgress?: (fraction: number, message?: string) => void;
  /** Size limit in bytes (default {@link MAX_DWG_BYTES}). */
  maxBytes?: number;
  /** LibreDWG instance to use instead of the cached per-worker instance (tests). */
  libredwg?: LibreDwgEx;
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1);

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}

/** True when an error comes from a Content-Security-Policy that blocks code generation. */
function isCspBlock(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /EvalError|unsafe-eval|Content Security Policy/i.test(m);
}

let fileCounter = 0;

/**
 * Reads a DWG file into the flattened entity store.
 *
 * @throws DwgReadError with a user-facing message (see {@link DwgReadError.code}).
 */
export async function readDwg(
  input: Uint8Array | ArrayBuffer,
  opts: ReadDwgOptions = {},
): Promise<DrawingParseResult> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const progress = (f: number, message?: string) => opts.onProgress?.(Math.min(1, Math.max(0, f)), message);

  if (bytes.length === 0) throw new DwgReadError('not-dwg', 'The file is empty.');
  const code = readDwgVersionCode(bytes);
  if (!code) {
    throw new DwgReadError(
      'not-dwg',
      'Not a DWG file: it does not start with an AutoCAD format code such as "AC1032".',
    );
  }
  const info = dwgVersionInfo(code);
  if (info.status === 'newer' || info.status === 'unknown') {
    throw new DwgReadError('unsupported-version', unsupportedVersionMessage(info), code);
  }
  const maxBytes = opts.maxBytes ?? MAX_DWG_BYTES;
  if (bytes.length > maxBytes) {
    throw new DwgReadError(
      'too-large',
      `This DWG is ${mb(bytes.length)} MB, more than the ${mb(maxBytes)} MB the in-browser DWG reader can handle. ${DWG_FALLBACK_GUIDANCE}`,
      code,
    );
  }

  progress(0.02, 'Loading DWG reader…');
  let lib: LibreDwgEx;
  try {
    lib = opts.libredwg ?? (await loadLibreDwg());
  } catch (e) {
    throw new DwgReadError(
      'reader-unavailable',
      isCspBlock(e)
        ? `The DWG reader could not start because this page's security policy (Content-Security-Policy) blocks the code generation it needs. ${DWG_FALLBACK_GUIDANCE}`
        : `The DWG reader could not be started (${errText(e)}). ${DWG_FALLBACK_GUIDANCE}`,
      code,
    );
  }
  const owned = !opts.libredwg;
  const crashed = (e: unknown, phase: string): DwgReadError => {
    if (owned) discardLibreDwg();
    return new DwgReadError(
      'reader-crashed',
      `The DWG reader stopped while ${phase} this ${info.label} file (${errText(e)}). The file may be damaged or use features the reader cannot handle. ${DWG_FALLBACK_GUIDANCE}`,
      code,
    );
  };

  progress(0.08, `Reading DWG (${info.label})…`);
  const path = `/dwg-${++fileCounter}.dwg`;
  let data = 0;
  let err = 0;
  try {
    lib.FS.writeFile(path, bytes);
    const r = lib.dwg_read_file(path) as { error?: number; data?: number } | undefined;
    err = Number(r?.error) || 0;
    data = Number(r?.data) || 0;
  } catch (e) {
    throw crashed(e, 'reading');
  } finally {
    try {
      if (lib.FS.analyzePath(path, false).exists) lib.FS.unlink(path);
    } catch {
      // the instance may be unusable after a crash; it is discarded then
    }
  }

  const problems = describeReaderErrors(err);
  if (err & DWG_ERR.OUTOFMEM) {
    try {
      if (data) lib.dwg_abandon(data);
    } catch {
      // ignore
    }
    if (owned) discardLibreDwg();
    throw new DwgReadError(
      'read-failed',
      `The DWG reader ran out of memory on this ${mb(bytes.length)} MB file. ${DWG_FALLBACK_GUIDANCE}`,
      code,
    );
  }
  if (!data || err & DWG_ERR_FATAL) {
    try {
      if (data) lib.dwg_free(data);
    } catch {
      // ignore
    }
    throw new DwgReadError(
      'read-failed',
      `The file could not be read as a ${info.label} DWG: the reader reported ${joinList(problems) || 'an invalid file'}. ${DWG_FALLBACK_GUIDANCE}`,
      code,
    );
  }

  progress(0.4, 'Converting DWG…');
  let db: DwgDatabase;
  let sup: RawSupplement | null = null;
  try {
    db = lib.convert(data);
  } catch (e) {
    throw crashed(e, 'converting');
  }
  const notes: string[] = [];
  try {
    sup = scanRawObjects(lib, data, db);
  } catch (e) {
    // Not essential: entity linetypes BYBLOCK/CONTINUOUS and dropped-type counts are then missing.
    if (owned && e instanceof WebAssembly.RuntimeError) discardLibreDwg();
    notes.push(
      `Some DWG details (BYBLOCK linetypes, block arrays, unsupported object counts) could not be read: ${errText(e)}.`,
    );
  }
  try {
    lib.dwg_free(data);
  } catch {
    if (owned) discardLibreDwg();
  }
  if (sup) applyRawSupplement(db, sup);

  progress(0.55, 'Building drawing…');
  const result = dwgDatabaseToStore(db, {
    layout: opts.layout,
    version: code,
    onProgress: (f) => progress(0.55 + 0.45 * f, 'Building drawing…'),
  });
  const report = result.report;
  report.warnings.push(...notes);
  if (sup?.minsertFailures) {
    report.warnings.push(
      `${sup.minsertFailures} block array${sup.minsertFailures === 1 ? '' : 's'} (MINSERT) could not be read and ${sup.minsertFailures === 1 ? 'is' : 'are'} missing.`,
    );
  }
  if (sup?.customClasses.size) {
    const list = [...sup.customClasses].map(([name, n]) => `${name} ×${n}`).join(', ');
    report.warnings.push(
      `Custom objects of other applications (${list}) cannot be displayed. If they matter, ask for a DXF or PDF exported from the application that created them.`,
    );
  }
  if (info.status === 'legacy') {
    report.warnings.unshift(
      `${info.label} (${code}) is an old or pre-release DWG format with limited support in the DWG reader. Compare the result with the original, or supply a DXF or PDF of the drawing.`,
    );
  }
  if (err) {
    const what = joinList(problems);
    // Nothing at all was recovered (an empty paper layout of a readable drawing is not a failure).
    const recovered = (db.tables?.BLOCK_RECORD?.entries ?? []).reduce(
      (n, r) => n + (r.entities?.length ?? 0),
      0,
    );
    if (result.store.count === 0 && recovered === 0) {
      throw new DwgReadError(
        'read-failed',
        `No drawing content could be read from this ${info.label} DWG: the reader reported ${what}. ${DWG_FALLBACK_GUIDANCE}`,
        code,
      );
    }
    report.errors.push(
      err >= DWG_ERR_CRITICAL
        ? `The DWG reader reported ${what}; the drawing is probably incomplete. What could be read is shown — if parts are missing, export the drawing as DXF or PDF from your CAD application and import that instead.`
        : `The DWG reader reported ${what}. Everything it could read is shown — if something is missing or wrong, export the drawing as DXF or PDF from your CAD application and import that instead.`,
    );
  }
  progress(1, 'Building drawing…');
  return result;
}
