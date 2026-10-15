import { sha256Hex } from '@/core/canonical';

import { getDb, type DraftRecord, type JournalRecord, type SnapshotRecord } from './db';
import type { JournalMeta } from './journal-write';
import {
  draftsFileName,
  encodeBase,
  encodeDrafts,
  encodeJournal,
  MIRROR_DIR,
  MIRROR_VERSION,
  mirrorFileName,
  pickMirror,
  readMirrorFile,
  type MirrorBlobInfo,
  type MirrorSlot,
} from './mirror-format';

/**
 * Writes the backup copy (mirror-format.ts). Runs in the journal worker, which already serialises
 * each project's writes: `append` after every journal batch is durable in IndexedDB, `rotate` after a
 * checkpoint (or when the file grows, or anything looks out of step) starts a new base in the other
 * file from what IndexedDB holds, and `drop` removes a deleted project's files.
 */

export interface MirrorFile {
  size(): number;
  read(): Uint8Array;
  write(bytes: Uint8Array, at: number): void;
  truncate(size: number): void;
  flush(): void;
}

export interface MirrorFiles {
  /** Runs `fn` with exclusive access to the file, creating it when missing. */
  open<T>(name: string, fn: (f: MirrorFile) => T): Promise<T>;
  remove(name: string): Promise<void>;
}

interface SyncHandle {
  getSize(): number;
  read(buf: Uint8Array, o: { at: number }): number;
  write(buf: Uint8Array, o: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

/** The Origin Private File System, through synchronous access handles (dedicated workers only). */
export function opfsMirrorFiles(): MirrorFiles | null {
  const storage = (globalThis as { navigator?: Navigator }).navigator?.storage;
  if (!storage?.getDirectory || typeof FileSystemFileHandle === 'undefined') return null;
  if (!('createSyncAccessHandle' in FileSystemFileHandle.prototype)) return null;
  let dir: Promise<FileSystemDirectoryHandle> | null = null;
  const mirrorDir = () =>
    (dir ??= storage.getDirectory().then((root) => root.getDirectoryHandle(MIRROR_DIR, { create: true })));
  return {
    async open(name, fn) {
      const fh = await (await mirrorDir()).getFileHandle(name, { create: true });
      const h = (await (
        fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }
      ).createSyncAccessHandle()) as SyncHandle;
      try {
        return fn({
          size: () => h.getSize(),
          read: () => {
            const buf = new Uint8Array(h.getSize());
            h.read(buf, { at: 0 });
            return buf;
          },
          write: (bytes, at) => {
            h.write(bytes, { at });
          },
          truncate: (size) => h.truncate(size),
          flush: () => h.flush(),
        });
      } finally {
        h.close();
      }
    },
    async remove(name) {
      try {
        await (await mirrorDir()).removeEntry(name);
      } catch (e) {
        if ((e as DOMException)?.name !== 'NotFoundError') throw e;
      }
    },
  };
}

interface Tracked {
  slot: MirrorSlot;
  gen: number;
  lastSeq: number;
  size: number;
  baseBytes: number;
  frames: number;
}

/** A new base is started after this many journal frames or journal bytes, keeping replay short. */
export const ROTATE_FRAMES = 1000;
export const ROTATE_BYTES = 8 * 1024 * 1024;

export class MirrorWriter {
  private tracked = new Map<string, Tracked | 'stale'>();

  constructor(
    private files: MirrorFiles,
    private limits = { frames: ROTATE_FRAMES, bytes: ROTATE_BYTES },
  ) {}

  /** Appends a batch that is already durable in IndexedDB. */
  async append(projectId: string, batch: JournalRecord[], meta?: JournalMeta): Promise<void> {
    if (!batch.length) return;
    try {
      let t = this.tracked.get(projectId);
      if (t === undefined) {
        t = (await this.load(projectId)) ?? 'stale';
        this.tracked.set(projectId, t);
      }
      if (
        t === 'stale' ||
        batch[0].seq !== t.lastSeq + 1 ||
        t.frames >= this.limits.frames ||
        t.size - t.baseBytes >= this.limits.bytes
      )
        return await this.rotate(projectId);
      const cur = t;
      const bytes = encodeJournal({ recs: batch, meta });
      const ok = await this.files.open(mirrorFileName(projectId, cur.slot), (f) => {
        if (f.size() !== cur.size) return false; // written elsewhere (another tab): rebuild
        f.write(bytes, cur.size);
        f.flush();
        return true;
      });
      if (!ok) return await this.rotate(projectId);
      cur.size += bytes.length;
      cur.frames++;
      cur.lastSeq = batch[batch.length - 1].seq;
    } catch (e) {
      this.tracked.set(projectId, 'stale');
      throw e;
    }
  }

