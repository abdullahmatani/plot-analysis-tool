import fontkit from '@pdf-lib/fontkit';
import type { Font, Glyph } from '@pdf-lib/fontkit';

import {
  bidiClass,
  isArabicScript,
  mirrorCodePoint,
  paragraphLevel,
  reorderRuns,
  resolveLevels,
} from './bidi';
import type { BidiClass } from './bidi';
import type { FontFamily, PathCmd, TextAnchor, TextBaseline } from './scene';

/**
 * Bundled-font text engine for the export backends (row 48, C3). Fonts are passed in as bytes —
 * never fetched — and parsed with fontkit, which also provides OpenType shaping (Arabic joining,
 * ligatures, mark positioning, kerning) and glyph outlines. Works on the main thread and in
 * Web Workers.
 */

export type FontData = ArrayBuffer | Uint8Array;

export interface FontBytes {
  sans: FontData;
  sansBold?: FontData;
  arabic: FontData;
  arabicBold?: FontData;
  serif?: FontData;
  serifBold?: FontData;
  mono?: FontData;
  monoBold?: FontData;
  /** Extra fonts tried (in order) for code points no primary font covers, e.g. Hebrew. */
  fallbacks?: FontData[];
}

export interface LoadedFont {
  /** Stable key, e.g. 'sans', 'sansBold', 'arabic', 'fallback0'. */
  key: string;
  bytes: Uint8Array;
  font: Font;
  postscriptName: string;
  unitsPerEm: number;
  /** Ascender / descender (positive) / cap height, in em. */
  ascent: number;
  descent: number;
  capHeight: number;
  /** Glyph outline in font units, y-up (cached). Quadratic segments are converted to cubics. */
  outline(glyphId: number): PathCmd[];
  hasGlyph(cp: number): boolean;
}

export interface FontSet {
  readonly fonts: ReadonlyMap<string, LoadedFont>;
  /** Latin/primary font for a family (falls back to sans, and bold to regular). */
  primary(family: FontFamily, bold: boolean): LoadedFont;
  arabic(bold: boolean): LoadedFont;
  readonly fallbacks: readonly LoadedFont[];
  get(key: string): LoadedFont;
}

export interface EmMetrics {
  ascent: number;
  descent: number;
  capHeight: number;
}

/** Noto Sans metrics; used when no font set is available (canvas preview, SVG `<text>`). */
export const DEFAULT_METRICS: EmMetrics = { ascent: 1.069, descent: 0.293, capHeight: 0.714 };
export const LINE_HEIGHT = 1.2;

const toBytes = (d: FontData): Uint8Array => (d instanceof Uint8Array ? d : new Uint8Array(d));

function loadFont(key: string, data: FontData): LoadedFont {
  const bytes = toBytes(data);
  let font: Font;
  try {
    font = fontkit.create(bytes);
  } catch (e) {
    throw new Error(`Font "${key}" could not be parsed: ${(e as Error).message}`);
  }
  if (!font || typeof (font as Partial<Font>).layout !== 'function') {
    throw new Error(`Font "${key}" is not a single OpenType/TrueType font`);
  }
  const upem = font.unitsPerEm || 1000;
  const outlines = new Map<number, PathCmd[]>();
  const coverage = new Map<number, boolean>();
  return {
    key,
    bytes,
    font,
    postscriptName: font.postscriptName ?? key,
    unitsPerEm: upem,
    ascent: font.ascent / upem,
    descent: Math.abs(font.descent) / upem,
    capHeight: (font.capHeight || font.ascent * 0.7) / upem,
    outline(glyphId) {
      let o = outlines.get(glyphId);
      if (!o) {
        o = glyphToPath(font.getGlyph(glyphId));
        outlines.set(glyphId, o);
      }
      return o;
    },
    hasGlyph(cp) {
      let h = coverage.get(cp);
      if (h === undefined) {
        h = font.hasGlyphForCodePoint(cp);
        coverage.set(cp, h);
      }
      return h;
    },
  };
}

