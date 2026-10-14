import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

import { invert, multiply, transformBounds } from '@/core/affine';
import type { Affine2D, Bounds } from '@/core/types';
import type { ViewTransform } from '@/store/view';
import { visibleWorldBounds } from '@/render/view';

/**
 * PDF documents on the main thread (row 15): pdf.js with its locally bundled worker, CMaps, standard
 * fonts and decoders. Pages are rendered as resolution-adaptive tiles so lines stay crisp at any
 * zoom: the tile level is chosen from the on-screen size of a PDF point.
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** One shared pdf.js worker for all documents (destroying a document does not kill it). */
function ensureWorkerPort() {
  if (pdfjs.GlobalWorkerOptions.workerPort || typeof Worker === 'undefined') return;
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: 'module', name: 'pdfjs' });
}

export function pdfAssetBase(): string {
  return new URL('./pdfjs/', document.baseURI).href;
}

export async function openPdfDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  ensureWorkerPort();
  const base = pdfAssetBase();
  return pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    useWorkerFetch: true,
  }).promise;
}

export const TILE_PX = 512;
const MAX_CACHE = 160;

interface Tile {
  key: string;
  level: number;
  x: number;
  y: number;
  w: number;
  h: number;
  image: HTMLCanvasElement;
  lastUsed: number;
}

export interface TileSet {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  image: TexImageSource;
}

/** Renders and caches tiles for one PDF page; calls `onTiles` whenever the visible set changes. */
export class PdfTileManager {
  private cache = new Map<string, Tile>();
  private queue: { key: string; level: number; tx: number; ty: number }[] = [];
  private active: RenderTask | null = null;
  private activeKey: string | null = null;
  private generation = 0;
  private wanted: string[] = [];
  private baseLevel: number;
  private disposed = false;
  private ocConfig: Promise<unknown> | null = null;

  constructor(
    readonly page: PDFPageProxy,
    readonly width: number,
    readonly height: number,
    private onTiles: (tiles: TileSet[]) => void,
  ) {
    // Base level: whole page at ≤ 2048 px on its longest side.
    this.baseLevel = Math.min(2, 2 ** Math.floor(Math.log2(2048 / Math.max(width, height))));
  }

  /** Optional content (PDF layers): hidden group ids. Clears the cache when visibility changes. */
  setHiddenGroups(doc: PDFDocumentProxy, hidden: string[]) {
    this.ocConfig = doc.getOptionalContentConfig().then((cfg) => {
      for (const [id] of cfg) cfg.setVisibility(id, !hidden.includes(id));
      return cfg;
    });
    this.cache.clear();
    this.generation++;
  }

  /** Updates the wanted tile set for the current view. `placement` maps drawing points → world metres. */
  update(view: ViewTransform, cssW: number, cssH: number, dpr: number, placement: Affine2D) {
    if (this.disposed) return;
    const pxPerPt =
      view.scale * Math.sqrt(Math.abs(placement[0] * placement[3] - placement[1] * placement[2])) * dpr;
    const level = Math.max(this.baseLevel, Math.min(64, 2 ** Math.ceil(Math.log2(Math.max(pxPerPt, 1e-6)))));
    const wanted: string[] = [];
    // Base tile(s) always present.
    const baseKeys = this.keysForRegion(this.baseLevel, {
      minX: 0,
      minY: 0,
      maxX: this.width,
      maxY: this.height,
    });
    wanted.push(...baseKeys);
    if (level > this.baseLevel) {
      let inv: Affine2D;
      try {
        inv = invert(placement);
      } catch {
        return;
      }
      const vis = transformBounds(inv, visibleWorldBounds(view, cssW, cssH));
      const region = {
        minX: Math.max(0, vis.minX),
        minY: Math.max(0, vis.minY),
        maxX: Math.min(this.width, vis.maxX),
        maxY: Math.min(this.height, vis.maxY),
      };
      if (region.maxX > region.minX && region.maxY > region.minY)
        wanted.push(...this.keysForRegion(level, region));
    }
    this.wanted = wanted;
    // Queue missing tiles (fine level first so the visible area sharpens quickly).
    const missing = wanted.filter((k) => !this.cache.has(k));
    this.queue = missing.reverse().map((k) => {
      const [, l, tx, ty] = k.split(':');
      return { key: k, level: Number(l), tx: Number(tx), ty: Number(ty) };
    });
    if (this.activeKey && !wanted.includes(this.activeKey)) this.active?.cancel();
    this.emit();
    void this.pump();
  }

