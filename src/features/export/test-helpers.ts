/**
 * Test-only helpers for the export feature: projects with objects, drawings parsed from the
 * reference fixtures, and PDF analysis with pdf.js (vector extraction of exported files).
 */
import { readFileSync } from 'node:fs';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { scale as scaleM } from '@/core/affine';
import { newId, nowIso } from '@/core/ids';
import { createProject, DEFAULT_STYLE } from '@/core/project';
import type { Affine2D, AnalysisObject, Drawing, Geometry, Project } from '@/core/types';
import { METRES_PER_PT } from '@/core/units';
import { parseDxf } from '@/import/dxf';
import { extractPdfVectors, type PdfOps } from '@/import/pdf/extract';
import type { DrawingParseResult } from '@/underlay/entity-store';
import { GK } from '@/underlay/entity-store';

import type { DrawingSceneInput } from './scene/types';
import { defaultExportSettings, type ExportSettings } from './settings';

export function testProject(name = 'Test project'): Project {
  const p = createProject(name);
  p.sheet.titleBlock.date = '2026-10-14';
  return p;
}

export function addObject(
  p: Project,
  geometry: Geometry,
  opts: Partial<AnalysisObject> = {},
): AnalysisObject {
  const o: AnalysisObject = {
    id: newId('obj'),
    layerId: opts.layerId ?? p.activeLayerId,
    name: opts.name ?? `Object ${p.objects.length + 1}`,
    kind: 'shape',
    geometry,
    style: {},
    attributes: {},
    createdAt: nowIso(),
    ...opts,
  };
  p.objects.push(o);
  return o;
}

export function settingsFor(p: Project, patch: Partial<ExportSettings> = {}): ExportSettings {
  return { ...defaultExportSettings(p), ...patch };
}

export function dxfDrawing(
  file: string,
  patch: Partial<Drawing> = {},
): { drawing: Drawing; input: DrawingSceneInput; result: DrawingParseResult } {
  const bytes = new Uint8Array(readFileSync(file));
  const result = parseDxf(bytes);
  const drawing: Drawing = {
    id: newId('drw'),
    name: file
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, ''),
    source: { kind: 'dxf', fileName: file, sha256: 'x', blobKey: 'x', size: bytes.length },
    nativeUnits: 'm',
    opacity: 1,
    ghost: false,
    visible: true,
    hiddenSourceLayers: result.store.layers.filter((l) => l.off || l.frozen).map((l) => l.name),
    order: 0,
    ...patch,
  };
  return {
    drawing,
    input: { id: drawing.id, store: result.store, insunits: result.insunits, extents: result.extents },
    result,
  };
}

export const OPS = pdfjs.OPS as unknown as PdfOps;

export async function pdfDrawing(
  file: string,
  page: number,
  ratio?: number,
): Promise<{ drawing: Drawing; input: DrawingSceneInput }> {
  const bytes = new Uint8Array(readFileSync(file));
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
  } as never).promise;
  const pg = await doc.getPage(page);
  const vp = pg.getViewport({ scale: 1 });
  const vt = vp.transform as Affine2D;
  const userToDrawing: Affine2D = [vt[0], -vt[1], vt[2], -vt[3], vt[4], vp.height - vt[5]];
  await doc.loadingTask.destroy();
  const drawing: Drawing = {
    id: newId('drw'),
    name: `PDF p${page}`,
    source: { kind: 'pdf', fileName: file, sha256: 'p', blobKey: 'p', size: bytes.length },
    page,
    nativeUnits: 'pt',
    opacity: 1,
    ghost: false,
    visible: true,
    hiddenSourceLayers: [],
    order: 0,
  };
  if (ratio) {
    drawing.calibration = {
      method: 'ratio',
      ratio,
      transform: scaleM(METRES_PER_PT * ratio),
      references: [],
      at: '2026-10-14T00:00:00.000Z',
    };
  }
  return {
    drawing,
    input: {
      id: drawing.id,
      pdf: { bytes, pageIndex: page - 1, userToDrawing, widthPt: vp.width, heightPt: vp.height },
    },
  };
}

/** Vector content of page 1 of a PDF in points (y up from the page's bottom-left). */
export async function pdfVectors(
  bytes: Uint8Array,
): Promise<{ result: DrawingParseResult; width: number; height: number; text: string }> {
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  } as never).promise;
  const pg = await doc.getPage(1);
  const vp = pg.getViewport({ scale: 1 });
  const vt = vp.transform as Affine2D;
  const pageTransform: Affine2D = [vt[0], -vt[1], vt[2], -vt[3], vt[4], vp.height - vt[5]];
  const opList = await pg.getOperatorList();
  const tc = await pg.getTextContent();
  const text = tc.items.map((i) => ('str' in i ? i.str : '')).join(' ');
  const result = extractPdfVectors(opList, {
    ops: OPS,
    pageTransform,
    width: vp.width,
    height: vp.height,
    rotation: vp.rotation,
    ocgs: [],
  });
  await doc.loadingTask.destroy();
  return { result, width: vp.width, height: vp.height, text };
}

/** Circles (pt) found in an extracted store. */
export function circlesOf(r: DrawingParseResult): { x: number; y: number; r: number }[] {
  const s = r.store;
  const out: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < s.count; i++) {
    if (s.geomKind[i] !== GK.CIRCLE) continue;
    const o = s.geomStart[i];
    out.push({ x: s.geom[o], y: s.geom[o + 1], r: s.geom[o + 2] });
  }
  return out;
}

/** Bounding boxes (pt) of circles, polylines and fills in an extracted store. */
export function shapesOf(r: DrawingParseResult): { cx: number; cy: number; w: number; h: number }[] {
  const s = r.store;
  const out: { cx: number; cy: number; w: number; h: number }[] = [];
  for (let i = 0; i < s.count; i++) {
    const k = s.geomKind[i];
    if (k !== GK.CIRCLE && k !== GK.POLY && k !== GK.FILL) continue;
    const o = i * 4;
    const [x0, y0, x1, y1] = [s.bbox[o], s.bbox[o + 1], s.bbox[o + 2], s.bbox[o + 3]];
    out.push({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

export { DEFAULT_STYLE };
