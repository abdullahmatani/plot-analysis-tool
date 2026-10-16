import { ParseCancelled } from '@/import/parse-client';
import { forImportDialog, parseSource, type ParseOptions, type TableSource } from '@/tables/source';
import type { ImportResult } from '@/tables/table';

/**
 * Parses an import-dialog table source in a Web Worker (rows 21, 62). One worker per parse:
 * `cancel()` terminates it, so a large table that is no longer wanted (another file, sheet or header
 * row chosen, or the dialog closed) stops at once. Without Worker support (unit tests) it parses in
 * place.
 */
export interface TableParseJob {
  promise: Promise<ImportResult>;
  cancel(): void;
}

export function parseTableInWorker(src: TableSource, opts: ParseOptions): TableParseJob {
  if (typeof Worker === 'undefined') {
    let cancelled = false;
    const promise = Promise.resolve().then(() => {
      if (cancelled) throw new ParseCancelled();
      return forImportDialog(parseSource(src, opts));
    });
    return { promise, cancel: () => (cancelled = true) };
  }
  const worker = new Worker(new URL('../../workers/table.worker.ts', import.meta.url), {
    type: 'module',
    name: 'table-parser',
  });
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<ImportResult>((resolve, rej) => {
    reject = rej;
    worker.onmessage = (e: MessageEvent<{ type: string; result?: ImportResult; message?: string }>) => {
      worker.terminate();
      if (e.data.type === 'done') resolve(e.data.result!);
      else rej(new Error(e.data.message ?? 'The table could not be read.'));
    };
    worker.onerror = (e) => {
      worker.terminate();
      rej(new Error(e.message || 'The table reader stopped unexpectedly.'));
    };
  });
  // The dialog keeps the source (to parse again with other options, and for its draft), so it is copied.
  worker.postMessage({ src, opts });
  return {
    promise,
    cancel: () => {
      worker.terminate();
      reject(new ParseCancelled());
    },
  };
}
