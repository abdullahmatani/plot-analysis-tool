/// <reference lib="webworker" />
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// Importing the pdf.js worker module registers `globalThis.pdfjsWorker`, so pdf.js runs its parser
// in this (our) worker thread instead of spawning another one.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';

import type { Affine2D } from '@/core/types';
import { extractPdfVectors, type PdfOps } from '@/import/pdf/extract';
import { storeTransferables } from '@/underlay/entity-store';
import { buildRenderData, renderDataTransferables } from '@/underlay/render-data';

interface Req {
  bytes: Uint8Array;
  page: number;
  assetBase: string;
}

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<Req>) => {
  const { bytes, page: pageNumber, assetBase } = e.data;
  try {
    const doc = await pdfjs.getDocument({
      data: bytes,
      cMapUrl: `${assetBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetBase}standard_fonts/`,
      wasmUrl: `${assetBase}wasm/`,
      iccUrl: `${assetBase}iccs/`,
      useWorkerFetch: true,
      stopAtErrors: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    }).promise;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const vt = viewport.transform as Affine2D;
    // Drawing coordinates: viewport (y down) flipped to y up, origin at the sheet's bottom-left.
    const pageTransform: Affine2D = [vt[0], -vt[1], vt[2], -vt[3], vt[4], viewport.height - vt[5]];
    const occ = await doc.getOptionalContentConfig();
    const ocgs: { id: string; name: string; visible: boolean }[] = [];
    for (const [id, group] of occ) ocgs.push({ id, name: group.name ?? id, visible: group.visible });
    post({ type: 'progress', fraction: 0.2 });
    const opList = await page.getOperatorList();
    post({ type: 'progress', fraction: 0.5 });
    const result = extractPdfVectors(opList, {
      ops: pdfjs.OPS as unknown as PdfOps,
      pageTransform,
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation,
      ocgs,
      onProgress: (f) => post({ type: 'progress', fraction: 0.5 + f * 0.4 }),
    });
    const render = buildRenderData(result.store, result.extents, { indexOnly: true });
    post({ type: 'done', result, render, pageCount: doc.numPages }, [
      ...storeTransferables(result.store),
      ...renderDataTransferables(render),
    ]);
    await doc.loadingTask.destroy();
  } catch (err) {
    post({ type: 'error', message: (err as Error)?.message ?? String(err), name: (err as Error)?.name });
  }
};
