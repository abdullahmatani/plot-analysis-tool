import { newId, nowIso } from '@/core/ids';

import { getDb, type BlobRecord } from './db';
import {
  MIRROR_DIR,
  decodeDrafts,
  draftsFileName,
  mirrorFileName,
  parseDraftsFileName,
  parseMirrorFileName,
  pickMirror,
  readMirrorFile,
  type MirrorState,
} from './mirror-format';

/**
 * Start-up side of the backup copy (mirror-format.ts). The database carries a marker written when
 * it is first used. A database without the marker and without projects is new: either this is the
 * first start, or the browser deleted it. In that case every project in the backup is rebuilt.
 * Otherwise backup files of projects that no longer exist are removed.
 */

export interface MirrorSource {
  list(): Promise<string[]>;
  read(name: string): Promise<Uint8Array | null>;
  remove(name: string): Promise<void>;
  /** Size of the drawing file in the private file system's `blobs` folder, or null when absent. */
  blobSize(sha256: string): Promise<number | null>;
}

const MARKER = 'storeId';

export function opfsMirrorSource(): MirrorSource | null {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  const dir = async (name: string, create = false) =>
    (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create });
  return {
    async list() {
      try {
        const names: string[] = [];
        const d = (await dir(MIRROR_DIR)) as unknown as { keys(): AsyncIterable<string> };
        for await (const n of d.keys()) names.push(n);
        return names;
      } catch {
        return [];
      }
    },
    async read(name) {
      try {
        const fh = await (await dir(MIRROR_DIR)).getFileHandle(name);
        return new Uint8Array(await (await fh.getFile()).arrayBuffer());
      } catch {
        return null;
      }
    },
    async remove(name) {
      try {
        await (await dir(MIRROR_DIR)).removeEntry(name);
      } catch {
        /* missing, or in use by another tab: removed at a later start */
      }
    },
    async blobSize(sha256) {
      try {
        return (await (await (await dir('blobs')).getFileHandle(sha256)).getFile()).size;
      } catch {
        return null;
      }
    },
  };
}

/** Reads every project's backup. */
export async function readMirrors(src: MirrorSource): Promise<Map<string, MirrorState>> {
  const ids = new Set<string>();
  for (const name of await src.list()) {
    const p = parseMirrorFileName(name);
    if (p) ids.add(p.projectId);
  }
  const out = new Map<string, MirrorState>();
  for (const id of ids) {
    const a = readMirrorFile('a', await src.read(mirrorFileName(id, 'a')));
    const b = readMirrorFile('b', await src.read(mirrorFileName(id, 'b')));
    const m = pickMirror(a, b);
    if (m) out.set(id, m);
  }
  return out;
}

/** Writes a project rebuilt from its backup into IndexedDB. */
export async function restoreProject(m: MirrorState, src: MirrorSource): Promise<void> {
  const db = getDb();
  const now = nowIso();
  const blobs: BlobRecord[] = [];
  // Drawings imported after the base are known only by their key in the latest metadata.
  const known = new Map(m.base.blobs.map((b) => [b.sha256, b]));
  for (const sha256 of new Set([...m.meta.blobKeys, ...known.keys()])) {
    const size = await src.blobSize(sha256);
    if (size === null) continue;
    const info = known.get(sha256) ?? { sha256, size, name: sha256, type: 'application/octet-stream' };
    blobs.push({ ...info, where: 'opfs', createdAt: now });
  }
  // Unfinished work (row 93) kept with the backup, offered for resuming when the project opens.
  const drafts = (decodeDrafts(await src.read(draftsFileName(m.meta.id))) ?? []).map((d) => ({
    ...d,
    projectId: m.meta.id,
  }));
  await db.transaction('rw', [db.projects, db.snapshots, db.journal, db.blobs, db.drafts], async () => {
    await db.projects.put({ ...m.meta, lastOpenedAt: m.meta.lastOpenedAt || now });
    await db.snapshots.put({
      ...m.base.snapshot,
      id: newId('snap'),
      projectId: m.meta.id,
      kind: 'checkpoint',
    });
    if (m.journal.length) await db.journal.bulkPut(m.journal);
    for (const b of blobs) if (!(await db.blobs.get(b.sha256))) await db.blobs.put(b);
    if (drafts.length) await db.drafts.bulkPut(drafts);
  });
}

/**
 * Run once at start-up, before anything else opens projects. Returns the names of the projects
 * rebuilt from the backup (empty when the database was intact).
 */
export async function checkMirror(src: MirrorSource | null = opfsMirrorSource()): Promise<string[]> {
  const db = getDb();
  const marker = await db.settings.get(MARKER);
  const projectIds = new Set(await db.projects.toCollection().primaryKeys());
  if (!marker) await db.settings.put({ key: MARKER, value: { id: newId('store'), at: nowIso() } });
  if (!src) return [];
  const fresh = !marker && projectIds.size === 0;
  if (!fresh) {
    for (const name of await src.list()) {
      const id = parseMirrorFileName(name)?.projectId ?? parseDraftsFileName(name);
      if (id && !projectIds.has(id)) await src.remove(name);
    }
    return [];
  }
  const restored: string[] = [];
  for (const m of (await readMirrors(src)).values()) {
    try {
      await restoreProject(m, src);
      restored.push(m.meta.name);
    } catch {
      /* unreadable backup: skipped */
    }
  }
  return restored;
}