function glyphToPath(glyph: Glyph): PathCmd[] {
  const out: PathCmd[] = [];
  let cmds: { command: string; args: number[] }[];
  try {
    cmds = (glyph.path as unknown as { commands: { command: string; args: number[] }[] }).commands ?? [];
  } catch {
    return out;
  }
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const { command, args } of cmds) {
    switch (command) {
      case 'moveTo':
        out.push({ op: 'M', x: args[0], y: args[1] });
        cx = sx = args[0];
        cy = sy = args[1];
        break;
      case 'lineTo':
        out.push({ op: 'L', x: args[0], y: args[1] });
        cx = args[0];
        cy = args[1];
        break;
      case 'quadraticCurveTo': {
        const [qx, qy, x, y] = args;
        out.push({
          op: 'C',
          x1: cx + (2 / 3) * (qx - cx),
          y1: cy + (2 / 3) * (qy - cy),
          x2: x + (2 / 3) * (qx - x),
          y2: y + (2 / 3) * (qy - y),
          x,
          y,
        });
        cx = x;
        cy = y;
        break;
      }
      case 'bezierCurveTo': {
        const [x1, y1, x2, y2, x, y] = args;
        out.push({ op: 'C', x1, y1, x2, y2, x, y });
        cx = x;
        cy = y;
        break;
      }
      case 'closePath':
        out.push({ op: 'Z' });
        cx = sx;
        cy = sy;
        break;
      default:
        break;
    }
  }
  return out;
}

/** Parses the bundled fonts (synchronous; fontkit parsing is lazy per table). */
export function createFontSet(bytes: FontBytes): FontSet {
  const fonts = new Map<string, LoadedFont>();
  const add = (key: string, data: FontData | undefined) => {
    if (data) fonts.set(key, loadFont(key, data));
  };
  add('sans', bytes.sans);
  add('sansBold', bytes.sansBold);
  add('arabic', bytes.arabic);
  add('arabicBold', bytes.arabicBold);
  add('serif', bytes.serif);
  add('serifBold', bytes.serifBold);
  add('mono', bytes.mono);
  add('monoBold', bytes.monoBold);
  const fallbacks: LoadedFont[] = [];
  (bytes.fallbacks ?? []).forEach((d, i) => {
    const f = loadFont(`fallback${i}`, d);
    fonts.set(f.key, f);
    fallbacks.push(f);
  });
  const get = (key: string): LoadedFont => {
    const f = fonts.get(key);
    if (!f) throw new Error(`Unknown font key "${key}"`);
    return f;
  };
  return {
    fonts,
    fallbacks,
    get,
    primary(family, bold) {
      const base = fonts.has(family) ? family : 'sans';
      return (bold && fonts.get(`${base}Bold`)) || get(base);
    },
    arabic(bold) {
      return (bold && fonts.get('arabicBold')) || get('arabic');
    },
  };
}

/** Em metrics of the primary font for a family (or the Noto Sans defaults). */
export function emMetrics(fonts: FontSet | undefined, family: FontFamily = 'sans', bold = false): EmMetrics {
  if (!fonts) return DEFAULT_METRICS;
  const f = fonts.primary(family, bold);
  return { ascent: f.ascent, descent: f.descent, capHeight: f.capHeight };
}

/**
 * Offset (y-down, mm) from the anchor point to the first line's baseline for a block of
 * `lineCount` lines. Shared by every backend so canvas, SVG and PDF place text identically.
 */
export function baselineOffset(
  baseline: TextBaseline,
  size: number,
  lineCount: number,
  m: EmMetrics = DEFAULT_METRICS,
  lineHeight = LINE_HEIGHT,
): number {
  const a = m.ascent * size;
  const d = m.descent * size;
  const span = Math.max(0, lineCount - 1) * lineHeight * size;
  switch (baseline) {
    case 'alphabetic':
      return 0;
    case 'top':
      return a;
    case 'hanging':
      return m.capHeight * size;
    case 'bottom':
      return -(span + d);
    case 'middle':
      return -(span + d - a) / 2;
  }
}

/** Fraction of the line width to the left of the anchor. */
export function anchorFraction(anchor: TextAnchor): number {
  return anchor === 'middle' ? 0.5 : anchor === 'end' ? 1 : 0;
}

const LINE_BREAK = new RegExp('\\r\\n|[\\n\\r\\u2028\\u2029]');

