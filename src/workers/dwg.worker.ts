/// <reference lib="webworker" />
import { DWG_FALLBACK_GUIDANCE, type DwgErrorCode } from '@/import/dwg/errors';
import { MAX_DWG_BYTES, dwgTimeLimitMs } from '@/import/dwg/limits';
import { dwgVersionInfo, readDwgVersionCode, unsupportedVersionMessage } from '@/import/dwg/version';
import { storeTransferables, type DrawingParseResult } from '@/underlay/entity-store';
import { buildRenderData, renderDataTransferables } from '@/underlay/render-data';

/**
 * DWG import worker (rows 21–23, 25; decision D-1). Same protocol as the DXF worker
 * (`cad.worker.ts`): in `{ bytes, layout? }`; out `{ type: 'progress', fraction, message }`,
 * `{ type: 'done', result, render }` (with transferables) or `{ type: 'error', message, name }`
 * (plus `code`, a {@link DwgErrorCode}). `timeLimitMs` in the input overrides the time limit
 * (tests/diagnostics).
 *
 * LibreDWG (GPL-3.0) is not bundled here: it runs in a child worker (`libredwg.worker.ts`) that this
 * worker terminates when it exceeds the time limit, crashes or finishes. So a damaged DWG can never
 * hang the import, and LibreDWG's WebAssembly memory is released before render data is built.
 */
const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

const fail = (message: string, code: DwgErrorCode) =>
  post({ type: 'error', name: 'DwgReadError', code, message });

interface ChildMessage {
  type: 'progress' | 'done' | 'error';
  fraction?: number;
  message?: string;
  name?: string;
  code?: string;
  result?: DrawingParseResult;
}

self.onmessage = (e: MessageEvent<{ bytes: Uint8Array; layout?: string; timeLimitMs?: number }>) => {
  const { bytes, layout, timeLimitMs } = e.data;

  // Checks that need no DWG reader: answer at once instead of loading 10 MB of WebAssembly.
  if (!bytes?.byteLength) return fail('The file is empty.', 'not-dwg');
  const code = readDwgVersionCode(bytes);
  if (!code)
    return fail('Not a DWG file: it does not start with an AutoCAD format code such as "AC1032".', 'not-dwg');
  const info = dwgVersionInfo(code);
  if (info.status === 'newer' || info.status === 'unknown')
    return fail(unsupportedVersionMessage(info), 'unsupported-version');
  if (bytes.byteLength > MAX_DWG_BYTES) {
    return fail(
      `This DWG is ${(bytes.byteLength / 1024 / 1024).toFixed(0)} MB, more than the ${MAX_DWG_BYTES / 1024 / 1024} MB the in-browser DWG reader can handle. ${DWG_FALLBACK_GUIDANCE}`,
      'too-large',
    );
  }

  post({ type: 'progress', fraction: 0, message: 'Starting DWG reader…' });
  let child: Worker;
  try {
    child = new Worker(new URL('../import/dwg/libredwg.worker.ts', import.meta.url), {
      type: 'module',
      name: 'libredwg',
    });
  } catch (err) {
    return fail(
      `The DWG reader could not be started in this browser (${(err as Error)?.message ?? err}). ${DWG_FALLBACK_GUIDANCE}`,
      'reader-unavailable',
    );
  }

  let finished = false;
  const limit = timeLimitMs && timeLimitMs > 0 ? timeLimitMs : dwgTimeLimitMs(bytes.byteLength);
  const finish = () => {
    finished = true;
    clearTimeout(timer);
    child.terminate();
  };
  const timer = setTimeout(() => {
    if (finished) return;
    finish();
    fail(
      `Reading the DWG took longer than ${Math.max(1, Math.round(limit / 1000))} s and was stopped. The file may be damaged or too complex for the in-browser DWG reader. ${DWG_FALLBACK_GUIDANCE}`,
      'timeout',
    );
  }, limit);

  child.onmessage = (m: MessageEvent<ChildMessage>) => {
    if (finished) return;
    const d = m.data;
    if (d.type === 'progress') {
      post({ type: 'progress', fraction: (d.fraction ?? 0) * 0.85, message: d.message ?? 'Reading DWG…' });
    } else if (d.type === 'error') {
      finish();
      post({ type: 'error', message: d.message, name: d.name ?? 'DwgReadError', code: d.code });
    } else if (d.type === 'done' && d.result) {
      finish();
      try {
        post({ type: 'progress', fraction: 0.9, message: 'Preparing display…' });
        const result = d.result;
        const render = buildRenderData(result.store, result.extents);
        post({ type: 'done', result, render }, [
          ...storeTransferables(result.store),
          ...renderDataTransferables(render),
        ]);
      } catch (err) {
        post({ type: 'error', message: (err as Error)?.message ?? String(err), name: (err as Error)?.name });
      }
    }
  };
  child.onerror = (ev: ErrorEvent) => {
    ev.preventDefault();
    if (finished) return;
    finish();
    fail(
      `The DWG reader stopped unexpectedly${ev.message ? ` (${ev.message})` : ''}. ${DWG_FALLBACK_GUIDANCE}`,
      'reader-crashed',
    );
  };
  child.onmessageerror = () => {
    if (finished) return;
    finish();
    fail(
      `The DWG reader returned data that could not be received. ${DWG_FALLBACK_GUIDANCE}`,
      'reader-crashed',
    );
  };
  child.postMessage({ bytes, layout }, [bytes.buffer]);
};
