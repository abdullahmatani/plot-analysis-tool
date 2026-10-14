import type { Bounds } from '@/core/types';
import { canvasController } from '@/render/canvas-controller';
import { getProject } from '@/store/project';

import { datasetContours, rowsBounds } from './compute';

/** Zoom helpers for datasets and rows (row 68: click a row → its contour). */

function zoomTo(b: Bounds | null) {
  const c = canvasController();
  if (!c || !b) return;
  const pad = Math.max(1, (b.maxX - b.minX + b.maxY - b.minY) * 0.05);
  c.zoomToBounds({ minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad });
}

/** Zooms to a dataset's contours (`onlyWithoutDrawings`: only when no drawing defines the view). */
export function zoomToDataset(id: string, onlyWithoutDrawings = false) {
  const p = getProject();
  const ds = p?.datasets.find((d) => d.id === id);
  if (!p || !ds) return;
  if (onlyWithoutDrawings && p.drawings.length > 0) return;
  // Wait a frame so the canvas has the new project state.
  requestAnimationFrame(() => zoomTo(datasetContours(p, ds).bounds));
}

export function zoomToRows(id: string, rows: number[]) {
  const p = getProject();
  const ds = p?.datasets.find((d) => d.id === id);
  if (!p || !ds) return;
  zoomTo(rowsBounds(p, ds, rows));
}
