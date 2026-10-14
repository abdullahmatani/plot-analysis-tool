import {
  canvasSizeForDpi,
  renderSceneCanvas,
  type Canvas2D,
  type PlacedImage,
} from '@/export/canvas-backend';
import type { FontSet } from '@/export/fonts';
import { pathBounds, type PdfPageItem, type Scene, type SceneItem } from '@/export/scene';

import { PngStreamEncoder } from './png-encoder';

/**
 * Tiled raster rendering of a scene (rows 76, 78, 81): the same canvas backend draws the export
 * preview and the PNG export, tile by tile (≤ 4096 px wide) and strip by strip, so a 300 dpi A1
 * sheet stays within a few tens of megabytes. Text is drawn as the bundled-font outlines (identical
 * to the PDF). PDF underlay pages are rasterised per tile by a provider (pdf.js on the main thread).
 */

export interface TileRequest {
  item: PdfPageItem;
  /** Tile origin in device pixels of the full image. */
  x0: number;
  y0: number;
  width: number;
  height: number;
  pxPerMm: number;
}

/** Returns an image of the PDF page item drawn in tile pixel space (w × h at the tile origin). */
export type PdfTileProvider = (req: TileRequest) => Promise<CanvasImageSource | null>;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

export interface RasterOptions {
  fonts?: FontSet;
  pdfTiles?: PdfTileProvider;
  /** Cancellation check between tiles. */
  isCancelled?: () => boolean;
  onProgress?: (fraction: number) => void;
  createCanvas?: (w: number, h: number) => AnyCanvas;
  /** Maximum tile width in px (default 4096). */
  maxTileWidth?: number;
  /** Target bytes of the RGBA strip buffer (default 24 MB). */
  stripBytes?: number;
}

export class RasterCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'AbortError';
  }
}

const defaultCanvas = (w: number, h: number): AnyCanvas => new OffscreenCanvas(w, h);

// ---------------------------------------------------------------------------------------------
// Culling
// ---------------------------------------------------------------------------------------------

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const boxCache = new WeakMap<SceneItem, Box | null>();

function itemBox(it: SceneItem): Box | null {
  if (boxCache.has(it)) return boxCache.get(it)!;
  let b: Box | null = null;
  switch (it.kind) {
    case 'path': {
      const pb = pathBounds(it.d);
      if (pb) {
        const pad = (it.stroke?.width ?? 0) + 0.5;
        b = { minX: pb.minX - pad, minY: pb.minY - pad, maxX: pb.maxX + pad, maxY: pb.maxY + pad };
      }
      break;
    }
    case 'text': {
      const lines = it.text.split('\n');
      const longest = Math.max(...lines.map((l) => [...l].length));
      const r = it.size * (longest * 0.8 + 2 + lines.length * 1.3) + (it.halo?.width ?? 0);
      b = { minX: it.x - r, minY: it.y - r, maxX: it.x + r, maxY: it.y + r };
      break;
    }
    case 'image': {
      const r = Math.hypot(it.w, it.h);
      b = { minX: it.x - r, minY: it.y - r, maxX: it.x + r, maxY: it.y + r };
      break;
    }
    case 'pdfPage':
      b = null; // unknown extent: always kept (the provider skips tiles it does not cover)
      break;
    case 'group': {
      for (const c of it.children) {
        const cb = itemBox(c);
        if (!cb) {
          if (c.kind === 'pdfPage') {
            b = null;
            boxCache.set(it, null);
            return null;
          }
          continue;
        }
        b = b
          ? {
              minX: Math.min(b.minX, cb.minX),
              minY: Math.min(b.minY, cb.minY),
              maxX: Math.max(b.maxX, cb.maxX),
              maxY: Math.max(b.maxY, cb.maxY),
            }
          : { ...cb };
      }
      if (b && it.clip) {
        const cb = pathBounds(it.clip);
        if (cb)
          b = {
            minX: Math.max(b.minX, cb.minX),
            minY: Math.max(b.minY, cb.minY),
            maxX: Math.min(b.maxX, cb.maxX),
            maxY: Math.min(b.maxY, cb.maxY),
          };
      }
      break;
    }
  }
  boxCache.set(it, b);
  return b;
}

const hit = (a: Box, b: Box) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

/** Items intersecting a paper rectangle (mm); keeps item identity (needed for PDF tile lookups). */
export function cullItems(items: readonly SceneItem[], r: Box): SceneItem[] {
  const out: SceneItem[] = [];
  for (const it of items) {
    if (it.kind === 'group') {
      const b = itemBox(it);
      if (b && !hit(b, r)) continue;
      const children = cullItems(it.children, r);
      if (children.length) out.push(children.length === it.children.length ? it : { ...it, children });
      continue;
    }
    const b = itemBox(it);
    if (b === null && it.kind !== 'pdfPage') continue;
    if (b && !hit(b, r)) continue;
    out.push(it);
  }
  return out;
}

