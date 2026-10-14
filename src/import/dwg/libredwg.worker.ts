/// <reference lib="webworker" />
import { storeTransferables } from '@/underlay/entity-store';

import { DwgReadError } from './errors';
import { readDwg } from './read';

/**
 * Child worker of the DWG worker (`src/workers/dwg.worker.ts`). It runs LibreDWG (GPL-3.0), which
 * is bundled only here. LibreDWG works synchronously, so the parent enforces the time limit by
 * terminating this worker; terminating it also releases LibreDWG's WebAssembly memory at once.
 *
 * Messages: in `{ bytes, layout? }`; out `{ type: 'progress', fraction, message }`,
 * `{ type: 'done', result }` (store arrays transferred) or `{ type: 'error', message, name, code }`.
 */
const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<{ bytes: Uint8Array; layout?: string }>) => {
  try {
    const result = await readDwg(e.data.bytes, {
      layout: e.data.layout,
      onProgress: (fraction, message) => post({ type: 'progress', fraction, message }),
    });
    post({ type: 'done', result }, storeTransferables(result.store));
  } catch (err) {
    post({
      type: 'error',
      message: (err as Error)?.message ?? String(err),
      name: (err as Error)?.name ?? 'Error',
      code: err instanceof DwgReadError ? err.code : undefined,
    });
  }
};
