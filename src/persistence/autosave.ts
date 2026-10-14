import { quickHash } from '@/core/canonical';
import { summariseOps, type HistoryState, type JournalOp } from '@/core/history';
import { nowIso } from '@/core/ids';

import { getDb, isQuotaError, type JournalRecord, type SnapshotKind, type SnapshotRecord } from './db';
import type { Serializer, StoreCheckpointer } from './serializer-client';
import type { AutosaveSettings } from './settings';
import { compactJournal, pruneSnapshots, writeSnapshot } from './snapshots';

/**
 * Continuous autosave (rows 90–92, 94, 96, 99). Every committed command is appended to an
 * in-memory queue and written to the IndexedDB journal in batches (first write ≤ FLUSH_DELAY_MS
 * after an edit, never later than 1 s). Snapshots (checkpoints) are serialised in a worker every
 * `checkpointEvery` entries, after idle, on lifecycle events and before exports; automatic restore
 * points are taken every N minutes of active editing and before high-impact operations.
 */

export const FLUSH_DELAY_MS = 150;
export const MAX_FLUSH_DELAY_MS = 1000;

export type SaveState = 'saved' | 'saving' | 'error' | 'unavailable' | 'readonly';

export interface AutosaveStatus {
  state: SaveState;
  /** Journal records not yet durably written. */
  pending: number;
  lastSavedAt: string | null;
  lastSnapshotAt: string | null;
  lastFileSaveAt: string | null;
  /** Human-readable reason when state is 'error' or 'unavailable'. */
  reason: string | null;
  quotaExceeded: boolean;
  retryInMs: number | null;
}

export interface AutosaveHost {
  projectId: string;
  getState(): HistoryState;
  /** Called after records are durably written (e.g. to broadcast them to read-only tabs). */
  onFlushed?(records: JournalRecord[]): void;
  /** Extra metadata for the project list. */
  getMeta?(): { name: string; drawingCount: number; objectCount: number; blobKeys: string[] };
}

type Listener = (s: AutosaveStatus) => void;

/**
 * Main-thread time spent synchronously in autosave work (NFR-10: no block > 16 ms while editing):
 * journal record bookkeeping, IndexedDB request creation (structured clone of records), snapshot
 * hand-off to the serializer worker (structured clone of the state) and status notifications.
 */
export const autosaveTiming = {
  maxSyncMs: 0,
  totalSyncMs: 0,
  samples: 0,
  maxByKind: {} as Record<string, number>,
};

function timed<T>(kind: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const d = performance.now() - t0;
    autosaveTiming.samples++;
    autosaveTiming.totalSyncMs += d;
    if (d > autosaveTiming.maxSyncMs) autosaveTiming.maxSyncMs = d;
    if (d > (autosaveTiming.maxByKind[kind] ?? 0)) autosaveTiming.maxByKind[kind] = d;
  }
}

export class AutosaveEngine {
  private seq: number;
  private queue: JournalRecord[] = [];
  private inFlight: Promise<void> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 0;
  private entriesSinceSnapshot = 0;
  private snapshotting: Promise<SnapshotRecord | null> | null = null;
  private lastSnapshotSeq: number;
  private activeEditingMs = 0;
  private lastRecordAt = 0;
  private opsSinceRestorePoint: JournalOp[] = [];
  private listeners = new Set<Listener>();
  private disposed = false;
  /** Highest sequence number known to be durable in the journal. */
  private flushedSeq: number;
  private storeCheckpoint: StoreCheckpointer | null;
  status: AutosaveStatus;

  constructor(
    private host: AutosaveHost,
    private settings: AutosaveSettings,
    private serialize: Serializer,
    startSeq: number,
    opts: { lastSnapshotSeq?: number; available?: boolean; storeCheckpoint?: StoreCheckpointer | null } = {},
  ) {
    this.seq = startSeq;
    this.flushedSeq = startSeq;
    this.storeCheckpoint = opts.storeCheckpoint ?? null;
    this.lastSnapshotSeq = opts.lastSnapshotSeq ?? startSeq;
    this.status = {
      state: opts.available === false ? 'unavailable' : 'saved',
      pending: 0,
      lastSavedAt: null,
      lastSnapshotAt: null,
      lastFileSaveAt: null,
      reason:
        opts.available === false
          ? 'Browser storage is unavailable (e.g. private browsing). Save the project to a file.'
          : null,
      quotaExceeded: false,
      retryInMs: null,
    };
  }

