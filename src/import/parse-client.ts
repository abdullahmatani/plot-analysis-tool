import type { DrawingKind } from '@/core/types';
import type { DrawingParseResult } from '@/underlay/entity-store';
import type { RenderData } from '@/underlay/render-data';

/**
 * Runs drawing parsers in Web Workers (row 21) with progress and cancellation. Cancelling terminates
 * the worker, so even a parser stuck in a long synchronous loop stops immediately.
 */

export interface ParseOutput {
  result: DrawingParseResult;
  render: RenderData;
  pageCount?: number;
}

export class ParseCancelled extends Error {
  constructor() {
    super('Import cancelled');
  }
}

export interface ParseJob {
  promise: Promise<ParseOutput>;
  cancel(): void;
}

function workerFor(kind: DrawingKind): Worker {
  switch (kind) {
    case 'dxf':
      return new Worker(new URL('../workers/cad.worker.ts', import.meta.url), {
        type: 'module',
        name: 'dxf-parser',
      });
    case 'dwg':
      // GPL-3.0 LibreDWG lives only in this separately bundled worker (row 25, decision D-1).
      return new Worker(new URL('../workers/dwg.worker.ts', import.meta.url), {
        type: 'module',
        name: 'dwg-parser',
      });
    case 'pdf':
      return new Worker(new URL('../workers/pdf-extract.worker.ts', import.meta.url), {
        type: 'module',
        name: 'pdf-vectors',
      });
  }
}

export function parseInWorker(
  kind: DrawingKind,
  bytes: Uint8Array,
  opts: { page?: number; layout?: string; assetBase?: string },
  onProgress: (fraction: number, message?: string) => void,
): ParseJob {
  const worker = workerFor(kind);
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<ParseOutput>((resolve, rej) => {
    reject = rej;
    worker.onmessage = (
      e: MessageEvent<{
        type: string;
        fraction?: number;
        message?: string;
        result?: DrawingParseResult;
        render?: RenderData;
        pageCount?: number;
        name?: string;
      }>,
    ) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.fraction ?? 0, m.message);
      else if (m.type === 'done') {
        worker.terminate();
        resolve({ result: m.result!, render: m.render!, pageCount: m.pageCount });
      } else if (m.type === 'error') {
        worker.terminate();
        const err = new Error(m.message ?? 'The drawing could not be read.');
        err.name = m.name ?? 'Error';
        rej(err);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      rej(new Error(e.message || 'The parser stopped unexpectedly.'));
    };
  });
  const copy = bytes.slice();
  worker.postMessage({ bytes: copy, page: opts.page ?? 1, layout: opts.layout, assetBase: opts.assetBase }, [
    copy.buffer,
  ]);
  return {
    promise,
    cancel: () => {
      worker.terminate();
      reject(new ParseCancelled());
    },
  };
}
