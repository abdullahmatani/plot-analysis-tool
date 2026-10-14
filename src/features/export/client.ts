import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import type { Project } from '@/core/types';
import { getModel } from '@/underlay/models';

import { fontBase } from './fonts-loader';
import { collectInputs } from './inputs';
import type { DoneMessage, FromWorker, JobKind, JobMessage, TileRequestMessage } from './protocol';
import type { DrawingSceneInput } from './scene/types';
import type { ExportSettings } from './settings';

/**
 * Main-thread side of the export worker (rows 77–81): collects the inputs, runs jobs with progress
 * and cancellation, and renders PDF underlay pages for raster outputs with the drawing's pdf.js page
 * (the same renderer as the canvas).
 */

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'AbortError';
  }
}

export interface JobHandle {
  promise: Promise<DoneMessage>;
  cancel(): void;
}

interface Pending {
  resolve: (m: DoneMessage) => void;
  reject: (e: Error) => void;
  onProgress?: (fraction: number, message?: string) => void;
}

function createWorker(): Worker {
  return new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module', name: 'export' });
}

// ---- PDF tiles (pdf.js on the main thread) ----

const ocConfigs = new Map<string, Promise<unknown>>();

async function ocConfigFor(drawingId: string, hidden: string[]): Promise<unknown> {
  const m = getModel(drawingId);
  if (!m?.pdf || !hidden.length) return undefined;
  const key = `${drawingId}:${m.version}:${hidden.join('\u0000')}`;
  let p = ocConfigs.get(key);
  if (!p) {
    p = m.pdf.doc.getOptionalContentConfig().then((cfg) => {
      for (const [id, group] of cfg) {
        const name = (group as { name?: string }).name ?? id;
        cfg.setVisibility(id, !(hidden.includes(name) || hidden.includes(id)));
      }
      return cfg;
    });
    ocConfigs.set(key, p);
  }
  return p;
}

let tileQueue: Promise<unknown> = Promise.resolve();

/** Renders a PDF page region for the worker (serialised: one pdf.js render at a time). */
function renderTile(req: TileRequestMessage): Promise<ImageBitmap | null> {
  const job = tileQueue.then(async () => {
    const m = getModel(req.drawingId);
    if (!m?.pdf) return null;
    const page = m.pdf.page;
    const viewport = page.getViewport({ scale: 1 });
    const V = viewport.transform as number[];
    // pdf.js applies `transform` after the viewport transform: device = transform ∘ V.
    const det = V[0] * V[3] - V[1] * V[2];
    const inv = [
      V[3] / det,
      -V[1] / det,
      -V[2] / det,
      V[0] / det,
      (V[2] * V[5] - V[3] * V[4]) / det,
      (V[1] * V[4] - V[0] * V[5]) / det,
    ];
    const T = req.transform;
    const X = [
      T[0] * inv[0] + T[2] * inv[1],
      T[1] * inv[0] + T[3] * inv[1],
      T[0] * inv[2] + T[2] * inv[3],
      T[1] * inv[2] + T[3] * inv[3],
      T[0] * inv[4] + T[2] * inv[5] + T[4],
      T[1] * inv[4] + T[3] * inv[5] + T[5],
    ];
    const canvas = document.createElement('canvas');
    canvas.width = req.width;
    canvas.height = req.height;
    const oc = await ocConfigFor(req.drawingId, req.hiddenLayers);
    await page.render({
      canvas,
      viewport,
      transform: X,
      background: 'rgba(0,0,0,0)',
      annotationMode: pdfjs.AnnotationMode.DISABLE,
      ...(oc ? { optionalContentConfigPromise: Promise.resolve(oc) as never } : {}),
    }).promise;
    const bmp = await createImageBitmap(canvas);
    canvas.width = canvas.height = 0;
    return bmp;
  });
  tileQueue = job.catch(() => null);
  return job.catch(() => null);
}

// ---- worker client ----

