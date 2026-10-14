import type { Affine2D, ContourDataset, Project, Pt } from '@/core/types';
import { unionGeometries } from '@/geometry/boolean';
import { getBlobBytes } from '@/persistence/blobs';
import { useViewStore } from '@/store/view';
import { normaliseAnchorName } from '@/tables/access';
import { computeContours, envelopeInputs, type ContourItem } from '@/tables/contours';
import { sizeStyleFor } from '@/tables/access';
import { useModelsStore } from '@/underlay/models';

import { contourGeometry } from './scene/contours';
import type { ContourEnvelope, ContourSceneInput, DrawingSceneInput, ViewInput } from './scene/types';

/**
 * Main-thread collection of everything an export needs (project snapshot, parsed drawings, contour
 * items, the screen view). The result is structured-cloneable and is sent to the export worker.
 */

export interface ContourExportProvider {
  (project: Project, ds: ContourDataset): { items: ContourItem[]; envelopes: ContourEnvelope[] };
}

/** Default contour computation (same library as the contour overlay). */
export const defaultContourProvider: ContourExportProvider = (project, ds) => {
  const anchors = new Map<string, Pt>(project.anchors.map((a) => [normaliseAnchorName(a.name), a.p]));
  const items = computeContours(ds, { anchors, precision: project.display.precision }).items;
  const envelopes: ContourEnvelope[] = [];
  if (ds.envelope) {
    const chordTol = project.chordTolerance || 0.005;
    for (const input of envelopeInputs(items)) {
      const geometry = unionGeometries(
        input.items.map((it) => contourGeometry(it, chordTol)),
        chordTol,
      );
      if (!geometry) continue;
      const k = ds.mapping.sizeColumns.indexOf(input.sizeColumn);
      const st = sizeStyleFor(ds, input.sizeColumn, Math.max(0, k));
      envelopes.push({
        sizeColumn: input.sizeColumn,
        label: st.legendLabel || input.sizeColumn,
        geometry,
        color: st.color,
        dash: 'solid',
        strokeWidth: Math.max(0.5, st.strokeWidth * 1.6),
      });
    }
  }
  return { items, envelopes };
};

let contourProvider: ContourExportProvider = defaultContourProvider;

/**
 * Lets the contour feature supply exactly what it draws (validation, collision-avoided labels…).
 * Returns a function restoring the default.
 */
export function setContourExportProvider(fn: ContourExportProvider): () => void {
  contourProvider = fn;
  return () => {
    if (contourProvider === fn) contourProvider = defaultContourProvider;
  };
}

export function collectContours(project: Project): ContourSceneInput[] {
  return project.datasets
    .filter((d) => d.visible)
    .map((ds) => {
      try {
        return { datasetId: ds.id, ...contourProvider(project, ds) };
      } catch {
        return { datasetId: ds.id, items: [], envelopes: [] };
      }
    });
}

export function currentView(): ViewInput {
  const s = useViewStore.getState();
  return { ...s.view, width: s.canvasSize.w, height: s.canvasSize.h };
}

export interface CollectOptions {
  /** Read the PDF source bytes (needed to embed PDF pages in a PDF export). */
  pdfBytes?: boolean;
}

export interface CollectedInputs {
  drawings: Record<string, DrawingSceneInput>;
  /** Cache keys (drawing id + model version) for the worker's drawing cache. */
  versions: Record<string, string>;
  contours: ContourSceneInput[];
  view: ViewInput;
  warnings: string[];
}

/** PDF user space → drawing units for a loaded pdf.js page (viewport at scale 1, flipped to y-up). */
export function userToDrawingOf(viewport: { transform: number[]; height: number }): Affine2D {
  const vt = viewport.transform;
  return [vt[0], -vt[1], vt[2], -vt[3], vt[4], viewport.height - vt[5]];
}

export async function collectInputs(project: Project, opts: CollectOptions = {}): Promise<CollectedInputs> {
  const models = useModelsStore.getState().models;
  const drawings: Record<string, DrawingSceneInput> = {};
  const versions: Record<string, string> = {};
  const warnings: string[] = [];
  for (const d of project.drawings) {
    const m = models[d.id];
    if (!m || m.status !== 'ready' || !m.result) {
      if (d.visible) warnings.push(`“${d.name}” is still loading and is left out.`);
      continue;
    }
    const r = m.result;
    versions[d.id] = `${d.id}:${m.version}:${opts.pdfBytes ? 'b' : ''}`;
    if (d.source.kind === 'pdf') {
      if (!m.pdf || !r.page) {
        warnings.push(`“${d.name}” has no PDF page loaded and is left out.`);
        continue;
      }
      const vp = m.pdf.page.getViewport({ scale: 1 });
      const ocgNames: Record<string, string> = {};
      for (const l of r.store.layers) if (l.ocgId) ocgNames[l.ocgId] = l.name;
      const input: DrawingSceneInput = {
        id: d.id,
        pdf: {
          pageIndex: (d.page ?? 1) - 1,
          userToDrawing: userToDrawingOf(vp),
          widthPt: r.page.width,
          heightPt: r.page.height,
          raster: r.page.raster,
          ocgNames,
        },
      };
      if (opts.pdfBytes) {
        const bytes = await getBlobBytes(d.source.blobKey || d.source.sha256);
        if (bytes) input.pdf!.bytes = bytes;
        else warnings.push(`The source file of “${d.name}” is missing; the page is rasterised.`);
      }
      drawings[d.id] = input;
    } else {
      drawings[d.id] = { id: d.id, store: r.store, insunits: r.insunits, extents: r.extents };
    }
  }
  return { drawings, versions, contours: collectContours(project), view: currentView(), warnings };
}
