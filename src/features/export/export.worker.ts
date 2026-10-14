/// <reference lib="webworker" />
import { multiply } from '@/core/affine';
import type { Affine2D } from '@/core/types';
import { canvasSizeForDpi } from '@/export/canvas-backend';
import type { FontSet } from '@/export/fonts';
import { renderScenePdf } from '@/export/pdf-backend';
import type { PdfPageItem, Scene } from '@/export/scene';
import { renderSceneSvg } from '@/export/svg-backend';
import { buildLegend } from '@/features/legend/legend-model';

import { buildAnalysisDxf } from './dxf-export';
import { loadFontSet } from './fonts-loader';
import type { DoneMessage, FromWorker, JobMessage, PreviewInfo, ToWorker } from './protocol';
import { RasterCancelled, renderScenePng, renderSceneToCanvas, type TileRequest } from './raster';
import { buildProjectScene, computeLayout, type ProjectSceneResult } from './scene/project-scene';
import type { DrawingSceneInput, ProjectSceneInput } from './scene/types';
import { effectiveRegion } from './settings';
import { exportCsv, exportXlsx } from './tabular';

/**
 * Export worker (rows 77–81, §5.3): builds the scene and runs the PDF, SVG, PNG, DXF, CSV and XLSX
 * writers off the main thread, reporting progress. PDF underlay pages are rasterised on request by
 * the main thread (pdf.js renders there); everything else happens here. Cancelling a file export
 * terminates the worker; previews are superseded by newer jobs.
 */

