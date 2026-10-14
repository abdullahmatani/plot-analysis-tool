import type { SnapshotKind } from './db';
import { loadProjectState } from './recovery';
import { serializeSnapshot } from './serialize';
import type { AutosaveSettings } from './settings';
import { compactJournal, pruneSnapshots, writeSnapshot } from './snapshots';

/**
 * Builds a snapshot from storage — the latest valid snapshot plus journal replay, exactly the
 * recovery path — so the page never has to clone its in-memory state (NFR-10). Runs in the
 * snapshot worker. It only writes when the replay is complete and contiguous up to `seq`;
 * otherwise it returns a reason and the caller serialises its in-memory state instead.
 */
export async function checkpointFromStorage(args: {
  projectId: string;
  seq: number;
  kind: SnapshotKind;
  label?: string;
  summary?: string;
  settings: AutosaveSettings;
}): Promise<{ record: { id: string; seq: number; at: string; kind: SnapshotKind } } | { fallback: string }> {
  const loaded = await loadProjectState(args.projectId, { uptoSeq: args.seq });
  const r = loaded.report;
  const contiguous = r.replayed === loaded.seq - r.snapshotSeq;
  if (loaded.seq !== args.seq || r.skippedEntries.length || !contiguous || r.migratedFrom !== undefined)
    return {
      fallback: `stored state reaches ${loaded.seq} (expected ${args.seq}); skipped ${r.skippedEntries.length}, contiguous ${contiguous}`,
    };
  const serialized = await serializeSnapshot(loaded.state);
  const rec = await writeSnapshot(args.projectId, args.seq, args.kind, serialized, {
    label: args.label,
    summary: args.summary,
  });
  await compactJournal(args.projectId);
  await pruneSnapshots(args.projectId, args.settings);
  return { record: { id: rec.id, seq: rec.seq, at: rec.at, kind: rec.kind } };
}