/** Splits text into lines on \n, \r\n, \r, U+2028 and U+2029. */
export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/** Base direction of a line from its first strong character. */
export function lineDirection(text: string, fallback: 'ltr' | 'rtl' = 'ltr'): 'ltr' | 'rtl' {
  const cps = [...text].map((c) => c.codePointAt(0)!);
  return paragraphLevel(cps, fallback === 'rtl' ? 1 : 0) ? 'rtl' : 'ltr';
}

export interface TextLayoutOptions {
  /** Font size (em) in mm. */
  size: number;
  font?: FontFamily;
  bold?: boolean;
  /** Horizontal anchor of every line relative to x = 0 (default 'start' = left end). */
  anchor?: TextAnchor;
  /** Vertical reference at y = 0 (default 'alphabetic' = first baseline). */
  baseline?: TextBaseline;
  /** Paragraph direction; 'auto' (default) uses the first strong character of each line. */
  direction?: 'auto' | 'ltr' | 'rtl';
  /** Line height as a multiple of size (default 1.2). */
  lineHeight?: number;
}

export interface ShapedGlyph {
  fontKey: string;
  glyphId: number;
  /** Glyph origin (on the baseline) relative to the anchor, mm, y-down. */
  x: number;
  y: number;
  /** mm per font unit (glyph outline units are y-up). */
  scale: number;
  /** Advance in mm. */
  advance: number;
  line: number;
  /** True for glyphs without an outline (spaces, ignorables). */
  blank: boolean;
  /** Outline in mm relative to the anchor, y-down (computed lazily, cached). Empty when blank. */
  readonly cmds: PathCmd[];
}

/** ShapedGlyph whose placed outline is only built when `cmds` is first read. */
class LazyGlyph implements ShapedGlyph {
  private placed: PathCmd[] | undefined;
  readonly blank: boolean;

  constructor(
    private readonly unit: PathCmd[],
    readonly fontKey: string,
    readonly glyphId: number,
    readonly x: number,
    readonly y: number,
    readonly scale: number,
    readonly advance: number,
    readonly line: number,
  ) {
    this.blank = unit.length === 0;
  }

  get cmds(): PathCmd[] {
    this.placed ??= this.blank ? [] : placeOutline(this.unit, this.x, this.y, this.scale);
    return this.placed;
  }
}

/** A shaped single-font, single-direction run (visual order within its line). */
export interface ShapedRun {
  fontKey: string;
  /** Logical text of the run (before mirroring). */
  text: string;
  rtl: boolean;
  /** Left end of the run and its baseline, relative to the anchor (mm, y-down). */
  x: number;
  y: number;
  width: number;
  line: number;
  size: number;
}

export interface TextLine {
  text: string;
  /** Left end and baseline relative to the anchor. */
  x: number;
  y: number;
  width: number;
  rtl: boolean;
}

export interface TextLayout {
  /** Width of the widest line (mm). */
  width: number;
  /** Primary font ascent / descent (mm, positive). */
  ascent: number;
  descent: number;
  lineHeight: number;
  lines: TextLine[];
  runs: ShapedRun[];
  glyphs: ShapedGlyph[];
  /** Layout box (ascent of first line to descent of last line), relative to the anchor. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Direction of the first line. */
  rtl: boolean;
}

interface UnitGlyph {
  id: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}

interface UnitRun {
  font: LoadedFont;
  text: string;
  rtl: boolean;
  glyphs: UnitGlyph[];
  /** Advance in font units. */
  advance: number;
}

interface FontkitRun {
  glyphs: Glyph[];
  positions: { xAdvance: number; xOffset: number; yOffset: number }[];
}

type FontkitLayout = (
  text: string,
  features?: unknown,
  script?: string,
  language?: string,
  direction?: string,
) => FontkitRun;

/**
 * fontkit `layout` with explicit script and direction (the bundled typings only declare the first
 * two parameters). RTL runs come back in visual (left-to-right) order.
 */
export function shapeWithFontkit(
  font: Font,
  text: string,
  script?: string,
  direction?: 'ltr' | 'rtl',
): FontkitRun {
  return (font.layout as unknown as FontkitLayout).call(font, text, undefined, script, undefined, direction);
}

