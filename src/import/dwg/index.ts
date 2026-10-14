/**
 * DWG import (FDR rows 22–25, decision D-1) — LibreDWG-free API.
 *
 * Everything exported here is safe to import from main-thread code. The reader itself,
 * `readDwg` in `./read`, runs LibreDWG (GPL-3.0, WebAssembly) and is imported only by the DWG
 * worker (`./libredwg.worker.ts`, started by `src/workers/dwg.worker.ts`), so that LibreDWG stays
 * in its own worker bundle and out of the main application bundle (row 25).
 */
export type { ReadDwgOptions } from './read';
export { MAX_DWG_BYTES, dwgTimeLimitMs } from './limits';
export {
  dwgDatabaseToStore,
  dwgLineweight,
  listDwgLayouts,
  MAX_ARRAY_CELLS,
  MAX_BLOCK_DEPTH,
  MAX_ENTITIES,
  type DwgConvertOptions,
} from './convert';
export { DwgReadError, DWG_FALLBACK_GUIDANCE, describeReaderErrors, type DwgErrorCode } from './errors';
export {
  dwgVersionInfo,
  readDwgVersionCode,
  unsupportedVersionMessage,
  NEWEST_SUPPORTED_DWG,
  type DwgVersionInfo,
} from './version';