  get currentSeq() {
    return this.seq;
  }

  get hasUnflushed() {
    return this.queue.length > 0 || this.inFlight !== null;
  }

  updateSettings(s: AutosaveSettings) {
    this.settings = s;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<AutosaveStatus>) {
    this.status = { ...this.status, ...patch };
    this.status.pending = this.queue.length + (this.inFlight ? 1 : 0);
    if (
      this.status.state !== 'unavailable' &&
      this.status.state !== 'error' &&
      this.status.state !== 'readonly'
    ) {
      this.status.state = this.hasUnflushed ? 'saving' : 'saved';
    }
    for (const l of this.listeners) l(this.status);
  }

  /** Records a committed command (do / undo / redo). Never throws. */
  record(op: JournalOp) {
    if (this.disposed) return;
    timed('record', () => this.recordNow(op));
  }

  private recordNow(op: JournalOp) {
    const now = Date.now();
    const rec: JournalRecord = {
      projectId: this.host.projectId,
      seq: ++this.seq,
      at: new Date(now).toISOString(),
      op,
      hash: quickHash(JSON.stringify(op)),
    };
    this.queue.push(rec);
    this.opsSinceRestorePoint.push(op);
    if (this.lastRecordAt) this.activeEditingMs += Math.min(now - this.lastRecordAt, 60_000);
    this.lastRecordAt = now;
    if (!this.firstPendingAt) this.firstPendingAt = now;
    this.scheduleFlush();
    this.scheduleIdle();
    this.emit({});
  }