  /** Starts a new base in the other file from the project's state in IndexedDB. */
  async rotate(projectId: string): Promise<void> {
    try {
      let cur = this.tracked.get(projectId);
      if (cur === undefined || cur === 'stale') cur = (await this.load(projectId)) ?? undefined;
      const db = getDb();
      const stored = await db.transaction(
        'r',
        [db.projects, db.snapshots, db.journal, db.blobs],
        async () => {
          const meta = await db.projects.get(projectId);
          if (!meta) return null;
          const snapshots = await db.snapshots.where('projectId').equals(projectId).toArray();
          const journal = await db.journal.where('projectId').equals(projectId).toArray();
          const blobs = await db.blobs.bulkGet(meta.blobKeys);
          return { meta, snapshots, journal, blobs };
        },
      );
      if (!stored) return;
      const snapshot = await newestValid(stored.snapshots);
      if (!snapshot) return;
      const recs = stored.journal.filter((r) => r.seq > snapshot.seq).sort((a, b) => a.seq - b.seq);
      const blobs: MirrorBlobInfo[] = [];
      for (const b of stored.blobs)
        if (b) blobs.push({ sha256: b.sha256, size: b.size, name: b.name, type: b.type });
      const slot: MirrorSlot = cur?.slot === 'a' ? 'b' : 'a';
      const gen = (cur?.gen ?? 0) + 1;
      const { id: _id, projectId: _p, kind: _k, label: _l, summary: _s, ...snap } = snapshot;
      void [_id, _p, _k, _l, _s];
      const base = encodeBase({ v: MIRROR_VERSION, gen, meta: stored.meta, snapshot: snap, blobs });
      const tail = recs.length ? encodeJournal({ recs }) : new Uint8Array(0);
      await this.files.open(mirrorFileName(projectId, slot), (f) => {
        f.truncate(0);
        f.write(base, 0);
        if (tail.length) f.write(tail, base.length);
        f.flush();
      });
      this.tracked.set(projectId, {
        slot,
        gen,
        lastSeq: recs.length ? recs[recs.length - 1].seq : snapshot.seq,
        size: base.length + tail.length,
        baseBytes: base.length,
        frames: 0,
      });
    } catch (e) {
      this.tracked.set(projectId, 'stale');
      throw e;
    }
  }

  async drop(projectId: string): Promise<void> {
    this.tracked.delete(projectId);
    await this.files.remove(mirrorFileName(projectId, 'a'));
    await this.files.remove(mirrorFileName(projectId, 'b'));
    await this.files.remove(draftsFileName(projectId));
  }

  /**
   * Replaces the project's backed-up drafts (row 93) with `drafts`, so unfinished work also survives
   * the loss of the database. A write cut short by a crash leaves a file that fails its check and is
   * ignored on restore, as if there were no drafts.
   */
  async writeDrafts(projectId: string, drafts: DraftRecord[]): Promise<void> {
    const name = draftsFileName(projectId);
    if (!drafts.length) return this.files.remove(name);
    const bytes = encodeDrafts(drafts);
    await this.files.open(name, (f) => {
      f.write(bytes, 0);
      f.truncate(bytes.length);
      f.flush();
    });
  }

  private async load(projectId: string): Promise<Tracked | null> {
    const read = (slot: MirrorSlot) =>
      this.files.open(mirrorFileName(projectId, slot), (f) => {
        const state = readMirrorFile(slot, f.read());
        // Drop a damaged tail so appends land right after the last valid frame.
        if (state && f.size() > state.validBytes) {
          f.truncate(state.validBytes);
          f.flush();
        }
        return state;
      });
    const m = pickMirror(await read('a'), await read('b'));
    return m
      ? {
          slot: m.slot,
          gen: m.base.gen,
          lastSeq: m.lastSeq,
          size: m.validBytes,
          baseBytes: m.baseBytes,
          frames: 0,
        }
      : null;
  }
}

async function newestValid(snapshots: SnapshotRecord[]): Promise<SnapshotRecord | null> {
  const sorted = [...snapshots].sort((a, b) => b.seq - a.seq || b.at.localeCompare(a.at));
  for (const s of sorted) {
    if (typeof s.data === 'string' && (await sha256Hex(s.data)) === s.sha256) return s;
  }
  return null;
}
