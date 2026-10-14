import { quickHash } from '@/core/canonical';
import { applyOp, summariseOps, type HistoryState, type JournalOp } from '@/core/history';
import { migrateProject } from '@/core/migrations';

import { getDb, type JournalRecord } from './db';
import { loadLatestValidSnapshot } from './snapshots';

export interface RecoveryReport {
  snapshotId: string | null;
  snapshotSeq: number;
  snapshotAt: string | null;
  skippedSnapshots: { id: string; seq: number; at: string; reason: string }[];
  replayed: number;
  skippedEntries: { seq: number; at: string; reason: string }[];
  lastSeq: number;
  lastChangeAt: string | null;
  summary: string;
  migratedFrom?: number;
  durationMs: number;
}

export interface LoadedProject {
  state: HistoryState;
  seq: number;
  report: RecoveryReport;
  /** When the stored project used an older schema: the state before migrating (row 87). */
  preMigration?: HistoryState;
}

export async function journalAfter(projectId: string, seq: number): Promise<JournalRecord[]> {
  return getDb()
    .journal.where('[projectId+seq]')
    .between([projectId, seq], [projectId, Infinity], false, true)
    .toArray();
}

export function verifyJournalRecord(rec: JournalRecord): JournalOp {
  if (!rec.op || typeof rec.op !== 'object') throw new Error('Entry is empty');
  if (quickHash(JSON.stringify(rec.op)) !== rec.hash) throw new Error('Entry checksum mismatch');
  return rec.op;
}

/**
 * Recovery (FDR §5.5): load the latest valid snapshot, then replay every journal entry with a higher
 * sequence number. Entries that fail verification or fail to apply are skipped and reported.
 */
export async function loadProjectState(
  projectId: string,
  opts: { checkpointOnly?: boolean; uptoSeq?: number } = {},
): Promise<LoadedProject> {
  const t0 = performance.now();
  const upto = opts.uptoSeq ?? Infinity;
  const snap = await loadLatestValidSnapshot(projectId, upto);
  if (!snap) throw new Error('No readable snapshot was found for this project.');
  let state = snap.state;
  let migratedFrom: number | undefined;
  let preMigration: HistoryState | undefined;
  const entries = opts.checkpointOnly
    ? []
    : (await journalAfter(projectId, snap.record.seq)).filter((r) => r.seq <= upto);
  const skippedEntries: RecoveryReport['skippedEntries'] = [];
  const applied: JournalOp[] = [];
  let seq = snap.record.seq;
  let lastChangeAt: string | null = snap.record.at;
  for (const rec of entries) {
    seq = Math.max(seq, rec.seq);
    try {
      const op = verifyJournalRecord(rec);
      state = applyOp(state, op);
      applied.push(op);
      lastChangeAt = rec.at;
    } catch (e) {
      skippedEntries.push({ seq: rec.seq, at: rec.at, reason: (e as Error).message });
    }
  }
  // Journal entries were recorded against the stored schema, so they are replayed first and the
  // result is migrated afterwards. Undo history cannot be applied across a schema change; the state
  // before the upgrade is kept as a restore point instead (see preserveBeforeMigration).
  const migrated = migrateProject(state.project);
  if (migrated.from !== migrated.project.schemaVersion) {
    migratedFrom = migrated.from;
    preMigration = state;
    state = { project: migrated.project, undo: [], redo: [] };
  } else if (migrated.project !== state.project) {
    // Same schema, newer optional fields filled with defaults: history stays valid.
    state = { ...state, project: migrated.project };
  }
  return {
    state,
    seq,
    preMigration,
    report: {
      snapshotId: snap.record.id,
      snapshotSeq: snap.record.seq,
      snapshotAt: snap.record.at,
      skippedSnapshots: snap.skipped,
      replayed: applied.length,
      skippedEntries,
      lastSeq: seq,
      lastChangeAt,
      summary: summariseOps(applied),
      migratedFrom,
      durationMs: performance.now() - t0,
    },
  };
}

/** What would be recovered for a project: journal entries after the latest snapshot, and drafts. */
export async function pendingRecovery(
  projectId: string,
): Promise<{ entries: JournalRecord[]; drafts: number; summary: string; lastChangeAt: string | null }> {
  const db = getDb();
  const snaps = await db.snapshots.where('projectId').equals(projectId).toArray();
  const latestSeq = snaps.reduce((m, s) => Math.max(m, s.seq), -1);
  const entries = await journalAfter(projectId, latestSeq);
  const drafts = await db.drafts.where('projectId').equals(projectId).count();
  const ops: JournalOp[] = [];
  for (const e of entries) {
    try {
      ops.push(verifyJournalRecord(e));
    } catch {
      /* counted but not summarised */
    }
  }
  return { entries, drafts, summary: summariseOps(ops), lastChangeAt: entries.at(-1)?.at ?? null };
}
