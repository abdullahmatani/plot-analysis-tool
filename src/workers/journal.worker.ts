/// <reference lib="webworker" />
import { isQuotaError, type JournalRecord } from '@/persistence/db';
import { writeJournalBatch, type JournalMeta } from '@/persistence/journal-write';

/**
 * Journal writer (row 90, NFR-9): records arrive here the moment they are committed and are written
 * to IndexedDB in small batches on this thread's own timer, so a busy main thread (rendering, large
 * imports) cannot delay durability. Each project's batches are committed in order; failures are
 * retried with back-off and reported. Replies: { type: 'ack', projectId, upTo } once records up to
 * `upTo` are durable; { type: 'error', projectId, message, quota, retryInMs } on failure.
 */

const BATCH_MS = 100;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

interface Queue {
  records: JournalRecord[];
  meta?: JournalMeta;
  timer: ReturnType<typeof setTimeout> | null;
  writing: boolean;
  retryDelay: number;
}

const queues = new Map<string, Queue>();

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
  if (q.writing || !q.records.length) return;
  q.writing = true;
  const batch = q.records;
  q.records = [];
  try {
    await writeJournalBatch(projectId, batch, q.meta);
    q.retryDelay = 0;
    post({ type: 'ack', projectId, upTo: batch[batch.length - 1].seq, committedAt: Date.now() });
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
  if (q.records.length) schedule(projectId, q, q.retryDelay || 0);
}

self.onmessage = (
  e: MessageEvent<
    { type: 'record'; rec: JournalRecord; meta?: JournalMeta } | { type: 'flush'; projectId: string }
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
  }
};
