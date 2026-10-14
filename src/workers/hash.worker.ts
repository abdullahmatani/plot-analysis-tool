/// <reference lib="webworker" />
import { sha256Hex } from '@/core/canonical';

/** SHA-256 of large source files off the main thread (NFR-2: no long main-thread blocks). */
self.onmessage = async (e: MessageEvent<{ id: number; bytes: Uint8Array }>) => {
  try {
    const hex = await sha256Hex(e.data.bytes);
    (self as unknown as Worker).postMessage({ id: e.data.id, hex });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: e.data.id, error: (err as Error)?.message ?? String(err) });
  }
};
