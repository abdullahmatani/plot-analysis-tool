import { applyOp } from '@/core/history';
import { newId, nowIso } from '@/core/ids';
import type { Project } from '@/core/types';

import { getDb, type RecoveryBinRecord } from './db';
import { storeProjectCopy } from './projects';
import { journalAfter, verifyJournalRecord } from './recovery';
import { loadLatestValidSnapshot } from './snapshots';

/** Recovery bin (row 95): discarded recovery data is kept for 7 days. */

export const BIN_RETENTION_DAYS = 7;

/** Moves journal entries after the latest snapshot, and drafts, into the recovery bin. */
export async function discardRecovery(projectId: string, reason: string): Promise<RecoveryBinRecord | null> {
  const db = getDb();
  const snap = await loadLatestValidSnapshot(projectId);
  const seq = snap?.record.seq ?? -1;
  const entries = await journalAfter(projectId, seq);
  const drafts = await db.drafts.where('projectId').equals(projectId).toArray();
  if (!entries.length && !drafts.length) return null;
  const meta = await db.projects.get(projectId);
  const rec: RecoveryBinRecord = {
    id: newId('bin'),
    projectId,
    projectName: meta?.name ?? 'Project',
    at: nowIso(),
    reason,
    journal: entries,
    drafts,
  };
  await db.transaction('rw', db.recoveryBin, db.journal, db.drafts, async () => {
    await db.recoveryBin.put(rec);
    for (const e of entries) await db.journal.delete([projectId, e.seq]);
    await db.drafts.where('projectId').equals(projectId).delete();
  });
  return rec;
}

export async function listRecoveryBin(): Promise<RecoveryBinRecord[]> {
  await purgeRecoveryBin();
  return (await getDb().recoveryBin.toArray()).sort((a, b) => b.at.localeCompare(a.at));
}

export async function purgeRecoveryBin(now = Date.now()): Promise<number> {
  const db = getDb();
  const cutoff = new Date(now - BIN_RETENTION_DAYS * 86400e3).toISOString();
  return db.recoveryBin.where('at').below(cutoff).delete();
}

/** Rebuilds the discarded edits on top of the project's current latest snapshot, as a new project. */
export async function restoreFromBin(id: string): Promise<Project | null> {
  const db = getDb();
  const rec = await db.recoveryBin.get(id);
  if (!rec) return null;
  const snap = await loadLatestValidSnapshot(rec.projectId);
  if (!snap) return null;
  let state = snap.state;
  for (const e of rec.journal) {
    try {
      state = applyOp(state, verifyJournalRecord(e));
    } catch {
      /* skip entries that no longer apply */
    }
  }
  const copy = await storeProjectCopy(state.project, `${rec.projectName} (recovered)`);
  await db.recoveryBin.delete(id);
  return copy;
}

export { journalAfter };
