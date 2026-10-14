/** Size and time limits of the DWG reader (no LibreDWG dependency, usable by the orchestrating worker). */

/** Default size limit: larger files exceed what LibreDWG can hold in 32-bit WebAssembly memory. */
export const MAX_DWG_BYTES = 200 * 1024 * 1024;

/**
 * Time after which a DWG read is stopped (row 23: no DWG may hang the import): 60 s plus 15 s per
 * MB, at most 10 minutes. Typical files read in well under a second per MB (NFR-3: 10 MB ≤ 15 s), so
 * this only triggers when LibreDWG loops on a damaged file.
 */
export function dwgTimeLimitMs(byteLength: number): number {
  return Math.round(Math.min(10 * 60_000, 60_000 + (byteLength / (1024 * 1024)) * 15_000));
}