  private keysForRegion(level: number, r: Bounds): string[] {
    const size = TILE_PX / level; // tile size in points
    const keys: string[] = [];
    const x0 = Math.floor(r.minX / size);
    const x1 = Math.ceil(r.maxX / size);
    const y0 = Math.floor(r.minY / size);
    const y1 = Math.ceil(r.maxY / size);
    if ((x1 - x0) * (y1 - y0) > 400) return keys; // safety
    for (let ty = y0; ty < y1; ty++)
      for (let tx = x0; tx < x1; tx++) keys.push(`${this.generation}:${level}:${tx}:${ty}`);
    return keys;
  }

  private emit() {
    const now = performance.now();
    const tiles: TileSet[] = [];
    // Coarse first so finer tiles draw on top.
    const sorted = [...this.wanted].sort((a, b) => Number(a.split(':')[1]) - Number(b.split(':')[1]));
    for (const k of sorted) {
      const t = this.cache.get(k);
      if (!t) continue;
      t.lastUsed = now;
      tiles.push({ key: t.key, x: t.x, y: t.y, w: t.w, h: t.h, image: t.image });
    }
    this.onTiles(tiles);
  }

  private async pump(): Promise<void> {
    if (this.active || this.disposed) return;
    const job = this.queue.shift();
    if (!job) return;
    const size = TILE_PX / job.level;
    const x = job.tx * size;
    const y = job.ty * size;
    const w = Math.min(size, this.width - x);
    const h = Math.min(size, this.height - y);
    if (w <= 0 || h <= 0) return this.pump();
    const pw = Math.max(1, Math.ceil(w * job.level));
    const ph = Math.max(1, Math.ceil(h * job.level));
    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pw, ph);
    const viewport = this.page.getViewport({ scale: job.level });
    // Viewport pixels are y-down from the sheet top; the tile's top edge is at height − (y + h).
    const offX = x * job.level;
    const offY = (this.height - (y + h)) * job.level;
    const gen = this.generation;
    try {
      this.activeKey = job.key;
      this.active = this.page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: [1, 0, 0, 1, -offX, -offY],
        optionalContentConfigPromise: (this.ocConfig ?? undefined) as never,
        annotationMode: pdfjs.AnnotationMode.DISABLE,
      });
      await this.active.promise;
      if (gen === this.generation && !this.disposed) {
        // The canvas covers exactly w×h points at this level (rounded up).
        this.cache.set(job.key, {
          key: job.key,
          level: job.level,
          x,
          y,
          w: pw / job.level,
          h: ph / job.level,
          image: canvas,
          lastUsed: performance.now(),
        });
        this.evict();
        this.emit();
      }
    } catch {
      /* cancelled or failed tile: skipped */
    } finally {
      this.active = null;
      this.activeKey = null;
    }
    void this.pump();
  }

  private evict() {
    if (this.cache.size <= MAX_CACHE) return;
    const wanted = new Set(this.wanted);
    const victims = [...this.cache.values()]
      .filter((t) => !wanted.has(t.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of victims.slice(0, this.cache.size - MAX_CACHE)) this.cache.delete(t.key);
  }

  get pending() {
    return this.queue.length + (this.active ? 1 : 0);
  }

  dispose() {
    this.disposed = true;
    this.active?.cancel();
    this.cache.clear();
  }
}

export function composePlacement(...ms: Affine2D[]): Affine2D {
  return ms.reduce((acc, m) => multiply(acc, m));
}
