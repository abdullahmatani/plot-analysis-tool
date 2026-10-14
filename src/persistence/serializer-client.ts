import type { HistoryState } from '@/core/history';

import type { SnapshotKind } from './db';
import { serializeSnapshot, type SerializedSnapshot } from './serialize';
import type { AutosaveSettings } from './settings';

export type Serializer = (state: HistoryState) => Promise<SerializedSnapshot>;

export interface StoreCheckpointArgs {
  projectId: string;
  /** Sequence number of the last durable journal entry the snapshot must include. */
  seq: number;
  kind: SnapshotKind;
  label?: string;
  summary?: string;
  settings: AutosaveSettings;
}

/** Writes a snapshot built from storage in the worker; resolves null when the caller must fall back. */
export type StoreCheckpointer = (
  args: StoreCheckpointArgs,
) => Promise<{ id: string; seq: number; at: string; kind: SnapshotKind } | null>;

export interface SnapshotService {
  serialize: Serializer;
  checkpointFromStore: StoreCheckpointer | null;
}

type Reply = {
  id: number;
  ok: boolean;
  result?: SerializedSnapshot;
  record?: { id: string; seq: number; at: string; kind: SnapshotKind };
  fallback?: string;
  error?: string;
};

/** Worker-backed snapshot service with an in-thread fallback (tests, or if workers are unavailable). */
export function createSnapshotService(): SnapshotService {
  if (typeof Worker === 'undefined' || typeof window === 'undefined')
    return { serialize: serializeSnapshot, checkpointFromStore: null };
  let worker: Worker | null = null;
  let nextId = 1;
  const waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  const ensure = () => {
    if (worker) return worker;
    worker = new Worker(new URL('../workers/snapshot.worker.ts', import.meta.url), {
      type: 'module',
      name: 'snapshot',
    });
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      w.resolve(e.data);
    };
    worker.onerror = () => {
      for (const w of waiting.values()) w.reject(new Error('Snapshot worker crashed'));
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  };
  const call = (msg: Record<string, unknown>) =>
    new Promise<Reply>((resolve, reject) => {
      const w = ensure();
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      w.postMessage({ ...msg, id });
    });
  const serialize: Serializer = async (state) => {
    let r: Reply;
    try {
      r = await call({ type: 'serialize', state });
    } catch {
      return serializeSnapshot(state);
    }
    if (r.ok && r.result) return r.result;
    throw new Error(r.error ?? 'Snapshot serialisation failed');
  };
  const checkpointFromStore: StoreCheckpointer = async (args) => {
    try {
      const r = await call({ type: 'checkpoint', ...args });
      if (r.record) return r.record;
      if (r.fallback) console.info('Checkpoint built on the main thread:', r.fallback);
      return null;
    } catch {
      return null;
    }
  };
  return { serialize, checkpointFromStore };
}

/** Back-compatible helper: the serialiser only. */
export function createSerializer(): Serializer {
  return createSnapshotService().serialize;
}
