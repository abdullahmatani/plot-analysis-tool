import { getDb, type JournalRecord } from './db';

/** Project-list metadata updated with every journal write. */
export interface JournalMeta {
  name: string;
  drawingCount: number;
  objectCount: number;
  blobKeys: string[];
}

/** Appends journal records and updates the project's metadata in one durable transaction (row 90). */
export async function writeJournalBatch(projectId: string, batch: JournalRecord[], meta?: JournalMeta) {
  const db = getDb();
  const last = batch[batch.length - 1];
  await db.transaction('rw', db.journal, db.projects, async () => {
    await db.journal.bulkPut(batch);
    const existing = await db.projects.get(projectId);
    if (existing) {
      await db.projects.put({
        ...existing,
        ...(meta ?? {}),
        updatedAt: last.at,
        lastSeq: Math.max(existing.lastSeq, last.seq),
      });
    }
  });
}
