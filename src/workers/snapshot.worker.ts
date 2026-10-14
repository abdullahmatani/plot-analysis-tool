/// <reference lib="webworker" />
import type { HistoryState } from '@/core/history';
import type { SnapshotKind } from '@/persistence/db';
import { serializeSnapshot } from '@/persistence/serialize';
import type { AutosaveSettings } from '@/persistence/settings';
import { checkpointFromStorage } from '@/persistence/store-checkpoint';

/**
 * Snapshot work off the main thread (rows 91, 96; NFR-10).
 * - `serialize`: serialises a state sent by the page and computes its hashes.
 * - `checkpoint`: builds the snapshot from storage instead (see store-checkpoint.ts), so the page
 *   never clones the project; replies `fallback` when the page must serialise its state itself.
 */

interface SerializeMsg {
  type?: 'serialize';
  id: number;
  state: HistoryState;
}

interface CheckpointMsg {
  type: 'checkpoint';
  id: number;
  projectId: string;
  seq: number;
  kind: SnapshotKind;
  label?: string;
  summary?: string;
  settings: AutosaveSettings;
}

const reply = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

self.onmessage = async (e: MessageEvent<SerializeMsg | CheckpointMsg>) => {
  const m = e.data;
  if (m.type === 'checkpoint') {
    try {
      reply({ id: m.id, ok: true, ...(await checkpointFromStorage(m)) });
    } catch (err) {
      reply({ id: m.id, ok: true, fallback: String(err) });
    }
    return;
  }
  try {
    const result = await serializeSnapshot(m.state);
    reply({ id: m.id, ok: true, result });
  } catch (err) {
    reply({ id: m.id, ok: false, error: String(err) });
  }
};
