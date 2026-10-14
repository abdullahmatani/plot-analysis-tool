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
import { base64Encode, fmt, opacityOf, parseColor, hexColor, xmlEscape } from './format';
import { hatchGeometry } from './hatch';
import type {
  FillStyle,
  GroupItem,
  HatchPatternName,
  ImageItem,
  PathCmd,
  PathItem,
  PdfPageItem,
  Scene,
  SceneItem,
  StrokeStyle,
  TextItem,
} from './scene';
import { MITER_LIMIT, circlePath, pathBounds } from './scene';

/**
 * SVG backend (row 78). Paper millimetres map 1:1 to user units (`viewBox="0 0 W H"`, width/height
 * in mm). Layer groups become Inkscape layers; hatches are `<pattern>`s equivalent to the PDF and
 * canvas hatch geometry; images are embedded as data URIs; PDF pages use their raster fallback
 * (SVG cannot embed PDF). No external references are written (C3).
 */

export interface SvgRenderOptions {
  /** Needed for `textAsPaths` and for exact font metrics. */
  fonts?: FontSet;
  /** Draw text as glyph outlines (requires `fonts`) instead of `<text>` elements. */
  textAsPaths?: boolean;
  /** Decimal places for coordinates (default 4 → 0.1 µm). */
  precision?: number;
  /**
   * 'pattern' (default): hatches as `<pattern>` fills (compact; browsers, Inkscape, Illustrator).
   * 'lines': clip-path plus explicit hatch lines, identical to the PDF geometry, for consumers
   * without pattern support (some office suites, CAD importers, MuPDF).
   */
  hatch?: 'pattern' | 'lines';
}

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';
export const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';

interface Ctx {
  defs: string[];
  ids: Set<string>;
  patterns: Map<string, string>;
  p: number;
  opts: SvgRenderOptions;
}

const attr = (name: string, value: string | number | undefined): string =>
  value === undefined || value === '' ? '' : ` ${name}="${xmlEscape(String(value))}"`;

function color(c: string): string {
  return hexColor(parseColor(c));
}

function uniqueId(ctx: Ctx, base: string): string {
  let id = base.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^([^A-Za-z_])/, '_$1') || 'id';
  if (ctx.ids.has(id)) {
    let i = 2;
    while (ctx.ids.has(`${id}-${i}`)) i++;
    id = `${id}-${i}`;
  }
  ctx.ids.add(id);
  return id;
}

/** SVG path data for a scene path. */
export function svgPathData(d: readonly PathCmd[], precision = 4): string {
  const n = (v: number) => fmt(v, precision);
  const out: string[] = [];
  for (const c of d) {
    switch (c.op) {
      case 'M':
        out.push(`M${n(c.x)} ${n(c.y)}`);
        break;
      case 'L':
        out.push(`L${n(c.x)} ${n(c.y)}`);
        break;
      case 'C':
        out.push(`C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`);
        break;
      case 'Z':
        out.push('Z');
        break;
    }
  }
  return out.join('');
}

function strokeAttrs(s: StrokeStyle | undefined, p: number): string {
  if (!s || !(s.width > 0)) return ' stroke="none"';
  const dash =
    s.dash && s.dash.length && s.dash.every((v) => v >= 0) && s.dash.some((v) => v > 0)
      ? s.dash.map((v) => fmt(v, p)).join(' ')
      : undefined;
  const op = opacityOf(s.opacity);
  return (
    attr('stroke', color(s.color)) +
    attr('stroke-width', fmt(s.width, p)) +
    (op < 1 ? attr('stroke-opacity', fmt(op, 4)) : '') +
    attr('stroke-dasharray', dash) +
    (s.cap && s.cap !== 'butt' ? attr('stroke-linecap', s.cap) : '') +
    (s.join && s.join !== 'miter' ? attr('stroke-linejoin', s.join) : '') +
    attr('stroke-miterlimit', MITER_LIMIT)
  );
}