export class ExportClient {
  private worker: Worker | null = null;
  private sent = new Set<string>();
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private readonly persistent: boolean) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = createWorker();
    w.onmessage = (e: MessageEvent<FromWorker>) => void this.onMessage(w, e.data);
    w.onerror = (e) => {
      const err = new Error(e.message || 'The export stopped unexpectedly.');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.reset();
    };
    this.worker = w;
    this.sent.clear();
    return w;
  }

  private async onMessage(w: Worker, m: FromWorker) {
    if (m.type === 'tile-request') {
      const bitmap = await renderTile(m);
      if (this.worker !== w) {
        bitmap?.close();
        return;
      }
      w.postMessage({ type: 'tile', reqId: m.reqId, bitmap }, bitmap ? [bitmap] : []);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) {
      if (m.type === 'done') m.preview?.close();
      return;
    }
    if (m.type === 'progress') p.onProgress?.(m.fraction, m.message);
    else if (m.type === 'done') {
      this.pending.delete(m.id);
      p.resolve(m);
      if (!this.persistent) this.reset();
    } else if (m.type === 'error') {
      this.pending.delete(m.id);
      const err = m.name === 'AbortError' ? new ExportCancelled() : new Error(m.message);
      p.reject(err);
      if (!this.persistent) this.reset();
    }
  }

  private reset() {
    this.worker?.terminate();
    this.worker = null;
    this.sent.clear();
  }

  /** Runs a job; drawings already sent to this worker are referenced by cache key. */
  async run(
    kind: JobKind,
    project: Project,
    settings: ExportSettings,
    opts: { previewPx?: number; onProgress?: (fraction: number, message?: string) => void } = {},
  ): Promise<JobHandle> {
    const inputs = await collectInputs(project, {
      pdfBytes: kind === 'export' && settings.format === 'pdf' && settings.includeUnderlay,
    });
    const w = this.ensure();
    const id = this.nextId++;
    const drawings: JobMessage['drawings'] = {};
    const versions: Record<string, string> = {};
    for (const [did, input] of Object.entries(inputs.drawings) as [string, DrawingSceneInput][]) {
      const key = inputs.versions[did];
      if (this.persistent && key && this.sent.has(key)) drawings[did] = { cached: key };
      else {
        drawings[did] = input;
        if (this.persistent && key) {
          versions[did] = key;
          this.sent.add(key);
        }
      }
    }
    const msg: JobMessage = {
      type: 'job',
      id,
      kind,
      settings,
      project,
      drawings,
      versions,
      contours: inputs.contours,
      view: inputs.view,
      fontBase: fontBase(),
      previewPx: opts.previewPx,
    };
    const promise = new Promise<DoneMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: opts.onProgress });
    }).then((d) => {
      d.info.warnings.unshift(...inputs.warnings);
      return d;
    });
    w.postMessage(msg);
    return {
      promise,
      cancel: () => {
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (this.persistent) w.postMessage({ type: 'cancel', id });
        else this.reset();
        p?.reject(new ExportCancelled());
      },
    };
  }

  dispose() {
    for (const p of this.pending.values()) p.reject(new ExportCancelled());
    this.pending.clear();
    this.reset();
  }
}

let previewClient: ExportClient | null = null;

/** Shared persistent worker for previews (keeps parsed drawings cached). */
export function previewWorker(): ExportClient {
  previewClient ??= new ExportClient(true);
  return previewClient;
}

/** Runs one file export in a fresh worker (cancel terminates it). */
export function exportJob(
  project: Project,
  settings: ExportSettings,
  onProgress?: (fraction: number, message?: string) => void,
): JobHandle {
  const client = new ExportClient(false);
  let handle: JobHandle | null = null;
  let cancelled = false;
  const promise = client.run('export', project, settings, { onProgress }).then((h) => {
    handle = h;
    if (cancelled) h.cancel();
    return h.promise;
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (handle) handle.cancel();
      else client.dispose();
    },
  };
}
