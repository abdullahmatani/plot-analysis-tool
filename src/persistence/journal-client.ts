import type { JournalRecord } from './db';
import type { JournalMeta } from './journal-write';

/** Messages from the journal worker (see src/workers/journal.worker.ts). */
export type JournalWorkerMessage =
  | { type: 'ack'; projectId: string; upTo: number; committedAt?: number }
  | { type: 'error'; projectId: string; message: string; quota: boolean; retryInMs: number };

export interface JournalWriter {
  record(rec: JournalRecord, meta?: JournalMeta): void;
  flush(projectId: string): void;
  /** Starts a new base for the project's backup copy (after a checkpoint, or for a new project). */
  rotate(projectId: string): void;
  /** Removes a deleted project's backup copy. */
  drop(projectId: string): void;
  /** Listens to one project's acknowledgements and errors; `onCrash` when the worker dies. */
  listen(projectId: string, fn: (m: JournalWorkerMessage) => void, onCrash: () => void): () => void;
}

let shared: JournalWriter | null | undefined;

/**
 * The shared journal worker (one per page, kept alive across projects so closing a project never
 * cuts off a pending write). Null where workers are unavailable (unit tests): the engine then writes
 * on the calling thread.
 */
export function journalWriter(): JournalWriter | null {
  if (shared !== undefined) return shared;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return (shared = null);
  let worker: Worker;
  try {
    worker = new Worker(new URL('../workers/journal.worker.ts', import.meta.url), {
      type: 'module',
      name: 'journal',
    });
  } catch {
    return (shared = null);
  }
  const listeners = new Map<string, Set<{ fn: (m: JournalWorkerMessage) => void; onCrash: () => void }>>();
  worker.onmessage = (e: MessageEvent<JournalWorkerMessage>) => {
    for (const l of listeners.get(e.data.projectId) ?? []) l.fn(e.data);
  };
  worker.onerror = () => {
    shared = null; // later engines write on the main thread
    for (const set of listeners.values()) for (const l of set) l.onCrash();
    listeners.clear();
  };
  shared = {
    record: (rec, meta) => worker.postMessage({ type: 'record', rec, meta }),
    flush: (projectId) => worker.postMessage({ type: 'flush', projectId }),
    rotate: (projectId) => worker.postMessage({ type: 'rotate', projectId }),
    drop: (projectId) => worker.postMessage({ type: 'drop', projectId }),
    listen(projectId, fn, onCrash) {
      let set = listeners.get(projectId);
      if (!set) listeners.set(projectId, (set = new Set()));
      const entry = { fn, onCrash };
      set.add(entry);
      return () => set!.delete(entry);
    },
  };
  return shared;
}
