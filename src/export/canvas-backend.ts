import type { Affine2D } from '@/core/types';

import {
  anchorFraction,
  baselineOffset,
  cssFontFamily,
  emMetrics,
  layoutText,
  layoutToPath,
  lineDirection,
  splitLines,
  LINE_HEIGHT,
} from './fonts';
import type { FontSet } from './fonts';
import { hexColor, opacityOf, parseColor } from './format';
import { hatchGeometry } from './hatch';
import { MITER_LIMIT, pathBounds, walkScene } from './scene';
import type {
  FontFamily,
  GroupItem,
  ImageItem,
  PathCmd,
  PathItem,
  PdfPageItem,
  Scene,
  SceneItem,
  StrokeStyle,
  TextItem,
} from './scene';

/**
 * Canvas 2D backend for PNG export and the WYSIWYG export preview (rows 78, 81). Works with
 * `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D` (Web Workers). Image decoding
 * is asynchronous, so callers pre-decode images (see {@link decodeSceneImages}) and pass them in.
 *
 * Text is drawn with `fillText` (browser shaping and bidi, `ctx.direction` set per line) and placed
 * with the same metrics as the PDF/SVG backends; pass `fonts` + `textAsPaths` to draw the exact
 * glyph outlines used by the PDF instead.
 */

export type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A pre-rendered image with an explicit placement: image pixel space → paper mm. */
export interface PlacedImage {
  image: CanvasImageSource;
  transform: Affine2D;
}

export interface CanvasRenderOptions {
  /**
   * Rasterised source PDF pages (e.g. rendered with pdf.js). A plain image is drawn into the item's
   * `fallbackPng` rectangle; a {@link PlacedImage} uses its own transform.
   */
  pdfPageImages?: Map<SceneItem, CanvasImageSource | PlacedImage>;
  /** Decoded PNGs keyed by the scene's byte arrays (images and PDF-page fallbacks). */
  imageCache?: Map<Uint8Array, CanvasImageSource>;
  /** Font set for metrics (and outlines with `textAsPaths`). */
  fonts?: FontSet;
  /** Draw text as glyph outlines from `fonts` (pixel-identical placement with the PDF). */
  textAsPaths?: boolean;
  /** CSS font-family overrides per family. */
  fontFamilies?: Partial<Record<FontFamily, string>>;
}

function isPlaced(v: CanvasImageSource | PlacedImage): v is PlacedImage {
  return (
    typeof v === 'object' &&
    v !== null &&
    'image' in v &&
    'transform' in v &&
    Array.isArray((v as PlacedImage).transform)
  );
}

const css = (c: string) => hexColor(parseColor(c));

function tracePath(ctx: Canvas2D, d: readonly PathCmd[]): void {
  ctx.beginPath();
  for (const c of d) {
    switch (c.op) {
      case 'M':
        ctx.moveTo(c.x, c.y);
        break;
      case 'L':
        ctx.lineTo(c.x, c.y);
        break;
      case 'C':
        ctx.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
        break;
      case 'Z':
        ctx.closePath();
        break;
    }
  }
}

function applyStroke(ctx: Canvas2D, s: StrokeStyle, alpha: number): void {
  ctx.globalAlpha = alpha * opacityOf(s.opacity);
  ctx.strokeStyle = css(s.color);
  ctx.lineWidth = s.width;
  const dash =
    s.dash && s.dash.every((v) => v >= 0 && Number.isFinite(v)) && s.dash.some((v) => v > 0) ? s.dash : [];
  ctx.setLineDash(dash);
  ctx.lineDashOffset = 0;
  ctx.lineCap = s.cap ?? 'butt';
  ctx.lineJoin = s.join ?? 'miter';
  ctx.miterLimit = MITER_LIMIT;
}

class CanvasSceneRenderer {
  constructor(
    private readonly ctx: Canvas2D,
    private readonly pxPerMm: number,
    private readonly opts: CanvasRenderOptions,
  ) {}

  item(it: SceneItem, alpha: number): void {
    switch (it.kind) {
      case 'path':
        this.path(it, alpha);
        break;
      case 'text':
        this.text(it, alpha);
        break;
      case 'image':
        this.image(it, alpha);
        break;
      case 'pdfPage':
        this.pdfPage(it, alpha);
        break;
      case 'group':
        this.group(it, alpha);
        break;
    }
  }

