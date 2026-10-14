import { sha256Hex } from '@/core/canonical';
import { nowIso } from '@/core/ids';

import { getDb, type BlobRecord } from './db';

/**
 * Source drawing storage (row 99): each file is stored once per SHA-256. Files above
 * OPFS_THRESHOLD go to the Origin Private File System when available (better for large binaries);
 * smaller ones (or all, when OPFS is unavailable) are stored as Blobs in IndexedDB.
 */

export const OPFS_THRESHOLD = 8 * 1024 * 1024;

async function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('blobs', { create: true });
  } catch {
    return null;
  }
}

export async function hashBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  return sha256Hex(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

/** Stores bytes (deduplicated by hash) and returns the hash key. */
export async function putBlob(
  bytes: Uint8Array,
  name: string,
  type = 'application/octet-stream',
  knownHash?: string,
): Promise<string> {
  const db = getDb();
  const sha256 = knownHash ?? (await hashBytes(bytes));
  const existing = await db.blobs.get(sha256);
  if (existing) return sha256;
  const record: BlobRecord = {
    sha256,
    size: bytes.byteLength,
    name,
    type,
    where: 'idb',
    createdAt: nowIso(),
  };
  if (bytes.byteLength >= OPFS_THRESHOLD) {
    const dir = await opfsDir();
    if (dir) {
      try {
        const fh = await dir.getFileHandle(sha256, { create: true });
        const w = await fh.createWritable();
        await w.write(bytes as unknown as FileSystemWriteChunkType);
        await w.close();
        record.where = 'opfs';
      } catch {
        record.where = 'idb';
      }
    }
  }
  if (record.where === 'idb') record.data = new Blob([bytes as BlobPart], { type });
  await db.blobs.put(record);
  return sha256;
}

export async function getBlobBytes(sha256: string): Promise<Uint8Array | null> {
  const db = getDb();
  const rec = await db.blobs.get(sha256);
  if (!rec) return null;
  if (rec.where === 'opfs') {
    const dir = await opfsDir();
    if (!dir) return null;
    try {
      const fh = await dir.getFileHandle(sha256);
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }
  if (!rec.data) return null;
  return new Uint8Array(await rec.data.arrayBuffer());
}

export async function getBlobInfo(sha256: string): Promise<Omit<BlobRecord, 'data'> | null> {
  const rec = await getDb().blobs.get(sha256);
  if (!rec) return null;
  const { data: _data, ...info } = rec;
  void _data;
  return info;
}

/** Deletes blobs that no project references any more. */
export async function collectGarbage(): Promise<number> {
  const db = getDb();
  const referenced = new Set<string>();
  for (const meta of await db.projects.toArray()) for (const k of meta.blobKeys) referenced.add(k);
  let removed = 0;
  const dir = await opfsDir();
  for (const rec of await db.blobs.toArray()) {
    if (referenced.has(rec.sha256)) continue;
    if (rec.where === 'opfs' && dir) {
      try {
        await dir.removeEntry(rec.sha256);
      } catch {
        /* already gone */
      }
    }
    await db.blobs.delete(rec.sha256);
    removed++;
  }
  return removed;
}

export async function clearOpfs(): Promise<void> {
  try {
    if (!navigator.storage?.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      await root.removeEntry(name, { recursive: true });
    }
  } catch {
    /* OPFS unavailable */
  }
}
