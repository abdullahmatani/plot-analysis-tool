import type { Project, Pt } from '@/core/types';
import type { BoundaryOptions, BoundaryResult } from '@/tracing/boundary';

import {
  packEntities,
  packedTransferables,
  type BoundaryRequest,
  type BoundaryResponse,
  type PackedDrawing,
} from './boundary-core';
import { entityTraceable, vectorSources } from './underlay';

/**
 * Main-thread side of boundary pick (row 52): collects the visible vector geometry, runs the
 * detection in a module worker and supports cancellation (the worker is terminated, so even a
 * long arrangement stops at once; a fresh worker is created for the next pick).
 */

export class BoundaryCancelled extends Error {
  constructor() {
    super('Boundary detection cancelled');
  }
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: BoundaryResponse) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('../../workers/boundary.worker.ts', import.meta.url), {
    type: 'module',
    name: 'boundary-pick',
  });
  w.onmessage = (e: MessageEvent<BoundaryResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    p.resolve(e.data);
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Boundary worker failed'));
    pending.clear();
    w.terminate();
    if (worker === w) worker = null;
  };
  worker = w;
  return w;
}

/** Visible traceable geometry of every visible vector drawing, packed for the worker. */
export function collectVisibleGeometry(project: Project): { drawings: PackedDrawing[]; entities: number } {
  const drawings: PackedDrawing[] = [];
  let entities = 0;
  for (const s of vectorSources(project)) {
    const ids: number[] = [];
    for (let i = 0; i < s.store.count; i++) if (entityTraceable(s, i)) ids.push(i);
    if (!ids.length) continue;
    entities += ids.length;
    drawings.push(packEntities(s.store, ids, s.placement));
  }
  return { drawings, entities };
}

export interface BoundaryJob {
  promise: Promise<{ result: BoundaryResult | null; prims: number }>;
  cancel(): void;
}

export function detectBoundary(drawings: PackedDrawing[], pick: Pt, opts: BoundaryOptions): BoundaryJob {
  const id = nextId++;
  const w = getWorker();
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<{ result: BoundaryResult | null; prims: number }>((resolve, reject) => {
    rejectFn = reject;
    pending.set(id, {
      resolve: (r) => (r.ok ? resolve({ result: r.result, prims: r.prims }) : reject(new Error(r.error))),
      reject,
    });
    const req: BoundaryRequest = { id, pick, drawings, opts };
    w.postMessage(req, drawings.flatMap(packedTransferables));
  });
  return {
    promise,
    cancel: () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      // Terminating stops a long synchronous computation immediately; other pending picks fail too.
      w.terminate();
      if (worker === w) worker = null;
      for (const p of pending.values()) p.reject(new BoundaryCancelled());
      pending.clear();
      rejectFn(new BoundaryCancelled());
    },
  };
}