  private path(it: PathItem, alpha: number): void {
    const { ctx } = this;
    if (!it.d.length) return;
    const fill = it.fill;
    const rule: CanvasFillRule = fill?.rule === 'evenodd' ? 'evenodd' : 'nonzero';
    const fillAlpha = fill ? opacityOf(fill.opacity) : 0;
    tracePath(ctx, it.d);
    if (fill && fillAlpha > 0) {
      ctx.globalAlpha = alpha * fillAlpha;
      ctx.fillStyle = css(fill.color);
      ctx.fill(rule);
    }
    const hatch = fill?.hatch;
    if (fill && hatch && hatch.spacing > 0) {
      const bounds = pathBounds(it.d);
      if (bounds) {
        const geo = hatchGeometry(hatch.pattern, bounds, hatch.spacing);
        const col = css(hatch.color ?? fill.color);
        ctx.save();
        ctx.clip(rule);
        ctx.globalAlpha = alpha * opacityOf(hatch.opacity);
        if (geo.lines.length) {
          ctx.beginPath();
          for (const [x1, y1, x2, y2] of geo.lines) {
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
          }
          ctx.strokeStyle = col;
          ctx.lineWidth = hatch.lineWidth;
          ctx.setLineDash([]);
          ctx.lineCap = 'butt';
          ctx.stroke();
        }
        if (geo.dots.length) {
          const r = Math.max(hatch.lineWidth, 0.01);
          ctx.beginPath();
          for (const [x, y] of geo.dots) {
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
          ctx.fillStyle = col;
          ctx.fill();
        }
        ctx.restore();
        tracePath(ctx, it.d);
      }
    }
    if (it.stroke && it.stroke.width > 0) {
      applyStroke(ctx, it.stroke, alpha);
      ctx.stroke();
    }
  }

  private text(it: TextItem, alpha: number): void {
    const { ctx, pxPerMm, opts } = this;
    if (!it.text || !(it.size > 0)) return;
    const a = alpha * opacityOf(it.opacity);
    if (a <= 0) return;
    ctx.save();
    ctx.translate(it.x, it.y);
    if (it.rotation) ctx.rotate(-it.rotation);
    ctx.globalAlpha = a;
    if (opts.textAsPaths && opts.fonts) {
      const layout = layoutText(opts.fonts, it.text, {
        size: it.size,
        font: it.font,
        bold: it.bold,
        anchor: it.anchor,
        baseline: it.baseline,
      });
      const d = layoutToPath(layout);
      if (d.length) {
        if (it.halo && it.halo.width > 0) {
          tracePath(ctx, d);
          ctx.strokeStyle = css(it.halo.color);
          ctx.lineWidth = it.halo.width;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.setLineDash([]);
          ctx.stroke();
        }
        tracePath(ctx, d);
        ctx.fillStyle = css(it.color);
        ctx.fill('nonzero');
      }
      ctx.restore();
      return;
    }
    // Draw in device pixels so tiny mm font sizes are not subject to browser minimum sizes.
    ctx.scale(1 / pxPerMm, 1 / pxPerMm);
    const lines = splitLines(it.text);
    const m = emMetrics(opts.fonts, it.font, !!it.bold);
    const y0 = baselineOffset(it.baseline, it.size, lines.length, m);
    const lh = LINE_HEIGHT * it.size;
    const family = opts.fontFamilies?.[it.font] ?? cssFontFamily(it.font);
    ctx.font = `${it.bold ? 'bold ' : ''}${it.size * pxPerMm}px ${family}`;
    ctx.textBaseline = 'alphabetic';
    const frac = anchorFraction(it.anchor);
    ctx.textAlign = frac === 0.5 ? 'center' : frac === 1 ? 'right' : 'left';
    const paraDir = lineDirection(it.text);
    lines.forEach((line, i) => {
      if (!line) return;
      if ('direction' in ctx) ctx.direction = lineDirection(line, paraDir);
      const y = (y0 + i * lh) * pxPerMm;
      if (it.halo && it.halo.width > 0) {
        ctx.strokeStyle = css(it.halo.color);
        ctx.lineWidth = it.halo.width * pxPerMm;
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);
        ctx.strokeText(line, 0, y);
      }
      ctx.fillStyle = css(it.color);
      ctx.fillText(line, 0, y);
    });
    ctx.restore();
  }