/** Tile content and transform for each hatch pattern (see hatch.ts for the line families). */
function hatchTile(pattern: HatchPatternName, s: number): { d: string; dots: boolean; rotate: number } {
  const S = fmt(s, 6);
  const vertical = `M0 0V${S}M${S} 0V${S}`;
  const horizontal = `M0 0H${S}M0 ${S}H${S}`;
  switch (pattern) {
    case 'vertical':
      return { d: vertical, dots: false, rotate: 0 };
    case 'horizontal':
      return { d: horizontal, dots: false, rotate: 0 };
    case 'diagonal':
      return { d: vertical, dots: false, rotate: 45 };
    case 'back-diagonal':
      return { d: vertical, dots: false, rotate: -45 };
    case 'cross':
      return { d: vertical + horizontal, dots: false, rotate: 0 };
    case 'diagonal-cross':
      return { d: vertical + horizontal, dots: false, rotate: 45 };
    case 'dots':
      return { d: '', dots: true, rotate: 0 };
  }
}

function hatchPattern(ctx: Ctx, fill: FillStyle): string {
  const h = fill.hatch!;
  const col = color(h.color ?? fill.color);
  const op = opacityOf(h.opacity);
  const key = `${h.pattern}|${h.spacing}|${h.lineWidth}|${col}|${op}`;
  const hit = ctx.patterns.get(key);
  if (hit) return hit;
  const id = uniqueId(ctx, `hatch-${h.pattern}-${ctx.patterns.size}`);
  const s = h.spacing;
  const tile = hatchTile(h.pattern, s);
  const S = fmt(s, 6);
  let body: string;
  if (tile.dots) {
    const r = fmt(Math.max(h.lineWidth, 0.01), 6);
    body = [
      [0, 0],
      [s, 0],
      [0, s],
      [s, s],
    ]
      .map(
        ([x, y]) =>
          `<circle cx="${fmt(x, 6)}" cy="${fmt(y, 6)}" r="${r}" fill="${col}"${op < 1 ? ` fill-opacity="${fmt(op, 4)}"` : ''}/>`,
      )
      .join('');
  } else {
    body = `<path d="${tile.d}" fill="none" stroke="${col}" stroke-width="${fmt(h.lineWidth, 6)}"${op < 1 ? ` stroke-opacity="${fmt(op, 4)}"` : ''}/>`;
  }
  ctx.defs.push(
    `<pattern id="${id}" patternUnits="userSpaceOnUse" x="0" y="0" width="${S}" height="${S}"${tile.rotate ? ` patternTransform="rotate(${tile.rotate})"` : ''}>${body}</pattern>`,
  );
  ctx.patterns.set(key, id);
  return id;
}

function emitPath(ctx: Ctx, it: PathItem, out: string[]): void {
  if (!it.d.length) return;
  const d = svgPathData(it.d, ctx.p);
  const fill = it.fill;
  const fillAlpha = fill ? opacityOf(fill.opacity) : 0;
  const rule = fill?.rule === 'evenodd' ? ' fill-rule="evenodd"' : '';
  const hatch = fill?.hatch && fill.hatch.spacing > 0;
  if (!hatch) {
    const fillAttrs =
      fill && fillAlpha > 0
        ? attr('fill', color(fill.color)) +
          (fillAlpha < 1 ? attr('fill-opacity', fmt(fillAlpha, 4)) : '') +
          rule
        : ' fill="none"';
    out.push(`<path d="${d}"${fillAttrs}${strokeAttrs(it.stroke, ctx.p)}/>`);
    return;
  }
  if (fillAlpha > 0) {
    out.push(
      `<path d="${d}"${attr('fill', color(fill!.color))}${fillAlpha < 1 ? attr('fill-opacity', fmt(fillAlpha, 4)) : ''}${rule} stroke="none"/>`,
    );
  }
  if (ctx.opts.hatch === 'lines') emitHatchLines(ctx, it.d, d, fill!, out);
  else out.push(`<path d="${d}" fill="url(#${hatchPattern(ctx, fill!)})"${rule} stroke="none"/>`);
  if (it.stroke && it.stroke.width > 0)
    out.push(`<path d="${d}" fill="none"${strokeAttrs(it.stroke, ctx.p)}/>`);
}

