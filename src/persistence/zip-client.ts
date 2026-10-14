import { unzipSync, zipSync, type Zippable } from 'fflate';

type Pending = { resolve: (v: never) => void; reject: (e: Error) => void };
let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/zip.worker.ts', import.meta.url), {
      type: 'module',
      name: 'zip',
    });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.ok) w.resolve(e.data.result as never);
      else w.reject(new Error(e.data.error));
    };
    worker.onerror = () => {
      for (const w of waiting.values()) w.reject(new Error('Zip worker failed'));
      waiting.clear();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

function call<T>(msg: Record<string, unknown>, transfer: Transferable[]): Promise<T> {
  const w = getWorker()!;
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: never) => void, reject });
    w.postMessage({ ...msg, id }, transfer);
  });
}

export async function zipFiles(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  if (!getWorker()) return zipSync(files as Zippable, { level: 6 });
  // Copy so callers keep their buffers (transfer would detach them).
  const copy: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) copy[k] = v.slice();
  return call<Uint8Array>(
    { kind: 'zip', files: copy },
    Object.values(copy).map((v) => v.buffer),
  );
}

export async function unzipFiles(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  if (!getWorker()) return unzipSync(bytes);
  const copy = bytes.slice();
  return call<Record<string, Uint8Array>>({ kind: 'unzip', bytes: copy }, [copy.buffer]);
}