  private drawImageRect(
    img: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number,
    rotation: number | undefined,
    alpha: number,
  ): void {
    const { ctx } = this;
    if (alpha <= 0 || !(w > 0 && h > 0)) return;
    ctx.save();
    ctx.translate(x, y);
    if (rotation) ctx.rotate(-rotation);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, 0, 0, w, h);
    ctx.restore();
  }

  private image(it: ImageItem, alpha: number): void {
    const img = this.opts.imageCache?.get(it.png);
    if (img) this.drawImageRect(img, it.x, it.y, it.w, it.h, it.rotation, alpha * opacityOf(it.opacity));
  }

  private pdfPage(it: PdfPageItem, alpha: number): void {
    const a = alpha * opacityOf(it.opacity);
    const v = this.opts.pdfPageImages?.get(it);
    const f = it.fallbackPng;
    if (v && isPlaced(v)) {
      if (a <= 0) return;
      const { ctx } = this;
      ctx.save();
      ctx.transform(...v.transform);
      ctx.globalAlpha = a;
      ctx.drawImage(v.image, 0, 0);
      ctx.restore();
      return;
    }
    if (!f) return;
    const img = v ?? this.opts.imageCache?.get(f.png);
    if (img) this.drawImageRect(img, f.x, f.y, f.w, f.h, undefined, a);
  }

  private group(g: GroupItem, alpha: number): void {
    const a = alpha * opacityOf(g.opacity);
    if (a <= 0) return;
    const { ctx } = this;
    ctx.save();
    if (g.clip && g.clip.length) {
      tracePath(ctx, g.clip);
      ctx.clip('nonzero');
    }
    // Group opacity is approximated by multiplying into each child (overlaps blend twice).
    for (const child of g.children) this.item(child, a);
    ctx.restore();
  }
}

/**
 * Draws a scene onto a 2D context at `pxPerMm` (e.g. dpi / 25.4), on top of the context's current
 * transform (so a preview can pan/zoom by pre-transforming the context).
 */
export function renderSceneCanvas(
  ctx: Canvas2D,
  scene: Scene,
  pxPerMm: number,
  opts: CanvasRenderOptions = {},
): void {
  if (!(pxPerMm > 0)) throw new Error('pxPerMm must be positive');
  ctx.save();
  ctx.scale(pxPerMm, pxPerMm);
  if (scene.background) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = css(scene.background);
    ctx.fillRect(0, 0, scene.widthMm, scene.heightMm);
  }
  const r = new CanvasSceneRenderer(ctx, pxPerMm, opts);
  for (const it of scene.items) r.item(it, 1);
  ctx.restore();
}

/** Pixel size of a canvas for the scene at `dpi`. */
export function canvasSizeForDpi(
  scene: Scene,
  dpi: number,
): { width: number; height: number; pxPerMm: number } {
  const pxPerMm = dpi / 25.4;
  return {
    width: Math.max(1, Math.round(scene.widthMm * pxPerMm)),
    height: Math.max(1, Math.round(scene.heightMm * pxPerMm)),
    pxPerMm,
  };
}

/**
 * Decodes every PNG in the scene (images and PDF-page fallbacks) with `createImageBitmap`, which
 * is available on the main thread and in Web Workers. Undecodable images are skipped.
 */
export async function decodeSceneImages(
  scene: Scene,
  decode: (png: Uint8Array) => Promise<CanvasImageSource> = (png) =>
    createImageBitmap(new Blob([png.slice().buffer as ArrayBuffer], { type: 'image/png' })),
): Promise<Map<Uint8Array, CanvasImageSource>> {
  const pngs = new Set<Uint8Array>();
  walkScene(scene.items, (it) => {
    if (it.kind === 'image') pngs.add(it.png);
    else if (it.kind === 'pdfPage' && it.fallbackPng) pngs.add(it.fallbackPng.png);
  });
  const out = new Map<Uint8Array, CanvasImageSource>();
  await Promise.all(
    [...pngs].map(async (png) => {
      try {
        out.set(png, await decode(png));
      } catch {
        // leave undecodable images out; the renderer skips them
      }
    }),
  );
  return out;
}
