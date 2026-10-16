/// <reference lib="webworker" />
import { forImportDialog, parseSource, type ParseOptions, type TableSource } from '@/tables/source';

/**
 * Table parsing off the main thread (rows 21, 62): CSV, TSV, XLSX and pasted ranges. A 5 000-row
 * XLSX takes about 150 ms to read and a 200 000-row one several seconds, which would freeze the UI
 * (NFR-2: no main-thread block over 100 ms). In `{ src, opts }`; out `{ type: 'done', result }` or
 * `{ type: 'error', message }`. The client terminates the worker to cancel.
 */
self.onmessage = (e: MessageEvent<{ src: TableSource; opts: ParseOptions }>) => {
  const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);
  try {
    post({ type: 'done', result: forImportDialog(parseSource(e.data.src, e.data.opts)) });
  } catch (err) {
    post({ type: 'error', message: (err as Error)?.message ?? String(err) });
  }
};
