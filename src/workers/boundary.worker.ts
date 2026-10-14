/// <reference lib="webworker" />
import { solveBoundary, type BoundaryRequest, type BoundaryResponse } from '@/features/trace/boundary-core';

/** Boundary pick (row 52) off the main thread: arrangement, gap closing and face search. */
self.onmessage = (e: MessageEvent<BoundaryRequest>) => {
  const { id, ...req } = e.data;
  let msg: BoundaryResponse;
  try {
    const r = solveBoundary(req);
    msg = { id, ok: true, result: r.result, prims: r.prims };
  } catch (err) {
    msg = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(msg);
};