const SHAPE_CACHE_LIMIT = 4000;
const shapeCaches = new WeakMap<FontSet, Map<string, UnitRun[]>>();

/** Shapes one line into visual-order runs in font units (cached per font set). */
function shapeLine(
  fonts: FontSet,
  text: string,
  family: FontFamily,
  bold: boolean,
  direction: 'auto' | 'ltr' | 'rtl',
  fallbackLevel: 0 | 1,
): UnitRun[] {
  let cache = shapeCaches.get(fonts);
  if (!cache) {
    cache = new Map();
    shapeCaches.set(fonts, cache);
  }
  const key = `${family}|${bold ? 1 : 0}|${direction}|${fallbackLevel}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const cps = [...text].map((c) => c.codePointAt(0)!);
  const para: 0 | 1 = direction === 'auto' ? paragraphLevel(cps, fallbackLevel) : direction === 'rtl' ? 1 : 0;
  const levels = resolveLevels(cps, para);
  const primary = fonts.primary(family, bold);
  const arabic = fonts.arabic(bold);

  // Font per code point.
  const fontFor: LoadedFont[] = new Array(cps.length);
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const cls: BidiClass = bidiClass(cp);
    if ((cls === 'NSM' || cls === 'BN') && i > 0 && fontFor[i - 1].hasGlyph(cp)) {
      fontFor[i] = fontFor[i - 1];
      continue;
    }
    let order: LoadedFont[];
    if (isArabicScript(cp)) order = [arabic, primary];
    else if (cls === 'L') order = [primary, arabic];
    else if (cls === 'R') order = [primary, arabic];
    else order = levels[i] % 2 ? [arabic, primary] : [primary, arabic];
    fontFor[i] = order.find((f) => f.hasGlyph(cp)) ?? fonts.fallbacks.find((f) => f.hasGlyph(cp)) ?? primary;
  }

  // Logical runs of equal level and font.
  const logical: { start: number; end: number; level: number; font: LoadedFont }[] = [];
  for (let i = 0; i < cps.length; i++) {
    const last = logical[logical.length - 1];
    if (last && last.level === levels[i] && last.font === fontFor[i]) last.end = i + 1;
    else logical.push({ start: i, end: i + 1, level: levels[i], font: fontFor[i] });
  }

  const visual = reorderRuns(logical.map((r) => r.level));
  const runs: UnitRun[] = visual.map((idx) => {
    const r = logical[idx];
    const rtl = r.level % 2 === 1;
    const slice = cps.slice(r.start, r.end);
    const shapedText = String.fromCodePoint(...(rtl ? slice.map(mirrorCodePoint) : slice));
    const script = r.font === arabic || slice.some(isArabicScript) ? 'arab' : undefined;
    const run = shapeWithFontkit(r.font.font, shapedText, script, rtl ? 'rtl' : 'ltr');
    const glyphs: UnitGlyph[] = run.glyphs.map((g, k) => ({
      id: g.id,
      xAdvance: run.positions[k]?.xAdvance ?? g.advanceWidth,
      xOffset: run.positions[k]?.xOffset ?? 0,
      yOffset: run.positions[k]?.yOffset ?? 0,
    }));
    // fontkit returns RTL runs already in visual (left-to-right) order.
    return {
      font: r.font,
      text: String.fromCodePoint(...slice),
      rtl,
      glyphs,
      advance: glyphs.reduce((s, g) => s + g.xAdvance, 0),
    };
  });
  if (cache.size >= SHAPE_CACHE_LIMIT) cache.clear();
  cache.set(key, runs);
  return runs;
}

/**
 * Shapes and lays out (possibly multi-line, bidirectional) text. Positions are in mm relative to
 * the anchor point, y-down; each line is anchored individually (`anchor`) and the block is placed
 * vertically by `baseline`.
 */
export function layoutText(fonts: FontSet, text: string, opts: TextLayoutOptions): TextLayout {
  const family = opts.font ?? 'sans';
  const bold = !!opts.bold;
  const size = opts.size;
  const lh = (opts.lineHeight ?? LINE_HEIGHT) * size;
  const metrics = emMetrics(fonts, family, bold);
  const lineTexts = splitLines(text);
  const dir = opts.direction ?? 'auto';
  const firstLevel: 0 | 1 =
    dir === 'rtl'
      ? 1
      : dir === 'ltr'
        ? 0
        : paragraphLevel(
            [...text].map((c) => c.codePointAt(0)!),
            0,
          );
  const y0 = baselineOffset(
    opts.baseline ?? 'alphabetic',
    size,
    lineTexts.length,
    metrics,
    opts.lineHeight ?? LINE_HEIGHT,
  );
  const frac = anchorFraction(opts.anchor ?? 'start');

  const lines: TextLine[] = [];
  const runsOut: ShapedRun[] = [];
  const glyphsOut: ShapedGlyph[] = [];
  let width = 0;
  lineTexts.forEach((lineText, li) => {
    const runs = shapeLine(fonts, lineText, family, bold, dir, firstLevel);
    const lineWidth = runs.reduce((s, r) => s + (r.advance * size) / r.font.unitsPerEm, 0);
    const x0 = frac ? -frac * lineWidth : 0;
    const baseY = y0 + li * lh;
    const rtl =
      dir === 'auto' ? lineDirection(lineText, firstLevel ? 'rtl' : 'ltr') === 'rtl' : dir === 'rtl';
    lines.push({ text: lineText, x: x0, y: baseY, width: lineWidth, rtl });
    width = Math.max(width, lineWidth);
    let pen = x0;
    for (const run of runs) {
      const scale = size / run.font.unitsPerEm;
      const runX = pen;
      for (const g of run.glyphs) {
        const gx = pen + g.xOffset * scale;
        const gy = baseY - g.yOffset * scale;
        const unit = run.font.outline(g.id);
        glyphsOut.push(new LazyGlyph(unit, run.font.key, g.id, gx, gy, scale, g.xAdvance * scale, li));
        pen += g.xAdvance * scale;
      }
      runsOut.push({
        fontKey: run.font.key,
        text: run.text,
        rtl: run.rtl,
        x: runX,
        y: baseY,
        width: pen - runX,
        line: li,
        size,
      });
    }
  });
  const ascent = metrics.ascent * size;
  const descent = metrics.descent * size;
  const minX = lines.length ? Math.min(...lines.map((l) => l.x)) : 0;
  const maxX = lines.length ? Math.max(...lines.map((l) => l.x + l.width)) : 0;
  return {
    width,
    ascent,
    descent,
    lineHeight: lh,
    lines,
    runs: runsOut,
    glyphs: glyphsOut,
    bounds: { minX, minY: y0 - ascent, maxX, maxY: y0 + (lines.length - 1) * lh + descent },
    rtl: lines[0]?.rtl ?? false,
  };
}

/** Maps a font-unit (y-up) outline to mm (y-down) at glyph origin (gx, gy). */
export function placeOutline(unit: readonly PathCmd[], gx: number, gy: number, scale: number): PathCmd[] {
  return unit.map((c): PathCmd => {
    switch (c.op) {
      case 'M':
      case 'L':
        return { op: c.op, x: gx + c.x * scale, y: gy - c.y * scale };
      case 'C':
        return {
          op: 'C',
          x1: gx + c.x1 * scale,
          y1: gy - c.y1 * scale,
          x2: gx + c.x2 * scale,
          y2: gy - c.y2 * scale,
          x: gx + c.x * scale,
          y: gy - c.y * scale,
        };
      case 'Z':
        return c;
    }
  });
}

/** All glyph outlines of a layout concatenated into one path (mm, relative to the anchor). */
export function layoutToPath(layout: TextLayout): PathCmd[] {
  const out: PathCmd[] = [];
  for (const g of layout.glyphs) for (const c of g.cmds) out.push(c);
  return out;
}

/** CSS font-family list for canvas/SVG text using the bundled Noto fonts. */
export function cssFontFamily(family: FontFamily): string {
  switch (family) {
    case 'serif':
      return "'Noto Serif', 'Noto Sans Arabic', serif";
    case 'mono':
      return "'Noto Sans Mono', 'Noto Sans Arabic', monospace";
    default:
      return "'Noto Sans', 'Noto Sans Arabic', sans-serif";
  }
}
