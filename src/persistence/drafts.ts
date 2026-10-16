import { nowIso } from '@/core/ids';

import { getDb, type DraftRecord } from './db';
import { journalWriter } from './journal-client';

/**
 * In-progress work drafts (row 93): unfinished interactions (half-drawn shapes, open dialogs with
 * entered values, unsaved label text) are saved within 1 s so they can be resumed after a crash.
 * After each change they are also copied, by the journal worker, next to the project's backup outside
 * IndexedDB, so they survive the browser deleting its database after a crash (C7; mirror.ts).
 */

export const DRAFT_DELAY_MS = 300;

export interface DraftHandle {
  key: string;
  tool: string;
  label: string;
}

export class DraftManager {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private latest = new Map<string, DraftRecord>();
  private writing = Promise.resolve();

  constructor(private projectId: string) {}

  /** Records the latest draft state; written to IndexedDB within DRAFT_DELAY_MS (≤ 1 s). */
  set(handle: DraftHandle, state: unknown) {
    const rec: DraftRecord = {
      projectId: this.projectId,
      key: handle.key,
      tool: handle.tool,
      label: handle.label,
      at: nowIso(),
      state: structuredCloneSafe(state),
    };
    this.latest.set(handle.key, rec);
    if (this.timers.has(handle.key)) return;
    this.timers.set(
      handle.key,
      setTimeout(() => {
        this.timers.delete(handle.key);
        const r = this.latest.get(handle.key);
        if (!r) return;
        this.latest.delete(handle.key);
        this.writing = this.writing
          .then(() =>
            getDb()
              .drafts.put(r)
              .then(() => undefined),
          )
          .catch(() => undefined);
        this.backup();
      }, DRAFT_DELAY_MS),
    );
  }

  clear(key: string) {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    this.latest.delete(key);
    this.writing = this.writing
      .then(() => getDb().drafts.delete([this.projectId, key]))
      .catch(() => undefined);
    this.backup();
  }

  /** Writes pending drafts immediately (lifecycle events). */
  async flush(): Promise<void> {
    for (const [key, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(key);
    }
    const recs = [...this.latest.values()];
    this.latest.clear();
    if (recs.length) {
      await getDb()
        .drafts.bulkPut(recs)
        .catch(() => undefined);
      this.backup();
    }
    await this.writing;
  }

  async list(): Promise<DraftRecord[]> {
    return getDb().drafts.where('projectId').equals(this.projectId).toArray();
  }

  async clearAll(): Promise<void> {
    await this.flush();
    await getDb().drafts.where('projectId').equals(this.projectId).delete();
    this.backup();
  }

  /** Copies the stored drafts, after the writes queued so far, to the backup (journal worker). */
  private backup() {
    const w = journalWriter();
    if (!w) return;
    this.writing = this.writing
      .then(async () => w.drafts(this.projectId, await this.list()))
      .catch(() => undefined);
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

function structuredCloneSafe<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v)) as T;
  }
}
