import { LibreDwg, createModule, type LibreDwgEx } from '@mlightcad/libredwg-web';
// The package's "exports" map does not expose the .wasm file, so it is referenced by path. Vite emits
// it as a same-origin asset (precached by the service worker); it is never fetched from a CDN.
import wasmUrl from '../../../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url';

/**
 * Loads LibreDWG (GPL-3.0, decision D-1). Only the DWG worker imports this module, so LibreDWG ends
 * up in that worker's bundle and never in the main application bundle (row 25).
 *
 * One instance is cached per worker. A WebAssembly trap leaves the module in an undefined state;
 * callers then call `discardLibreDwg()` so the next read starts from a fresh instance.
 */

let cached: Promise<LibreDwgEx> | null = null;

const isNode = !!(globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;

/** Last lines LibreDWG printed (it reports every problem of a damaged file; kept off the console). */
const log: string[] = [];
const LOG_LINES = 50;
const capture = (line: unknown) => {
  log.push(String(line));
  if (log.length > LOG_LINES) log.shift();
};

/** LibreDWG's recent stdout/stderr output, for diagnostics. */
export function readerLog(): string[] {
  return log.slice();
}

/** Creates a new LibreDWG instance (no caching). */
export async function createLibreDwg(): Promise<LibreDwgEx> {
  // In Node (tests) Emscripten finds the .wasm next to its glue file; in browsers the URL emitted by
  // Vite is used.
  const module = await createModule({
    print: capture,
    printErr: capture,
    ...(isNode ? {} : { locateFile: (file: string) => (file.endsWith('.wasm') ? wasmUrl : file) }),
  });
  return LibreDwg.createByWasmInstance(module);
}

/** The cached LibreDWG instance of this worker (created on first use). */
export function loadLibreDwg(): Promise<LibreDwgEx> {
  if (!cached) {
    cached = createLibreDwg().catch((e: unknown) => {
      cached = null;
      throw e;
    });
  }
  return cached;
}

/** Drops the cached instance (after a WebAssembly trap). */
export function discardLibreDwg(): void {
  cached = null;
}