const post = (msg: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

const drawingCache = new Map<string, DrawingSceneInput>();
const tileWaiters = new Map<number, (b: ImageBitmap | null) => void>();
let nextReq = 1;
let latestPreview = 0;
const cancelled = new Set<number>();

function resolveDrawings(m: JobMessage): Record<string, DrawingSceneInput> {
  const out: Record<string, DrawingSceneInput> = {};
  for (const [id, v] of Object.entries(m.drawings)) {
    if ('cached' in v) {
      const c = drawingCache.get(v.cached);
      if (c) out[id] = c;
    } else {
      out[id] = v;
      const key = m.versions[id];
      if (key) {
        for (const k of [...drawingCache.keys()]) if (k.startsWith(`${id}:`)) drawingCache.delete(k);
        drawingCache.set(key, v);
      }
    }
  }
  return out;
}

function requestTile(
  jobId: number,
  scene: ProjectSceneResult,
  req: TileRequest,
): Promise<ImageBitmap | null> {
  const ref = scene.pdfItems.find((p) => p.item === req.item);
  if (!ref) return Promise.resolve(null);
  const k = req.pxPerMm;
  // PDF user space → tile pixels.
  const transform: Affine2D = multiply([k, 0, 0, k, -req.x0, -req.y0], req.item.transform);
  const reqId = nextReq++;
  return new Promise((resolve) => {
    tileWaiters.set(reqId, resolve);
    post({
      type: 'tile-request',
      id: jobId,
      reqId,
      drawingId: ref.drawingId,
      transform,
      width: req.width,
      height: req.height,
      hiddenLayers: req.item.hiddenLayers ?? [],
    });
  });
}

async function bitmapToPng(b: ImageBitmap): Promise<Uint8Array> {
  const c = new OffscreenCanvas(b.width, b.height);
  c.getContext('2d')!.drawImage(b, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Raster stand-ins of embedded PDF pages for SVG (cropped to the map viewport). */
async function addSvgFallbacks(jobId: number, r: ProjectSceneResult, dpi: number): Promise<void> {
  const vp = r.layout.viewport;
  const maxPx = 16e6;
  let pxPerMm = Math.min(dpi, 300) / 25.4;
  if (vp.w * vp.h * pxPerMm * pxPerMm > maxPx) pxPerMm = Math.sqrt(maxPx / (vp.w * vp.h));
  for (const ref of r.pdfItems) {
    const item: PdfPageItem = ref.item;
    const x0 = Math.floor(vp.x * pxPerMm);
    const y0 = Math.floor(vp.y * pxPerMm);
    const width = Math.max(1, Math.ceil(vp.w * pxPerMm));
    const height = Math.max(1, Math.ceil(vp.h * pxPerMm));
    const bmp = await requestTile(jobId, r, { item, x0, y0, width, height, pxPerMm });
    if (!bmp) continue;
    item.fallbackPng = {
      png: await bitmapToPng(bmp),
      x: x0 / pxPerMm,
      y: y0 / pxPerMm,
      w: width / pxPerMm,
      h: height / pxPerMm,
    };
    bmp.close();
  }
}

const enc = new TextEncoder();

async function run(m: JobMessage): Promise<void> {
  const t0 = performance.now();
  const id = m.id;
  if (m.kind === 'preview') latestPreview = id;
  const isCancelled = () => cancelled.has(id) || (m.kind === 'preview' && latestPreview !== id);
  const progress = (fraction: number, message?: string) => post({ type: 'progress', id, fraction, message });
  progress(0.02, 'Loading fonts…');
  let fonts: FontSet | undefined;
  try {
    fonts = await loadFontSet(m.fontBase);
  } catch {
    fonts = undefined;
  }
  const input: ProjectSceneInput = {
    project: m.project,
    settings: m.kind === 'preview' ? m.settings : { ...m.settings, region: effectiveRegion(m.settings) },
    drawings: resolveDrawings(m),
    contours: m.contours,
    view: m.view,
    fonts,
  };
  const format = m.settings.format;
  const graphic = m.kind === 'preview' || format === 'pdf' || format === 'png' || format === 'svg';
  let result: ProjectSceneResult | null = null;
  if (graphic) {
    progress(0.08, 'Building sheet…');
    result = buildProjectScene(input);
  }
  if (isCancelled()) throw new RasterCancelled();
  const layout = result?.layout ?? computeLayout(input);
  const scene: Scene | null = result?.scene ?? null;
  const pngSize = scene ? canvasSizeForDpi(scene, m.settings.dpi) : { width: 0, height: 0 };
  const info: PreviewInfo = {
    layout,
    legend: result?.legend ?? buildLegend(m.project, { contours: m.contours }),
    calibration: result?.calibration ?? [],
    warnings: result?.warnings ?? [],
    pngSize: { width: pngSize.width, height: pngSize.height },
    pxPerMm: 0,
  };
  const done = (msg: Omit<DoneMessage, 'type' | 'id' | 'info' | 'ms'>, transfer: Transferable[] = []) =>
    post({ type: 'done', id, info, ms: performance.now() - t0, ...msg }, transfer);

  if (m.kind === 'preview') {
    const r = result!;
    const px = Math.max(64, Math.min(4096, m.previewPx ?? 1200));
    const pxPerMm = px / Math.max(r.scene.widthMm, r.scene.heightMm);
    info.pxPerMm = pxPerMm;
    const canvas = (await renderSceneToCanvas(r.scene, pxPerMm, {
      fonts,
      pdfTiles: (req) => requestTile(id, r, req),
      isCancelled,
    })) as OffscreenCanvas;
    if (isCancelled()) throw new RasterCancelled();
    const bitmap = canvas.transferToImageBitmap();
    done({ preview: bitmap }, [bitmap]);
    return;
  }

  switch (format) {
    case 'pdf': {
      progress(0.3, 'Writing PDF…');
      const warnings: string[] = [];
      const bytes = await renderScenePdf(result!.scene, {
        fonts: fonts!,
        onWarning: (w) => warnings.push(w),
      });
      info.warnings.push(...warnings);
      done({ parts: [bytes], mime: 'application/pdf' }, [bytes.buffer]);
      return;
    }
    case 'svg': {
      progress(0.2, 'Rendering underlay pages…');
      await addSvgFallbacks(id, result!, m.settings.dpi);
      progress(0.6, 'Writing SVG…');
      const svg = renderSceneSvg(result!.scene, {
        fonts,
        textAsPaths: !!m.settings.svgTextAsPaths && !!fonts,
      });
      const bytes = enc.encode(svg);
      done({ parts: [bytes], mime: 'image/svg+xml' }, [bytes.buffer]);
      return;
    }
    case 'png': {
      const r = result!;
      const png = await renderScenePng(r.scene, m.settings.dpi, {
        fonts,
        pdfTiles: (req) => requestTile(id, r, req),
        isCancelled,
        onProgress: (f) => progress(0.1 + 0.88 * f, 'Rendering image…'),
      });
      done({ parts: png.parts, mime: 'image/png' }, [...new Set(png.parts.map((p) => p.buffer))]);
      return;
    }
    case 'dxf': {
      progress(0.3, 'Writing DXF…');
      const r = buildAnalysisDxf({ ...input, fonts });
      info.warnings.push(...r.warnings);
      done({ parts: [r.bytes], mime: 'application/dxf' }, [r.bytes.buffer]);
      return;
    }
    case 'csv': {
      const bytes = enc.encode(exportCsv(m.project, m.settings, m.contours));
      done({ parts: [bytes], mime: 'text/csv' }, [bytes.buffer]);
      return;
    }
    case 'xlsx': {
      const bytes = exportXlsx(m.project, m.settings, m.contours);
      done({ parts: [bytes], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, [
        bytes.buffer,
      ]);
      return;
    }
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'tile') {
    const w = tileWaiters.get(m.reqId);
    tileWaiters.delete(m.reqId);
    w?.(m.bitmap);
    return;
  }
  if (m.type === 'cancel') {
    cancelled.add(m.id);
    return;
  }
  run(m).catch((err: Error) => {
    post({ type: 'error', id: m.id, message: err?.message ?? String(err), name: err?.name });
  });
};
