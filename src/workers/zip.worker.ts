/// <reference lib="webworker" />
import { unzipSync, zipSync, type Zippable } from 'fflate';

/** Zip/unzip off the main thread (project files, offline bundle). */
self.onmessage = (
  e: MessageEvent<
    { id: number; kind: 'zip'; files: Zippable } | { id: number; kind: 'unzip'; bytes: Uint8Array }
  >,
) => {
  const msg = e.data;
  try {
    if (msg.kind === 'zip') {
      const out = zipSync(msg.files, { level: 6 });
      (self as unknown as Worker).postMessage({ id: msg.id, ok: true, result: out }, [out.buffer]);
    } else {
      const files = unzipSync(msg.bytes);
      const transfer = Object.values(files).map((f) => f.buffer as ArrayBuffer);
      (self as unknown as Worker).postMessage({ id: msg.id, ok: true, result: files }, transfer);
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      ok: false,
      error: String((err as Error)?.message ?? err),
    });
  }
};
