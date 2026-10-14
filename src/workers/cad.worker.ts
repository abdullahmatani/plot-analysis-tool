/// <reference lib="webworker" />
import { parseDxf } from '@/import/dxf';
import { storeTransferables } from '@/underlay/entity-store';
import { buildRenderData, renderDataTransferables } from '@/underlay/render-data';

/** DXF parsing + render-data building off the main thread (rows 14, 21; NFR-2). */
const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<{ bytes: Uint8Array; layout?: string }>) => {
  try {
    const result = parseDxf(e.data.bytes, {
      layout: e.data.layout,
      onProgress: (f) => post({ type: 'progress', fraction: f * 0.85, message: 'Reading DXF…' }),
    });
    post({ type: 'progress', fraction: 0.9, message: 'Preparing display…' });
    const render = buildRenderData(result.store, result.extents);
    post({ type: 'done', result, render }, [
      ...storeTransferables(result.store),
      ...renderDataTransferables(render),
    ]);
  } catch (err) {
    post({ type: 'error', message: (err as Error)?.message ?? String(err), name: (err as Error)?.name });
  }
};
