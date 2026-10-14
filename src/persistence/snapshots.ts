import { sha256Hex } from '@/core/canonical';
import type { HistoryState } from '@/core/history';
import { newId, nowIso } from '@/core/ids';

import { getDb, type SnapshotKind, type SnapshotRecord } from './db';
import { parseSnapshotData, type SerializedSnapshot } from './serialize';
import type { AutosaveSettings } from './settings';

/** Snapshot storage, verification and retention (rows 91, 96). */

export const KEEP_CHECKPOINTS = 3;

export async function writeSnapshot(
  projectId: string,
  seq: number,
  kind: SnapshotKind,
  serialized: SerializedSnapshot,
  opts: { label?: string; summary?: string } = {},
): Promise<SnapshotRecord> {
  const rec: SnapshotRecord = {
    id: newId('snap'),
    projectId,
    seq,
    at: nowIso(),
    kind,
    label: opts.label,
    summary: opts.summary,
    sha256: serialized.sha256,
    projectHash: serialized.projectHash,
    data: serialized.data,
    size: serialized.size,
  };
  await getDb().snapshots.put(rec);
  return rec;
}

/** All snapshots of a project, newest (highest seq, then newest time) first. */
export async function listSnapshots(projectId: string): Promise<SnapshotRecord[]> {
  const all = await getDb().snapshots.where('projectId').equals(projectId).toArray();
  return all.sort((a, b) => b.seq - a.seq || b.at.localeCompare(a.at));
}

export async function verifySnapshot(rec: SnapshotRecord): Promise<HistoryState> {
  if (typeof rec.data !== 'string') throw new Error('Snapshot data missing');
  const hash = await sha256Hex(rec.data);
  if (hash !== rec.sha256) throw new Error('Snapshot checksum mismatch');
  return parseSnapshotData(rec.data);
}

export interface LoadedSnapshot {
  record: SnapshotRecord;
  state: HistoryState;
  skipped: { id: string; seq: number; at: string; reason: string }[];
}

/** Latest snapshot that passes its checksum; corrupt ones are skipped and reported (row 91). */
export async function loadLatestValidSnapshot(projectId: string): Promise<LoadedSnapshot | null> {
  const skipped: LoadedSnapshot['skipped'] = [];
  for (const rec of await listSnapshots(projectId)) {
    try {
      const state = await verifySnapshot(rec);
      return { record: rec, state, skipped };
    } catch (e) {
      skipped.push({ id: rec.id, seq: rec.seq, at: rec.at, reason: (e as Error).message });
    }
  }
  return null;
}

/**
 * Deletes journal entries that are no longer needed. Entries newer than the *second-latest*
 * snapshot are kept, so that if the latest snapshot is ever found corrupt the project can still be
 * rebuilt from the previous snapshot plus the journal with no loss (row 91 acceptance).
 */
export async function compactJournal(projectId: string): Promise<number> {
  const db = getDb();
  const snaps = await listSnapshots(projectId);
  if (snaps.length < 2) return 0;
  const keepAfter = snaps[1].seq;
  return db.journal
    .where('[projectId+seq]')
    .between([projectId, -Infinity], [projectId, keepAfter], true, true)
    .delete();
}

/**
 * Retention: last 3 checkpoints; all named points; the last N automatic points plus one per day
 * for D days (row 96). Snapshots needed for journal replay (the two latest) are always kept.
 */
export async function pruneSnapshots(
  projectId: string,
  settings: Pick<AutosaveSettings, 'keepAutoPoints' | 'keepDailyDays'>,
  now = Date.now(),
): Promise<string[]> {
  const snaps = await listSnapshots(projectId);
  const keep = new Set<string>(snaps.slice(0, 2).map((s) => s.id));
  const checkpoints = snaps.filter((s) => s.kind === 'checkpoint');
  checkpoints.slice(0, KEEP_CHECKPOINTS).forEach((s) => keep.add(s.id));
  snaps.filter((s) => s.kind === 'named').forEach((s) => keep.add(s.id));
  const autos = snaps.filter((s) => s.kind === 'auto-restore-point');
  autos.slice(0, settings.keepAutoPoints).forEach((s) => keep.add(s.id));
  const days = new Set<string>();
  for (const s of autos) {
    const t = Date.parse(s.at);
    if (now - t > settings.keepDailyDays * 86400e3) continue;
    const day = s.at.slice(0, 10);
    if (!days.has(day)) {
      days.add(day);
      keep.add(s.id); // newest point of each day (list is newest-first)
    }
  }
  const remove = snaps.filter((s) => !keep.has(s.id)).map((s) => s.id);
  if (remove.length) await getDb().snapshots.bulkDelete(remove);
  return remove;
}

export async function listRestorePoints(projectId: string): Promise<Omit<SnapshotRecord, 'data'>[]> {
  const snaps = await listSnapshots(projectId);
  return snaps
    .filter((s) => s.kind !== 'checkpoint')
    .map(({ data: _d, ...rest }) => {
      void _d;
      return rest;
    });
}

export async function getSnapshot(id: string): Promise<SnapshotRecord | undefined> {
  return getDb().snapshots.get(id);
}

export async function renameRestorePoint(id: string, label: string): Promise<void> {
  await getDb().snapshots.update(id, { label, kind: 'named' });
}
