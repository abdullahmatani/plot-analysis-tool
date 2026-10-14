/// <reference lib="webworker" />
import { isQuotaError, type JournalRecord } from '@/persistence/db';
import { writeJournalBatch, type JournalMeta } from '@/persistence/journal-write';
import { MirrorWriter, opfsMirrorFiles } from '@/persistence/mirror-writer';

/**
 * Journal writer (row 90, NFR-9): records arrive here the moment they are committed and are written
 * to IndexedDB in small batches on this thread's own timer, so a busy main thread (rendering, large
 * imports) cannot delay durability. Each project's batches are committed in order; failures are
 * retried with back-off and reported. Replies: { type: 'ack', projectId, upTo } once records up to
 * `upTo` are durable; { type: 'error', projectId, message, quota, retryInMs } on failure.
 * After each durable batch the records are also appended to the project's backup copy outside
 * IndexedDB (mirror-writer.ts); `rotate` starts a new backup base and `drop` removes the backup.
 */

const BATCH_MS = 100;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

interface Queue {
  records: JournalRecord[];
  meta?: JournalMeta;
  timer: ReturnType<typeof setTimeout> | null;
  writing: boolean;
  retryDelay: number;
  rotate?: boolean;
  drop?: boolean;
}

const queues = new Map<string, Queue>();
const files = opfsMirrorFiles();
const mirror = files ? new MirrorWriter(files) : null;

function queueOf(projectId: string): Queue {
  let q = queues.get(projectId);
  if (!q) queues.set(projectId, (q = { records: [], timer: null, writing: false, retryDelay: 0 }));
  return q;
}

function schedule(projectId: string, q: Queue, delay: number) {
  if (q.timer || q.writing) return;
  q.timer = setTimeout(() => {
    q.timer = null;
    void commit(projectId, q);
  }, delay);
}

async function commit(projectId: string, q: Queue) {
  if (q.writing || !(q.records.length || q.rotate || q.drop)) return;
  q.writing = true;
  const batch = q.records;
  q.records = [];
  try {
    if (batch.length) {
      await writeJournalBatch(projectId, batch, q.meta);
      q.retryDelay = 0;
      post({ type: 'ack', projectId, upTo: batch[batch.length - 1].seq, committedAt: Date.now() });
    }
    await updateMirror(projectId, q, batch);
  } catch (e) {
    q.records = [...batch, ...q.records];
    q.retryDelay = Math.min(30_000, q.retryDelay ? q.retryDelay * 2 : 1000);
    post({
      type: 'error',
      projectId,
      message: (e as Error)?.message ?? String(e),
      quota: isQuotaError(e),
      retryInMs: q.retryDelay,
    });
  } finally {
    q.writing = false;
  }
  if (q.records.length || q.rotate || q.drop) schedule(projectId, q, q.retryDelay || 0);
}

/** Backup copy: failures never hold up the journal (the next write rebuilds the backup). */
async function updateMirror(projectId: string, q: Queue, batch: JournalRecord[]) {
  if (!mirror) {
    q.rotate = q.drop = false;
    return;
  }
  try {
    if (q.drop) {
      q.drop = q.rotate = false;
      await mirror.drop(projectId);
    } else if (q.rotate) {
      q.rotate = false;
      await mirror.rotate(projectId);
    } else if (batch.length) await mirror.append(projectId, batch, q.meta);
  } catch (e) {
    console.warn('backup copy not updated', e);
  }
}

self.onmessage = (
  e: MessageEvent<
    | { type: 'record'; rec: JournalRecord; meta?: JournalMeta }
    | { type: 'flush' | 'rotate' | 'drop'; projectId: string }
  >,
) => {
  const m = e.data;
  if (m.type === 'record') {
    const q = queueOf(m.rec.projectId);
    q.records.push(m.rec);
    if (m.meta) q.meta = m.meta;
    schedule(m.rec.projectId, q, q.retryDelay || BATCH_MS);
  } else if (m.type === 'flush') {
    const q = queueOf(m.projectId);
    if (q.retryDelay) return; // a retry is already scheduled
    if (q.timer) {
      clearTimeout(q.timer);
      q.timer = null;
    }
    void commit(m.projectId, q);
  } else {
    const q = queueOf(m.projectId);
    if (m.type === 'drop') q.drop = true;
    else q.rotate = true;
    schedule(m.projectId, q, q.retryDelay || 0);
  }
};