  private scheduleFlush() {
    if (this.status.state === 'unavailable' || this.retryTimer) return;
    // Throttle, not debounce: the oldest pending record is written within FLUSH_DELAY_MS even while
    // edits keep arriving faster than that (a debounce would hold it back until the cap, leaving
    // no headroom for the commit itself within NFR-9's 1 s).
    if (this.flushTimer) return;
    const elapsed = Date.now() - this.firstPendingAt;
    const delay = Math.max(0, Math.min(FLUSH_DELAY_MS, MAX_FLUSH_DELAY_MS - elapsed));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delay);
  }

  private scheduleIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.seq > this.lastSnapshotSeq) void this.checkpoint('idle');
    }, this.settings.idleCheckpointSec * 1000);
  }

  /** Writes all queued journal records. Resolves when they are durable (or rejects on failure). */
  flush(): Promise<void> {
    const p = this.flushChain.then(() => this.doFlush());
    this.flushChain = p.catch(() => {});
    return p;
  }

  private async doFlush(): Promise<void> {
    if (this.status.state === 'unavailable' || this.queue.length === 0) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.queue;
    this.queue = [];
    this.firstPendingAt = 0;
    const db = getDb();
    const meta = this.host.getMeta?.();
    const last = batch[batch.length - 1];
    this.inFlight = db.transaction('rw', db.journal, db.projects, async () => {
      await timed('journal', () => db.journal.bulkPut(batch));
      const existing = await db.projects.get(this.host.projectId);
      if (existing) {
        await db.projects.put({
          ...existing,
          ...(meta ?? {}),
          updatedAt: last.at,
          lastSeq: Math.max(existing.lastSeq, last.seq),
        });
      }
    });
    this.emit({});
    try {
      await this.inFlight;
      this.inFlight = null;
      this.retryDelay = 0;
      this.flushedSeq = Math.max(this.flushedSeq, last.seq);
      this.entriesSinceSnapshot += batch.length;
      this.emit({
        lastSavedAt: nowIso(),
        state: this.status.state === 'error' ? 'saving' : this.status.state,
        reason: null,
        quotaExceeded: false,
        retryInMs: null,
      });
      this.host.onFlushed?.(batch);
      if (this.entriesSinceSnapshot >= this.settings.checkpointEvery) void this.checkpoint('interval');
      if (this.activeEditingMs >= this.settings.restorePointIntervalMin * 60_000) {
        this.activeEditingMs = 0;
        void this.restorePoint('auto-restore-point', 'Automatic');
      }
    } catch (e) {
      this.inFlight = null;
      // Keep the batch in memory, in order, ahead of anything recorded meanwhile.
      this.queue = [...batch, ...this.queue];
      if (!this.firstPendingAt) this.firstPendingAt = Date.now();
      const quota = isQuotaError(e);
      this.retryDelay = Math.min(30_000, this.retryDelay ? this.retryDelay * 2 : 1000);
      this.emit({
        state: 'error',
        reason: quota
          ? 'Browser storage is full. Changes are kept in memory — save the project to a file now.'
          : `Could not write to browser storage (${(e as Error)?.message ?? String(e)}). Retrying…`,
        quotaExceeded: quota,
        retryInMs: this.retryDelay,
      });
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.flush().catch(() => {});
      }, this.retryDelay);
      throw e;
    }
  }

  /** Takes a checkpoint snapshot, then compacts the journal and prunes old snapshots. */
  async checkpoint(reason: string): Promise<SnapshotRecord | null> {
    void reason;
    return this.snapshot('checkpoint');
  }

  /** Creates a restore point (automatic or named). Flushes first; awaits completion. */
  async restorePoint(
    kind: Exclude<SnapshotKind, 'checkpoint'>,
    label: string,
  ): Promise<SnapshotRecord | null> {
    const rec = await this.snapshot(kind, label, summariseOps(this.opsSinceRestorePoint) || 'No changes');
    if (rec) this.opsSinceRestorePoint = [];
    return rec;
  }

  private async snapshot(
    kind: SnapshotKind,
    label?: string,
    summary?: string,
  ): Promise<SnapshotRecord | null> {
    if (this.status.state === 'unavailable' || this.disposed) return null;
    // A restore point captures the state at the moment it was requested (states are immutable, so
    // keeping the reference is free); checkpoints may capture any later consistent state.
    const reqSeq = this.seq;
    const reqState = this.host.getState();
    if (this.snapshotting) await this.snapshotting.catch(() => null);
    if (kind === 'checkpoint' && this.seq === this.lastSnapshotSeq && this.queue.length === 0) return null;
    const task = (async () => {
      await this.flush();
      // Preferred: the worker rebuilds the state from storage (no main-thread clone, NFR-10).
      const target = kind === 'checkpoint' ? this.flushedSeq : reqSeq;
      if (
        this.storeCheckpoint &&
        target <= this.flushedSeq &&
        (kind !== 'checkpoint' || target > this.lastSnapshotSeq)
      ) {
        const done = await this.storeCheckpoint({
          projectId: this.host.projectId,
          seq: target,
          kind,
          label,
          summary,
          settings: this.settings,
        });
        if (done) {
          this.lastSnapshotSeq = Math.max(this.lastSnapshotSeq, target);
          if (kind === 'checkpoint') this.entriesSinceSnapshot = 0;
          this.emit({ lastSnapshotAt: done.at });
          return { ...done, projectId: this.host.projectId } as SnapshotRecord;
        }
      }
      const seq = kind === 'checkpoint' ? this.seq : reqSeq;
      const state = kind === 'checkpoint' ? this.host.getState() : reqState;
      const serialized = await timed('snapshot-handoff', () => this.serialize(state));
      const rec = await timed('snapshot-write', () =>
        writeSnapshot(this.host.projectId, seq, kind, serialized, { label, summary }),
      );
      this.lastSnapshotSeq = Math.max(this.lastSnapshotSeq, seq);
      if (kind === 'checkpoint') this.entriesSinceSnapshot = 0;
      await compactJournal(this.host.projectId);
      await pruneSnapshots(this.host.projectId, this.settings);
      this.emit({ lastSnapshotAt: rec.at });
      return rec;
    })();
    this.snapshotting = task;
    try {
      return await task;
    } catch (e) {
      if (isQuotaError(e))
        this.emit({
          state: 'error',
          quotaExceeded: true,
          reason: 'Browser storage is full. Save the project to a file now.',
        });
      return null;
    } finally {
      if (this.snapshotting === task) this.snapshotting = null;
    }
  }

  /** Lifecycle save (row 92): flush pending entries and take a checkpoint. */
  async lifecycleSave(): Promise<void> {
    try {
      await this.flush();
    } catch {
      /* status already reports the error */
    }
    await this.checkpoint('lifecycle');
  }

  markFileSaved(at = nowIso()) {
    this.emit({ lastFileSaveAt: at });
  }

  setReadOnly(readOnly: boolean) {
    this.emit({ state: readOnly ? 'readonly' : this.hasUnflushed ? 'saving' : 'saved' });
  }

  dispose() {
    this.disposed = true;
    for (const t of [this.flushTimer, this.idleTimer, this.retryTimer]) if (t) clearTimeout(t);
    this.listeners.clear();
  }
}
