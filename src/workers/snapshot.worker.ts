/// <reference lib="webworker" />
import { serializeSnapshot } from '@/persistence/serialize';
import type { HistoryState } from '@/core/history';

/** Serialises snapshots and computes SHA-256 off the main thread (row 91, NFR-10). */
self.onmessage = async (e: MessageEvent<{ id: number; state: HistoryState }>) => {
  try {
    const result = await serializeSnapshot(e.data.state);
    (self as unknown as Worker).postMessage({ id: e.data.id, ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: e.data.id, ok: false, error: String(err) });
  }
};