function emitHatchLines(ctx: Ctx, cmds: readonly PathCmd[], d: string, fill: FillStyle, out: string[]): void {
  const h = fill.hatch!;
  const bounds = pathBounds(cmds);
  if (!bounds) return;
  const geo = hatchGeometry(h.pattern, bounds, h.spacing);
  const cid = uniqueId(ctx, 'hatch-clip');
  ctx.defs.push(
    `<clipPath id="${cid}" clipPathUnits="userSpaceOnUse"><path d="${d}"${fill.rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`,
  );
  const col = color(h.color ?? fill.color);
  const op = opacityOf(h.opacity);
  const n = (v: number) => fmt(v, ctx.p);
  out.push(`<g clip-path="url(#${cid})"${op < 1 ? attr('opacity', fmt(op, 4)) : ''}>`);
  if (geo.lines.length) {
    const ld = geo.lines.map(([x1, y1, x2, y2]) => `M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`).join('');
    out.push(`<path d="${ld}" fill="none" stroke="${col}" stroke-width="${fmt(h.lineWidth, ctx.p)}"/>`);
  }
  if (geo.dots.length) {
    const r = Math.max(h.lineWidth, 0.01);
    out.push(
      `<path d="${geo.dots.map(([x, y]) => svgPathData(circlePath(x, y, r), ctx.p)).join('')}" fill="${col}" stroke="none"/>`,
    );
  }
  out.push('</g>');
}

function rotateDeg(rad: number | undefined): number {
  return rad ? (-rad * 180) / Math.PI : 0;
}

function emitText(ctx: Ctx, it: TextItem, out: string[]): void {
  if (!it.text || !(it.size > 0)) return;
  const p = ctx.p;
  const op = opacityOf(it.opacity);
  const rot = rotateDeg(it.rotation);
  const transform = `translate(${fmt(it.x, p)} ${fmt(it.y, p)})${rot ? ` rotate(${fmt(rot, 6)})` : ''}`;
  const fill = color(it.color);
  const fonts = ctx.opts.fonts;
  if (ctx.opts.textAsPaths && fonts) {
    const layout = layoutText(fonts, it.text, {
      size: it.size,
      font: it.font,
      bold: it.bold,
      anchor: it.anchor,
      baseline: it.baseline,
    });
    const d = svgPathData(layoutToPath(layout), p);
    out.push(
      `<g transform="${transform}"${op < 1 ? attr('opacity', fmt(op, 4)) : ''}${attr('aria-label', it.text)}>`,
    );
    if (d && it.halo && it.halo.width > 0) {
      out.push(
        `<path d="${d}" fill="${color(it.halo.color)}" stroke="${color(it.halo.color)}" stroke-width="${fmt(it.halo.width, p)}" stroke-linejoin="round"/>`,
      );
    }
    if (d) out.push(`<path d="${d}" fill="${fill}" stroke="none"/>`);
    out.push('</g>');
    return;
  }
  const lines = splitLines(it.text);
  const m = emMetrics(fonts, it.font, !!it.bold);
  const y0 = baselineOffset(it.baseline, it.size, lines.length, m);
  const lh = LINE_HEIGHT * it.size;
  const paraDir = lineDirection(it.text);
  // With fonts we know each line's width, so RTL lines can be centred on their physical middle:
  // renderers disagree on how `direction` affects text-anchor, but 'middle' is unambiguous.
  const measured = fonts
    ? layoutText(fonts, it.text, {
        size: it.size,
        font: it.font,
        bold: it.bold,
        anchor: it.anchor,
        baseline: it.baseline,
      })
    : null;
  const common =
    attr('font-family', cssFontFamily(it.font)) +
    attr('font-size', fmt(it.size, p)) +
    (it.bold ? ' font-weight="bold"' : '') +
    ' xml:space="preserve"';
  out.push(`<g transform="${transform}"${common}${op < 1 ? attr('opacity', fmt(op, 4)) : ''}>`);
  const frac = anchorFraction(it.anchor);
  lines.forEach((line, i) => {
    if (!line) return;
    const rtl = lineDirection(line, paraDir) === 'rtl';
    let x = 0;
    let anchor: string;
    const ml = measured?.lines[i];
    if (rtl && ml && frac !== 0.5) {
      x = ml.x + ml.width / 2;
      anchor = 'middle';
    } else {
      // Anchors are physical (left/centre/right) in every backend; SVG's start/end follow direction.
      anchor = frac === 0.5 ? 'middle' : (frac === 0) !== rtl ? 'start' : 'end';
    }
    const dir = rtl ? ' direction="rtl" unicode-bidi="embed"' : '';
    const pos = `x="${fmt(x, p)}" y="${fmt(y0 + i * lh, p)}" text-anchor="${anchor}"${dir}`;
    const txt = xmlEscape(line);
    if (it.halo && it.halo.width > 0) {
      const hc = color(it.halo.color);
      out.push(
        `<text ${pos} fill="${hc}" stroke="${hc}" stroke-width="${fmt(it.halo.width, p)}" stroke-linejoin="round">${txt}</text>`,
      );
    }
    out.push(`<text ${pos} fill="${fill}">${txt}</text>`);
  });
  out.push('</g>');
}