function pdfItemsOf(items: readonly SceneItem[], out: PdfPageItem[] = []): PdfPageItem[] {
  for (const it of items) {
    if (it.kind === 'pdfPage') out.push(it);
    else if (it.kind === 'group') pdfItemsOf(it.children, out);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tile rendering
// ---------------------------------------------------------------------------------------------

/** Renders the tile at device-pixel origin (x0, y0) into `ctx` (cleared to the scene background). */
async function renderTile(
  ctx: Canvas2D,
  scene: Scene,
  x0: number,
  y0: number,
  w: number,
  h: number,
  pxPerMm: number,
  opts: RasterOptions,
): Promise<void> {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (scene.background) {
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, w, h);
  }
  const rect = { minX: x0 / pxPerMm, minY: y0 / pxPerMm, maxX: (x0 + w) / pxPerMm, maxY: (y0 + h) / pxPerMm };
  const items = cullItems(scene.items, rect);
  const pdfPageImages = new Map<SceneItem, PlacedImage>();
  if (opts.pdfTiles) {
    for (const item of pdfItemsOf(items)) {
      const img = await opts.pdfTiles({ item, x0, y0, width: w, height: h, pxPerMm });
      if (img)
        pdfPageImages.set(item, {
          image: img,
          transform: [1 / pxPerMm, 0, 0, 1 / pxPerMm, x0 / pxPerMm, y0 / pxPerMm],
        });
    }
  }
  ctx.setTransform(1, 0, 0, 1, -x0, -y0);
  renderSceneCanvas(ctx, { ...scene, background: undefined, items }, pxPerMm, {
    fonts: opts.fonts,
    textAsPaths: !!opts.fonts,
    pdfPageImages,
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Renders the whole scene into one canvas at `pxPerMm` (preview). */
export async function renderSceneToCanvas(
  scene: Scene,
  pxPerMm: number,
  opts: RasterOptions = {},
): Promise<AnyCanvas> {
  const w = Math.max(1, Math.round(scene.widthMm * pxPerMm));
  const h = Math.max(1, Math.round(scene.heightMm * pxPerMm));
  const canvas = (opts.createCanvas ?? defaultCanvas)(w, h);
  const ctx = canvas.getContext('2d') as Canvas2D | null;
  if (!ctx) throw new Error('Canvas 2D is not available');
  await renderTile(ctx, scene, 0, 0, w, h, pxPerMm, opts);
  return canvas;
}

export interface PngResult {
  parts: Uint8Array[];
  width: number;
  height: number;
  tiles: number;
}

/** Tiled PNG export at `dpi` with a streaming encoder (see module notes). */
export async function renderScenePng(
  scene: Scene,
  dpi: number,
  opts: RasterOptions = {},
): Promise<PngResult> {
  const { width, height, pxPerMm } = canvasSizeForDpi(scene, dpi);
  const tileW = Math.min(width, opts.maxTileWidth ?? 4096);
  const stripH = Math.max(16, Math.min(2048, Math.floor((opts.stripBytes ?? 24e6) / (width * 4))));
  const canvas = (opts.createCanvas ?? defaultCanvas)(tileW, Math.min(stripH, height));
  const ctx = canvas.getContext('2d', {
    willReadFrequently: true,
  } as CanvasRenderingContext2DSettings) as Canvas2D | null;
  if (!ctx) throw new Error('Canvas 2D is not available');
  const enc = new PngStreamEncoder(width, height, { dpi, alpha: !scene.background });
  const strip = new Uint8ClampedArray(width * Math.min(stripH, height) * 4);
  const tilesX = Math.ceil(width / tileW);
  const strips = Math.ceil(height / stripH);
  let done = 0;
  for (let s = 0; s < strips; s++) {
    const y0 = s * stripH;
    const h = Math.min(stripH, height - y0);
    for (let t = 0; t < tilesX; t++) {
      if (opts.isCancelled?.()) throw new RasterCancelled();
      const x0 = t * tileW;
      const w = Math.min(tileW, width - x0);
      await renderTile(ctx, scene, x0, y0, w, h, pxPerMm, opts);
      const data = ctx.getImageData(0, 0, w, h).data;
      if (tilesX === 1) strip.set(data.subarray(0, w * h * 4));
      else
        for (let r = 0; r < h; r++)
          strip.set(data.subarray(r * w * 4, (r + 1) * w * 4), (r * width + x0) * 4);
      done++;
      opts.onProgress?.(done / (tilesX * strips));
    }
    enc.pushRgba(strip, h);
  }
  return { parts: enc.finish(), width, height, tiles: tilesX * strips };
}
