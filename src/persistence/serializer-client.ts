import type { HistoryState } from '@/core/history';

import { serializeSnapshot, type SerializedSnapshot } from './serialize';

export type Serializer = (state: HistoryState) => Promise<SerializedSnapshot>;

/** Worker-backed serializer with an in-thread fallback (tests, or if workers are unavailable). */
export function createSerializer(): Serializer {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return serializeSnapshot;
  let worker: Worker | null = null;
  let nextId = 1;
  const waiting = new Map<number, { resolve: (r: SerializedSnapshot) => void; reject: (e: Error) => void }>();
  const ensure = () => {
    if (worker) return worker;
    worker = new Worker(new URL('../workers/snapshot.worker.ts', import.meta.url), {
      type: 'module',
      name: 'snapshot',
    });
    worker.onmessage = (
      e: MessageEvent<{ id: number; ok: boolean; result?: SerializedSnapshot; error?: string }>,
    ) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.ok && e.data.result) w.resolve(e.data.result);
      else w.reject(new Error(e.data.error ?? 'Snapshot serialisation failed'));
    };
    worker.onerror = () => {
      for (const w of waiting.values()) w.reject(new Error('Snapshot worker crashed'));
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  };
  return (state) =>
    new Promise<SerializedSnapshot>((resolve, reject) => {
      let w: Worker;
      try {
        w = ensure();
      } catch {
        serializeSnapshot(state).then(resolve, reject);
        return;
      }
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      w.postMessage({ id, state });
    });
}