function emitImage(
  ctx: Ctx,
  it: Pick<ImageItem, 'x' | 'y' | 'w' | 'h' | 'png' | 'rotation' | 'opacity'>,
  out: string[],
): void {
  if (!(it.w > 0 && it.h > 0) || !it.png.length) return;
  const p = ctx.p;
  const op = opacityOf(it.opacity);
  const rot = rotateDeg(it.rotation);
  out.push(
    `<image x="${fmt(it.x, p)}" y="${fmt(it.y, p)}" width="${fmt(it.w, p)}" height="${fmt(it.h, p)}" preserveAspectRatio="none"` +
      (rot ? ` transform="rotate(${fmt(rot, 6)} ${fmt(it.x, p)} ${fmt(it.y, p)})"` : '') +
      (op < 1 ? attr('opacity', fmt(op, 4)) : '') +
      ` xlink:href="data:image/png;base64,${base64Encode(it.png)}"/>`,
  );
}

function emitPdfPage(ctx: Ctx, it: PdfPageItem, out: string[]): void {
  if (it.fallbackPng) {
    const f = it.fallbackPng;
    emitImage(ctx, { x: f.x, y: f.y, w: f.w, h: f.h, png: f.png, opacity: it.opacity }, out);
  } else {
    out.push(
      `<!-- PDF page ${it.pageIndex + 1} omitted: SVG cannot embed PDF and no raster fallback was supplied -->`,
    );
  }
}

function emitGroup(ctx: Ctx, g: GroupItem, out: string[]): void {
  const op = opacityOf(g.opacity);
  if (op <= 0) return;
  const id = uniqueId(ctx, `${g.layer ? 'layer' : 'g'}-${g.name}`);
  let clip = '';
  if (g.clip && g.clip.length) {
    const cid = uniqueId(ctx, `clip-${g.name}`);
    ctx.defs.push(
      `<clipPath id="${cid}" clipPathUnits="userSpaceOnUse"><path d="${svgPathData(g.clip, ctx.p)}"/></clipPath>`,
    );
    clip = ` clip-path="url(#${cid})"`;
  }
  out.push(
    `<g id="${id}"${g.layer ? ' inkscape:groupmode="layer"' : ''}${attr('inkscape:label', g.name)}${op < 1 ? attr('opacity', fmt(op, 4)) : ''}${clip}>`,
  );
  for (const child of g.children) emitItem(ctx, child, out);
  out.push('</g>');
}

function emitItem(ctx: Ctx, it: SceneItem, out: string[]): void {
  switch (it.kind) {
    case 'path':
      emitPath(ctx, it, out);
      break;
    case 'text':
      emitText(ctx, it, out);
      break;
    case 'image':
      emitImage(ctx, it, out);
      break;
    case 'pdfPage':
      emitPdfPage(ctx, it, out);
      break;
    case 'group':
      emitGroup(ctx, it, out);
      break;
  }
}

/** Renders a scene as a standalone SVG 1.1 document (UTF-8). */
export function renderSceneSvg(scene: Scene, opts: SvgRenderOptions = {}): string {
  const ctx: Ctx = { defs: [], ids: new Set(), patterns: new Map(), p: opts.precision ?? 4, opts };
  const body: string[] = [];
  if (scene.background) {
    body.push(
      `<rect x="0" y="0" width="${fmt(scene.widthMm, ctx.p)}" height="${fmt(scene.heightMm, ctx.p)}" fill="${color(scene.background)}"/>`,
    );
  }
  for (const it of scene.items) emitItem(ctx, it, body);
  const W = fmt(scene.widthMm, ctx.p);
  const H = fmt(scene.heightMm, ctx.p);
  const head = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:inkscape="${INKSCAPE_NS}" version="1.1" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`,
  ];
  if (scene.meta?.title) head.push(`<title>${xmlEscape(scene.meta.title)}</title>`);
  const desc = [scene.meta?.subject, scene.meta?.author && `Author: ${scene.meta.author}`]
    .filter(Boolean)
    .join(' — ');
  if (desc) head.push(`<desc>${xmlEscape(desc)}</desc>`);
  if (ctx.defs.length) head.push('<defs>', ...ctx.defs, '</defs>');
  return [...head, ...body, '</svg>', ''].join('\n');
}
