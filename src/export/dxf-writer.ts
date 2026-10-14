import type { Pt, Units, Vertex } from '@/core/types';

import { layoutText } from './fonts';
import type { FontSet } from './fonts';
import { parseColor } from './format';
import { flattenPath } from './scene';
import type { FontFamily, TextAnchor, TextBaseline } from './scene';

/**
 * DXF R2010 (AC1024) ASCII writer for the analysis export (row 79).
 *
 * Produces a complete drawing database that AutoCAD opens without audit errors: HEADER, CLASSES,
 * all nine symbol tables, *Model_Space / *Paper_Space blocks, entities with unique handles, owners
 * and subclass markers, and the OBJECTS section (root dictionary, ACAD_GROUP, ACAD_LAYOUT with
 * Model/Layout1 layouts, ACAD_PLOTSTYLENAME, ACAD_MLINESTYLE …). Coordinates are written with
 * the shortest round-trip float64 representation (never exponents for normal magnitudes), so large
 * plant coordinates survive exactly. Strings are UTF-8, as R2007+ requires.
 */

export type DxfColor = string | number;

export interface DxfLayerOptions {
  name: string;
  /** '#rrggbb' (written as nearest ACI + true colour) or an ACI number 1–255. Default 7. */
  color?: DxfColor;
  /** Linetype name (must be defined, e.g. 'Continuous', 'DASHED'). Default 'Continuous'. */
  linetype?: string;
  /** Lineweight in mm (snapped to the DXF set). Default: "Default". */
  lineweight?: number;
  plot?: boolean;
  off?: boolean;
  frozen?: boolean;
  locked?: boolean;
}

export interface DxfEntityStyle {
  /** Default ByLayer. 0 = ByBlock, 256 = ByLayer, 1–255 ACI, or '#rrggbb'. */
  color?: DxfColor;
  /** Default ByLayer. */
  linetype?: string;
  /** mm; default ByLayer. */
  lineweight?: number;
  /** Linetype scale (group 48). */
  ltscale?: number;
  /** 0 = opaque … 0.9 = 90 % transparent. */
  transparency?: number;
}

export type DxfHAlign = 'left' | 'center' | 'right';
export type DxfVAlign = 'baseline' | 'bottom' | 'middle' | 'top';

export interface DxfTextOptions extends DxfEntityStyle {
  height: number;
  /** Radians, counter-clockwise. */
  rotation?: number;
  hAlign?: DxfHAlign;
  vAlign?: DxfVAlign;
  /** Text style; default 'Standard' for ASCII text and the TrueType 'Unicode' style otherwise. */
  style?: string;
  widthFactor?: number;
}

export type MTextAttachment =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'middle-center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface DxfMTextOptions extends DxfEntityStyle {
  height: number;
  rotation?: number;
  attachment?: MTextAttachment;
  /** Reference rectangle width (0 = no wrapping). */
  width?: number;
  /** Line spacing factor (default 1). */
  lineSpacing?: number;
  style?: string;
}

export interface DxfHatchOptions extends DxfEntityStyle {
  /** Island style: 'odd' (normal, even-odd parity — default), 'outer' or 'ignore'. */
  style?: 'odd' | 'outer' | 'ignore';
}

export interface DxfPolylineOptions extends DxfEntityStyle {
  /** Constant width (group 43). */
  width?: number;
  elevation?: number;
}

export interface DxfWriterOptions {
  /** Drawing units for $INSUNITS / $MEASUREMENT. Default 'm'. */
  units?: Units | 'unitless';
  /** Default '\r\n' (as written by AutoCAD). */
  lineEnding?: '\n' | '\r\n';
  /** Write non-ASCII characters as \U+XXXX escapes instead of raw UTF-8. */
  escapeUnicode?: boolean;
  /** $LTSCALE (global linetype scale). Default 1. */
  ltscale?: number;
  /** TrueType file of the 'Unicode' text style. Default 'arial.ttf'. */
  unicodeFont?: string;
  /** $PDMODE / $PDSIZE for POINT display. */
  pointMode?: number;
  pointSize?: number;
}

const INSUNITS: Record<Units | 'unitless', number> = { unitless: 0, in: 1, ft: 2, mm: 4, cm: 5, m: 6, km: 7 };
const LINEWEIGHTS = [
  0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211,
];
const ATTACH: Record<MTextAttachment, number> = {
  'top-left': 1,
  'top-center': 2,
  'top-right': 3,
  'middle-left': 4,
  'middle-center': 5,
  'middle-right': 6,
  'bottom-left': 7,
  'bottom-center': 8,
  'bottom-right': 9,
};
const H_ALIGN: Record<DxfHAlign, number> = { left: 0, center: 1, right: 2 };
const V_ALIGN: Record<DxfVAlign, number> = { baseline: 0, bottom: 1, middle: 2, top: 3 };

export const STANDARD_LINETYPES: Record<string, { description: string; pattern: number[] }> = {
  DASHED: { description: 'Dashed __ __ __ __ __ __ __ __', pattern: [0.5, -0.25] },
  DASHEDX2: { description: 'Dashed (2x) ____  ____  ____  ____', pattern: [1.0, -0.5] },
  DOT: { description: 'Dot . . . . . . . . . . . . . . . .', pattern: [0, -0.25] },
  DASHDOT: { description: 'Dash dot __ . __ . __ . __ . __ .', pattern: [0.5, -0.25, 0, -0.25] },
};

/** Maps the core dash styles to the predefined DXF linetypes. */
export const DASH_TO_LINETYPE: Record<'solid' | 'dash' | 'dot' | 'dash-dot' | 'long-dash', string> = {
  solid: 'Continuous',
  dash: 'DASHED',
  dot: 'DOT',
  'dash-dot': 'DASHDOT',
  'long-dash': 'DASHEDX2',
};

// ---------------------------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------------------------

/**
 * Shortest float64 representation that round-trips exactly (JS `String(n)`), with a decimal point
 * and without exponent notation for magnitudes in [1e-20, 1e21).
 */
export function dxfFloat(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0.0';
  let s = String(n);
  if (s.includes('e')) {
    if (Math.abs(n) >= 1e21) return s;
    s = n.toFixed(20).replace(/0+$/, '');
    if (/^-?0\.$/.test(s)) return '0.0';
    return s;
  }
  return s.includes('.') ? s : `${s}.0`;
}

const degrees = (rad: number): number => {
  let d = ((rad * 180) / Math.PI) % 360;
  if (d < 0) d += 360;
  d = Math.round(d * 1e12) / 1e12;
  return d >= 360 ? d - 360 : d;
};

// ---------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------

/** AutoCAD Color Index → 0xRRGGBB (index 0 and 7 are special; 7 is listed as white). */
export const ACI_RGB: readonly number[] = (() => {
  const t = new Array<number>(256).fill(0);
  [0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0].forEach(
    (c, i) => (t[i + 1] = c),
  );
  const vs = [1, 0.65, 0.5, 0.3, 0.15];
  for (let i = 10; i < 250; i++) {
    const h = (Math.floor(i / 10) - 1) * 15;
    const s = i % 2 ? 0.5 : 1;
    const v = vs[Math.floor((i % 10) / 2)];
    const f = (n: number) => {
      const k = (n + h / 60) % 6;
      return Math.floor(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
    };
    t[i] = (f(5) << 16) | (f(3) << 8) | f(1);
  }
  [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff].forEach((c, i) => (t[250 + i] = c));
  return t;
})();

/** Nearest ACI (1–255, excluding 7) to an RGB colour; black and white map to 7. */
export function nearestAci(r: number, g: number, b: number): number {
  if ((r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255)) return 7;
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < 256; i++) {
    if (i === 7) continue;
    const c = ACI_RGB[i];
    const d = (r - ((c >> 16) & 255)) ** 2 + (g - ((c >> 8) & 255)) ** 2 + (b - (c & 255)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

interface ResolvedColor {
  aci: number;
  trueColor?: number;
}

function resolveColor(c: DxfColor | undefined, fallback: number): ResolvedColor {
  if (c === undefined) return { aci: fallback };
  if (typeof c === 'number') return { aci: Math.max(0, Math.min(256, Math.round(c))) };
  const { r, g, b } = parseColor(c);
  const aci = nearestAci(r, g, b);
  if (aci === 7) return { aci };
  return { aci, trueColor: (r << 16) | (g << 8) | b };
}

function snapLineweight(mm: number): number {
  const v = mm * 100;
  let best = LINEWEIGHTS[0];
  for (const w of LINEWEIGHTS) if (Math.abs(w - v) < Math.abs(best - v)) best = w;
  return best;
}

const FORBIDDEN_NAME_CHARS = new Set([...'<>/\\":;?*|=`']);

/** Layer/style names: AutoCAD forbids < > / \ " : ; ? * | = ` and control characters. */
export function sanitizeName(name: string): string {
  const mapped = [...name].map((ch) => (ch.charCodeAt(0) < 0x20 || FORBIDDEN_NAME_CHARS.has(ch) ? '_' : ch));
  const s = [...mapped.join('').trim()].slice(0, 255).join('');
  return s || '_';
}

// ---------------------------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------------------------

class Out {
  readonly lines: string[] = [];
  constructor(private readonly enc: (s: string) => string) {}
  g(code: number, value: string | number): void {
    this.lines.push(code < 100 ? String(code).padStart(3, ' ') : String(code), String(value));
  }
  s(code: number, value: string): void {
    this.g(code, this.enc(value));
  }
  f(code: number, value: number): void {
    this.g(code, dxfFloat(value));
  }
  i(code: number, value: number): void {
    this.g(code, String(Math.round(value)));
  }
  pt(code: number, x: number, y: number, z: number | null = 0): void {
    this.f(code, x);
    this.f(code + 10, y);
    if (z !== null) this.f(code + 20, z);
  }
}

class Handles {
  private n = 1;
  next(): string {
    return (this.n++).toString(16).toUpperCase();
  }
  get seed(): string {
    return this.n.toString(16).toUpperCase();
  }
}

interface LayerRec {
  name: string;
  color: ResolvedColor;
  linetype: string;
  lineweight: number;
  plot: boolean;
  off: boolean;
  flags: number;
}

interface EntityRec {
  type: string;
  layer: string;
  style: DxfEntityStyle;
  body: (o: Out) => void;
}

const NEWLINES = new RegExp('\\r\\n|[\\n\\r\\u2028\\u2029]', 'g');

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

function assertFinite(...values: number[]): void {
  for (const v of values) if (!Number.isFinite(v)) throw new Error('DXF: non-finite coordinate or size');
}

export class DxfWriter {
  private readonly layers = new Map<string, LayerRec>();
  private readonly linetypes = new Map<string, { name: string; description: string; pattern: number[] }>();
  private readonly styles = new Map<string, { name: string; font: string; widthFactor: number }>();
  private readonly entities: EntityRec[] = [];
  private readonly ext = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  private readonly opts: Required<Omit<DxfWriterOptions, 'pointMode' | 'pointSize'>> &
    Pick<DxfWriterOptions, 'pointMode' | 'pointSize'>;

  constructor(opts: DxfWriterOptions = {}) {
    this.opts = {
      units: opts.units ?? 'm',
      lineEnding: opts.lineEnding ?? '\r\n',
      escapeUnicode: opts.escapeUnicode ?? false,
      ltscale: opts.ltscale ?? 1,
      unicodeFont: opts.unicodeFont ?? 'arial.ttf',
      pointMode: opts.pointMode,
      pointSize: opts.pointSize,
    };
    this.layers.set('0', {
      name: '0',
      color: { aci: 7 },
      linetype: 'Continuous',
      lineweight: -3,
      plot: true,
      off: false,
      flags: 0,
    });
    for (const [name, lt] of Object.entries(STANDARD_LINETYPES))
      this.linetypes.set(name.toUpperCase(), { name, ...lt });
    this.styles.set('STANDARD', { name: 'Standard', font: 'txt', widthFactor: 1 });
    this.styles.set('UNICODE', { name: 'Unicode', font: this.opts.unicodeFont, widthFactor: 1 });
  }

  /** Number of entities added so far. */
  get entityCount(): number {
    return this.entities.length;
  }

  /** Adds (or updates) a layer and returns its sanitised name. Names are case-insensitive. */
  addLayer(o: DxfLayerOptions): string {
    const name = sanitizeName(o.name);
    const lt = o.linetype ? this.linetypeName(o.linetype) : 'Continuous';
    const rec: LayerRec = {
      name,
      color: resolveColor(o.color, 7),
      linetype: lt === 'ByLayer' || lt === 'ByBlock' ? 'Continuous' : lt,
      lineweight: o.lineweight === undefined ? -3 : snapLineweight(o.lineweight),
      plot: o.plot ?? true,
      off: o.off ?? false,
      flags: (o.frozen ? 1 : 0) | (o.locked ? 4 : 0),
    };
    if (rec.color.aci === 0 || rec.color.aci === 256) rec.color = { aci: 7 };
    this.layers.set(name.toLowerCase(), rec);
    return name;
  }

  /** Defines a linetype; `pattern` lengths in drawing units (positive dash, negative gap, 0 dot). */
  addLinetype(name: string, pattern: number[], description = ''): string {
    const n = sanitizeName(name);
    assertFinite(...pattern);
    this.linetypes.set(n.toUpperCase(), { name: n, description, pattern: [...pattern] });
    return n;
  }

  /** Defines a text style using a font file (SHX or TrueType). */
  addTextStyle(name: string, font: string, widthFactor = 1): string {
    const n = sanitizeName(name);
    this.styles.set(n.toUpperCase(), { name: n, font, widthFactor });
    return n;
  }

  private linetypeName(name: string): string {
    const u = name.toUpperCase();
    if (u === 'BYLAYER') return 'ByLayer';
    if (u === 'BYBLOCK') return 'ByBlock';
    if (u === 'CONTINUOUS') return 'Continuous';
    const lt = this.linetypes.get(u);
    if (!lt) throw new Error(`DXF: linetype "${name}" is not defined`);
    return lt.name;
  }

  private layerName(layer: string): string {
    const name = sanitizeName(layer);
    const rec = this.layers.get(name.toLowerCase());
    if (rec) return rec.name;
    return this.addLayer({ name });
  }

  private grow(x: number, y: number, r = 0): void {
    if (x - r < this.ext.minX) this.ext.minX = x - r;
    if (y - r < this.ext.minY) this.ext.minY = y - r;
    if (x + r > this.ext.maxX) this.ext.maxX = x + r;
    if (y + r > this.ext.maxY) this.ext.maxY = y + r;
  }

  private add(type: string, layer: string, style: DxfEntityStyle | undefined, body: (o: Out) => void): this {
    const st: DxfEntityStyle = { ...style };
    if (st.linetype) st.linetype = this.linetypeName(st.linetype);
    this.entities.push({ type, layer: this.layerName(layer), style: st, body });
    return this;
  }

  line(layer: string, a: Pt, b: Pt, style?: DxfEntityStyle): this {
    assertFinite(a.x, a.y, b.x, b.y);
    this.grow(a.x, a.y);
    this.grow(b.x, b.y);
    return this.add('LINE', layer, style, (o) => {
      o.g(100, 'AcDbLine');
      o.pt(10, a.x, a.y);
      o.pt(11, b.x, b.y);
    });
  }

  /** LWPOLYLINE with optional bulges (Vertex.bulge = tan(θ/4)). */
  polyline(layer: string, pts: readonly Vertex[], closed: boolean, style?: DxfPolylineOptions): this {
    const verts = pts.map((p) => ({ x: p.x, y: p.y, bulge: p.bulge ?? 0 }));
    if (verts.length < 2) throw new Error('DXF: polyline needs at least two vertices');
    for (const v of verts) {
      assertFinite(v.x, v.y, v.bulge);
      this.grow(v.x, v.y);
    }
    growBulges(verts, closed, (x, y, r) => this.grow(x, y, r));
    return this.add('LWPOLYLINE', layer, style, (o) => {
      o.g(100, 'AcDbPolyline');
      o.i(90, verts.length);
      o.i(70, closed ? 1 : 0);
      if (style?.width !== undefined) o.f(43, style.width);
      if (style?.elevation) o.f(38, style.elevation);
      for (const v of verts) {
        o.pt(10, v.x, v.y, null);
        if (v.bulge) o.f(42, v.bulge);
      }
    });
  }

  circle(layer: string, c: Pt, r: number, style?: DxfEntityStyle): this {
    assertFinite(c.x, c.y, r);
    if (!(r > 0)) throw new Error('DXF: circle radius must be positive');
    this.grow(c.x, c.y, r);
    return this.add('CIRCLE', layer, style, (o) => {
      o.g(100, 'AcDbCircle');
      o.pt(10, c.x, c.y);
      o.f(40, r);
    });
  }

  /** Arc from `start` to `end` (radians), counter-clockwise. */
  arc(layer: string, c: Pt, r: number, start: number, end: number, style?: DxfEntityStyle): this {
    assertFinite(c.x, c.y, r, start, end);
    if (!(r > 0)) throw new Error('DXF: arc radius must be positive');
    this.grow(c.x, c.y, r);
    return this.add('ARC', layer, style, (o) => {
      o.g(100, 'AcDbCircle');
      o.pt(10, c.x, c.y);
      o.f(40, r);
      o.g(100, 'AcDbArc');
      o.f(50, degrees(start));
      o.f(51, degrees(end));
    });
  }

  /**
   * Ellipse with centre `c`, major-axis end point relative to the centre, minor/major `ratio`
   * (0 < ratio ≤ 1) and parameter range (radians, CCW; full ellipse by default).
   */
  ellipse(
    layer: string,
    c: Pt,
    majorAxis: Pt,
    ratio: number,
    start = 0,
    end = Math.PI * 2,
    style?: DxfEntityStyle,
  ): this {
    assertFinite(c.x, c.y, majorAxis.x, majorAxis.y, ratio, start, end);
    const len = Math.hypot(majorAxis.x, majorAxis.y);
    if (!(len > 0) || !(ratio > 0 && ratio <= 1)) throw new Error('DXF: invalid ellipse axes');
    this.grow(c.x, c.y, len);
    return this.add('ELLIPSE', layer, style, (o) => {
      o.g(100, 'AcDbEllipse');
      o.pt(10, c.x, c.y);
      o.pt(11, majorAxis.x, majorAxis.y);
      o.pt(210, 0, 0, 1);
      o.f(40, ratio);
      o.f(41, start);
      o.f(42, end);
    });
  }

  point(layer: string, p: Pt, style?: DxfEntityStyle): this {
    assertFinite(p.x, p.y);
    this.grow(p.x, p.y);
    return this.add('POINT', layer, style, (o) => {
      o.g(100, 'AcDbPoint');
      o.pt(10, p.x, p.y);
    });
  }

  /** Solid-fill HATCH with one polyline boundary loop per ring (bulges allowed). */
  hatch(layer: string, rings: readonly (readonly Vertex[])[], opts: DxfHatchOptions = {}): this {
    const loops = rings
      .map((ring) => {
        const v = ring.map((p) => ({ x: p.x, y: p.y, bulge: p.bulge ?? 0 }));
        if (
          v.length > 1 &&
          v[0].x === v[v.length - 1].x &&
          v[0].y === v[v.length - 1].y &&
          !v[v.length - 1].bulge
        )
          v.pop();
        return v;
      })
      .filter((v) => v.length >= 3 || (v.length === 2 && v.some((p) => p.bulge)));
    if (!loops.length) return this;
    for (const loop of loops) {
      for (const v of loop) {
        assertFinite(v.x, v.y, v.bulge);
        this.grow(v.x, v.y);
      }
      growBulges(loop, true, (x, y, r) => this.grow(x, y, r));
    }
    const external = loops.map(
      (loop, i) => loops.filter((other, j) => j !== i && pointInRing(loop[0], other)).length % 2 === 0,
    );
    const style = { ...opts };
    const island = opts.style === 'outer' ? 1 : opts.style === 'ignore' ? 2 : 0;
    return this.add('HATCH', layer, style, (o) => {
      o.g(100, 'AcDbHatch');
      o.pt(10, 0, 0, 0);
      o.pt(210, 0, 0, 1);
      o.s(2, 'SOLID');
      o.i(70, 1);
      o.i(71, 0);
      o.i(91, loops.length);
      loops.forEach((loop, i) => {
        const hasBulge = loop.some((v) => v.bulge);
        o.i(92, external[i] ? 3 : 2);
        o.i(72, hasBulge ? 1 : 0);
        o.i(73, 1);
        o.i(93, loop.length);
        for (const v of loop) {
          o.pt(10, v.x, v.y, null);
          if (hasBulge) o.f(42, v.bulge);
        }
        o.i(97, 0);
      });
      o.i(75, island);
      o.i(76, 1);
      o.i(98, 0);
    });
  }

  /** Single-line TEXT (newlines become spaces; at most 255 characters). */
  text(layer: string, p: Pt, text: string, opts: DxfTextOptions): this {
    assertFinite(p.x, p.y, opts.height, opts.rotation ?? 0);
    if (!(opts.height > 0)) throw new Error('DXF: text height must be positive');
    const value = [...text.replace(NEWLINES, ' ')].slice(0, 255).join('');
    const style = this.styleName(opts.style, value);
    const h = H_ALIGN[opts.hAlign ?? 'left'];
    const v = V_ALIGN[opts.vAlign ?? 'baseline'];
    this.grow(p.x, p.y, opts.height);
    return this.add('TEXT', layer, opts, (o) => {
      o.g(100, 'AcDbText');
      o.pt(10, p.x, p.y);
      o.f(40, opts.height);
      o.s(1, escapePercent(value));
      if (opts.rotation) o.f(50, degrees(opts.rotation));
      if (opts.widthFactor && opts.widthFactor !== 1) o.f(41, opts.widthFactor);
      o.s(7, style);
      if (h) o.i(72, h);
      if (h || v) o.pt(11, p.x, p.y);
      o.g(100, 'AcDbText');
      if (v) o.i(73, v);
    });
  }

  /** MTEXT with UTF-8 text; '\n' becomes a paragraph break (\P). */
  mtext(layer: string, p: Pt, text: string, opts: DxfMTextOptions): this {
    assertFinite(p.x, p.y, opts.height, opts.rotation ?? 0, opts.width ?? 0);
    if (!(opts.height > 0)) throw new Error('DXF: text height must be positive');
    const style = this.styleName(opts.style, text);
    const content = escapeMText(text);
    const rot = opts.rotation ?? 0;
    this.grow(p.x, p.y, opts.height);
    return this.add('MTEXT', layer, opts, (o) => {
      o.g(100, 'AcDbMText');
      o.pt(10, p.x, p.y);
      o.f(40, opts.height);
      o.f(41, opts.width ?? 0);
      o.i(71, ATTACH[opts.attachment ?? 'top-left']);
      o.i(72, 1);
      const chunks = splitChunks(this.encode(content), 250);
      chunks.forEach((c, i) => o.g(i === chunks.length - 1 ? 1 : 3, c));
      o.s(7, style);
      o.pt(11, Math.cos(rot), Math.sin(rot));
      if (opts.lineSpacing && opts.lineSpacing !== 1) {
        o.i(73, 1);
        o.f(44, opts.lineSpacing);
      }
    });
  }

  /**
   * Text as filled glyph outlines (one solid HATCH per glyph, odd-parity islands), for CAD
   * applications without complex-script shaping. See {@link textToOutlines}.
   */
  textOutlines(
    layer: string,
    fonts: FontSet,
    p: Pt,
    text: string,
    opts: TextOutlineOptions & DxfHatchOptions,
  ): this {
    for (const glyph of textToOutlines(fonts, text, p, opts)) this.hatch(layer, glyph, opts);
    return this;
  }

  private styleName(style: string | undefined, text: string): string {
    if (style) {
      const s = this.styles.get(sanitizeName(style).toUpperCase());
      if (!s) throw new Error(`DXF: text style "${style}" is not defined`);
      return s.name;
    }
    return isAscii(text) ? 'Standard' : 'Unicode';
  }

  // ----- serialisation ---------------------------------------------------------------------

  private encode = (s: string): string => {
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 || cp === 0x7f) continue; // control characters are not allowed in values
      if (ch === '^') out += '^ ';
      else if (cp > 0x7e && this.opts.escapeUnicode) {
        if (cp > 0xffff) {
          const v = cp - 0x10000;
          out += `\\U+${(0xd800 + (v >> 10)).toString(16).toUpperCase()}\\U+${(0xdc00 + (v & 0x3ff)).toString(16).toUpperCase()}`;
        } else out += `\\U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      } else out += ch;
    }
    return out;
  };

  /** Serialises the complete DXF document. */
  toString(): string {
    const H = new Handles();
    const o = new Out(this.encode);
    const tableNames = [
      'VPORT',
      'LTYPE',
      'LAYER',
      'STYLE',
      'VIEW',
      'UCS',
      'APPID',
      'DIMSTYLE',
      'BLOCK_RECORD',
    ] as const;
    const tbl = Object.fromEntries(tableNames.map((t) => [t, H.next()])) as Record<
      (typeof tableNames)[number],
      string
    >;
    const brMS = H.next();
    const brPS = H.next();
    const blk = { msBegin: H.next(), msEnd: H.next(), psBegin: H.next(), psEnd: H.next() };
    const obj = {
      root: H.next(),
      color: H.next(),
      group: H.next(),
      layout: H.next(),
      mlDict: H.next(),
      plotSettings: H.next(),
      plotStyle: H.next(),
      placeholder: H.next(),
      mlStyle: H.next(),
      layoutModel: H.next(),
      layoutPaper: H.next(),
    };
    const ltypeHandles = {
      ByBlock: H.next(),
      ByLayer: H.next(),
      Continuous: H.next(),
      ...Object.fromEntries([...this.linetypes.values()].map((lt) => [lt.name, H.next()])),
    } as Record<string, string>;
    const layerHandles = [...this.layers.values()].map(() => H.next());
    const styleHandles = [...this.styles.values()].map(() => H.next());
    const vportHandle = H.next();
    const appidHandle = H.next();
    const dimstyleHandle = H.next();

    const sections: Out[] = [];
    const ext = Number.isFinite(this.ext.minX) ? this.ext : { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    // CLASSES
    const classes = new Out(this.encode);
    classes.g(0, 'SECTION');
    classes.g(2, 'CLASSES');
    for (const [dxfName, cppName] of [
      ['ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault'],
      ['ACDBPLACEHOLDER', 'AcDbPlaceHolder'],
      ['LAYOUT', 'AcDbLayout'],
    ]) {
      classes.g(0, 'CLASS');
      classes.g(1, dxfName);
      classes.g(2, cppName);
      classes.g(3, 'ObjectDBX Classes');
      classes.i(90, 0);
      classes.i(91, 0);
      classes.i(280, 0);
      classes.i(281, 0);
    }
    classes.g(0, 'ENDSEC');
    sections.push(classes);

    // TABLES
    const t = new Out(this.encode);
    t.g(0, 'SECTION');
    t.g(2, 'TABLES');
    const table = (
      name: (typeof tableNames)[number],
      count: number,
      records: () => void,
      extra?: () => void,
    ) => {
      t.g(0, 'TABLE');
      t.g(2, name);
      t.g(5, tbl[name]);
      t.g(330, '0');
      t.g(100, 'AcDbSymbolTable');
      t.i(70, count);
      extra?.();
      records();
      t.g(0, 'ENDTAB');
    };
    const record = (type: string, handle: string, owner: string, subclass: string, handleCode = 5) => {
      t.g(0, type);
      t.g(handleCode, handle);
      t.g(330, owner);
      t.g(100, 'AcDbSymbolTableRecord');
      t.g(100, subclass);
    };
    table('VPORT', 1, () => {
      record('VPORT', vportHandle, tbl.VPORT, 'AcDbViewportTableRecord');
      t.s(2, '*Active');
      t.i(70, 0);
      t.pt(10, 0, 0, null);
      t.pt(11, 1, 1, null);
      t.pt(12, (ext.minX + ext.maxX) / 2, (ext.minY + ext.maxY) / 2, null);
      t.pt(13, 0, 0, null);
      t.pt(14, 1, 1, null);
      t.pt(15, 1, 1, null);
      t.pt(16, 0, 0, 1);
      t.pt(17, 0, 0, 0);
      const aspect = 1.5;
      const height = Math.max(ext.maxY - ext.minY, (ext.maxX - ext.minX) / aspect) * 1.05 || 10;
      t.f(40, height);
      t.f(41, aspect);
      t.f(42, 50);
      t.f(43, 0);
      t.f(44, 0);
      t.f(50, 0);
      t.f(51, 0);
      t.i(71, 0);
      t.i(72, 1000);
      t.i(73, 1);
      t.i(74, 3);
      t.i(75, 0);
      t.i(76, 0);
      t.i(77, 0);
      t.i(78, 0);
      t.i(281, 0);
      t.i(65, 1);
      t.pt(110, 0, 0, 0);
      t.pt(111, 1, 0, 0);
      t.pt(112, 0, 1, 0);
      t.i(79, 0);
      t.f(146, 0);
    });
    table('LTYPE', 3 + this.linetypes.size, () => {
      const lt = (name: string, description: string, pattern: number[]) => {
        record('LTYPE', ltypeHandles[name], tbl.LTYPE, 'AcDbLinetypeTableRecord');
        t.s(2, name);
        t.i(70, 0);
        t.s(3, description);
        t.i(72, 65);
        t.i(73, pattern.length);
        t.f(
          40,
          pattern.reduce((s, v) => s + Math.abs(v), 0),
        );
        for (const v of pattern) {
          t.f(49, v);
          t.i(74, 0);
        }
      };
      lt('ByBlock', '', []);
      lt('ByLayer', '', []);
      lt('Continuous', 'Solid line', []);
      for (const l of this.linetypes.values()) lt(l.name, l.description, l.pattern);
    });
    table('LAYER', this.layers.size, () => {
      [...this.layers.values()].forEach((l, i) => {
        record('LAYER', layerHandles[i], tbl.LAYER, 'AcDbLayerTableRecord');
        t.s(2, l.name);
        t.i(70, l.flags);
        t.i(62, l.off ? -l.color.aci : l.color.aci);
        if (l.color.trueColor !== undefined) t.i(420, l.color.trueColor);
        t.s(6, l.linetype);
        if (!l.plot) t.i(290, 0);
        t.i(370, l.lineweight);
        t.g(390, obj.placeholder);
      });
    });
    table('STYLE', this.styles.size, () => {
      [...this.styles.values()].forEach((s, i) => {
        record('STYLE', styleHandles[i], tbl.STYLE, 'AcDbTextStyleTableRecord');
        t.s(2, s.name);
        t.i(70, 0);
        t.f(40, 0);
        t.f(41, s.widthFactor);
        t.f(50, 0);
        t.i(71, 0);
        t.f(42, 2.5);
        t.s(3, s.font);
        t.s(4, '');
      });
    });
    table('VIEW', 0, () => {});
    table('UCS', 0, () => {});
    table('APPID', 1, () => {
      record('APPID', appidHandle, tbl.APPID, 'AcDbRegAppTableRecord');
      t.s(2, 'ACAD');
      t.i(70, 0);
    });
    table(
      'DIMSTYLE',
      1,
      () => {
        record('DIMSTYLE', dimstyleHandle, tbl.DIMSTYLE, 'AcDbDimStyleTableRecord', 105);
        t.s(2, 'Standard');
        t.i(70, 0);
        t.f(40, 1);
        t.f(41, 2.5);
        t.f(42, 0.625);
        t.f(43, 3.75);
        t.f(44, 1.25);
        t.f(140, 2.5);
        t.f(141, 2.5);
        t.f(147, 0.625);
        t.i(77, 1);
        t.i(78, 8);
        t.i(271, 2);
        t.i(272, 2);
        t.g(340, styleHandles[0]);
      },
      () => t.g(100, 'AcDbDimStyleTable'),
    );
    table('BLOCK_RECORD', 2, () => {
      for (const [h, name, layout] of [
        [brMS, '*Model_Space', obj.layoutModel],
        [brPS, '*Paper_Space', obj.layoutPaper],
      ]) {
        record('BLOCK_RECORD', h, tbl.BLOCK_RECORD, 'AcDbBlockTableRecord');
        t.s(2, name);
        t.g(340, layout);
        t.i(70, INSUNITS[this.opts.units]);
        t.i(280, 1);
        t.i(281, 0);
      }
    });
    t.g(0, 'ENDSEC');
    sections.push(t);

    // BLOCKS
    const b = new Out(this.encode);
    b.g(0, 'SECTION');
    b.g(2, 'BLOCKS');
    for (const [begin, end, owner, name, paper] of [
      [blk.msBegin, blk.msEnd, brMS, '*Model_Space', false],
      [blk.psBegin, blk.psEnd, brPS, '*Paper_Space', true],
    ] as const) {
      b.g(0, 'BLOCK');
      b.g(5, begin);
      b.g(330, owner);
      b.g(100, 'AcDbEntity');
      if (paper) b.i(67, 1);
      b.s(8, '0');
      b.g(100, 'AcDbBlockBegin');
      b.s(2, name);
      b.i(70, 0);
      b.pt(10, 0, 0, 0);
      b.s(3, name);
      b.s(1, '');
      b.g(0, 'ENDBLK');
      b.g(5, end);
      b.g(330, owner);
      b.g(100, 'AcDbEntity');
      if (paper) b.i(67, 1);
      b.s(8, '0');
      b.g(100, 'AcDbBlockEnd');
    }
    b.g(0, 'ENDSEC');
    sections.push(b);

    // ENTITIES
    const e = new Out(this.encode);
    e.g(0, 'SECTION');
    e.g(2, 'ENTITIES');
    for (const ent of this.entities) {
      e.g(0, ent.type);
      e.g(5, H.next());
      e.g(330, brMS);
      e.g(100, 'AcDbEntity');
      e.s(8, ent.layer);
      const st = ent.style;
      if (st.linetype && st.linetype !== 'ByLayer') e.s(6, st.linetype);
      const col = resolveColor(st.color, 256);
      if (col.aci !== 256) e.i(62, col.aci);
      if (st.lineweight !== undefined) e.i(370, snapLineweight(st.lineweight));
      if (st.ltscale !== undefined && st.ltscale !== 1) e.f(48, st.ltscale);
      if (col.trueColor !== undefined) e.i(420, col.trueColor);
      if (st.transparency !== undefined && st.transparency > 0) {
        const tr = Math.min(0.9, Math.max(0, st.transparency));
        e.i(440, 0x02000000 | Math.round(255 * (1 - tr)));
      }
      ent.body(e);
    }
    e.g(0, 'ENDSEC');
    sections.push(e);

    // OBJECTS
    const ob = new Out(this.encode);
    ob.g(0, 'SECTION');
    ob.g(2, 'OBJECTS');
    const reactors = (owner: string) => {
      ob.g(102, '{ACAD_REACTORS');
      ob.g(330, owner);
      ob.g(102, '}');
    };
    const dict = (handle: string, owner: string, entries: [string, string][], type = 'DICTIONARY') => {
      ob.g(0, type);
      ob.g(5, handle);
      if (owner !== '0') reactors(owner);
      ob.g(330, owner);
      ob.g(100, 'AcDbDictionary');
      ob.i(281, 1);
      for (const [k, v] of entries) {
        ob.s(3, k);
        ob.g(350, v);
      }
    };
    dict(obj.root, '0', [
      ['ACAD_COLOR', obj.color],
      ['ACAD_GROUP', obj.group],
      ['ACAD_LAYOUT', obj.layout],
      ['ACAD_MLINESTYLE', obj.mlDict],
      ['ACAD_PLOTSETTINGS', obj.plotSettings],
      ['ACAD_PLOTSTYLENAME', obj.plotStyle],
    ]);
    dict(obj.color, obj.root, []);
    dict(obj.group, obj.root, []);
    dict(obj.layout, obj.root, [
      ['Layout1', obj.layoutPaper],
      ['Model', obj.layoutModel],
    ]);
    dict(obj.mlDict, obj.root, [['Standard', obj.mlStyle]]);
    dict(obj.plotSettings, obj.root, []);
    dict(obj.plotStyle, obj.root, [['Normal', obj.placeholder]], 'ACDBDICTIONARYWDFLT');
    ob.g(100, 'AcDbDictionaryWithDefault');
    ob.g(340, obj.placeholder);
    ob.g(0, 'ACDBPLACEHOLDER');
    ob.g(5, obj.placeholder);
    reactors(obj.plotStyle);
    ob.g(330, obj.plotStyle);
    ob.g(0, 'MLINESTYLE');
    ob.g(5, obj.mlStyle);
    reactors(obj.mlDict);
    ob.g(330, obj.mlDict);
    ob.g(100, 'AcDbMlineStyle');
    ob.s(2, 'Standard');
    ob.i(70, 0);
    ob.s(3, '');
    ob.i(62, 256);
    ob.f(51, 90);
    ob.f(52, 90);
    ob.i(71, 2);
    ob.f(49, 0.5);
    ob.i(62, 256);
    ob.s(6, 'BYLAYER');
    ob.f(49, -0.5);
    ob.i(62, 256);
    ob.s(6, 'BYLAYER');
    const layout = (handle: string, name: string, model: boolean, owner: string, tab: number) => {
      ob.g(0, 'LAYOUT');
      ob.g(5, handle);
      reactors(obj.layout);
      ob.g(330, obj.layout);
      ob.g(100, 'AcDbPlotSettings');
      ob.s(1, '');
      ob.s(2, 'none_device');
      ob.s(4, 'ISO_A3_(420.00_x_297.00_MM)');
      ob.s(6, '');
      ob.f(40, 7.5);
      ob.f(41, 20);
      ob.f(42, 7.5);
      ob.f(43, 20);
      ob.f(44, 420);
      ob.f(45, 297);
      ob.f(46, 0);
      ob.f(47, 0);
      ob.f(48, 0);
      ob.f(49, 0);
      ob.f(140, 0);
      ob.f(141, 0);
      ob.f(142, 1);
      ob.f(143, 1);
      ob.i(70, model ? 1024 : 0);
      ob.i(72, 1);
      ob.i(73, 0);
      ob.i(74, 5);
      ob.s(7, '');
      ob.i(75, 16);
      ob.i(76, 0);
      ob.i(77, 2);
      ob.i(78, 300);
      ob.f(147, 1);
      ob.f(148, 0);
      ob.f(149, 0);
      ob.g(100, 'AcDbLayout');
      ob.s(1, name);
      ob.i(70, 1);
      ob.i(71, tab);
      ob.pt(10, 0, 0, null);
      ob.pt(11, 420, 297, null);
      ob.pt(12, 0, 0, 0);
      ob.pt(14, ext.minX, ext.minY, 0);
      ob.pt(15, ext.maxX, ext.maxY, 0);
      ob.f(146, 0);
      ob.pt(13, 0, 0, 0);
      ob.pt(16, 1, 0, 0);
      ob.pt(17, 0, 1, 0);
      ob.i(76, 0);
      ob.g(330, owner);
    };
    layout(obj.layoutModel, 'Model', true, brMS, 0);
    layout(obj.layoutPaper, 'Layout1', false, brPS, 1);
    ob.g(0, 'ENDSEC');
    sections.push(ob);

    // HEADER (written last so $HANDSEED covers every handle)
    o.g(0, 'SECTION');
    o.g(2, 'HEADER');
    const v = (name: string) => o.g(9, name);
    v('$ACADVER');
    o.g(1, 'AC1024');
    v('$ACADMAINTVER');
    o.i(70, 6);
    v('$DWGCODEPAGE');
    o.g(3, 'ANSI_1252');
    v('$INSBASE');
    o.pt(10, 0, 0, 0);
    v('$EXTMIN');
    o.pt(10, ext.minX, ext.minY, 0);
    v('$EXTMAX');
    o.pt(10, ext.maxX, ext.maxY, 0);
    v('$LIMMIN');
    o.pt(10, ext.minX, ext.minY, null);
    v('$LIMMAX');
    o.pt(10, ext.maxX, ext.maxY, null);
    v('$LTSCALE');
    o.f(40, this.opts.ltscale);
    v('$TEXTSTYLE');
    o.g(7, 'Standard');
    v('$CLAYER');
    o.g(8, '0');
    v('$CELTYPE');
    o.g(6, 'ByLayer');
    v('$CECOLOR');
    o.i(62, 256);
    v('$DIMSTYLE');
    o.g(2, 'Standard');
    v('$LUNITS');
    o.i(70, 2);
    v('$LUPREC');
    o.i(70, 4);
    v('$AUNITS');
    o.i(70, 0);
    v('$PDMODE');
    o.i(70, this.opts.pointMode ?? 0);
    v('$PDSIZE');
    o.f(40, this.opts.pointSize ?? 0);
    v('$HANDSEED');
    o.g(5, H.seed);
    v('$PSLTSCALE');
    o.i(70, 1);
    v('$INSUNITS');
    o.i(70, INSUNITS[this.opts.units]);
    v('$MEASUREMENT');
    o.i(70, this.opts.units === 'in' || this.opts.units === 'ft' ? 0 : 1);
    o.g(0, 'ENDSEC');

    const all = [...o.lines, ...sections.flatMap((s) => s.lines), '  0', 'EOF'];
    return all.join(this.opts.lineEnding) + this.opts.lineEnding;
  }

  /** UTF-8 bytes of {@link toString} (no BOM). */
  toBytes(): Uint8Array {
    return new TextEncoder().encode(this.toString());
  }
}

/** Grows extents by the circles of bulged segments (conservative). */
function growBulges(
  verts: readonly { x: number; y: number; bulge: number }[],
  closed: boolean,
  grow: (x: number, y: number, r: number) => void,
): void {
  const n = verts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = verts[i];
    if (!a.bulge) continue;
    const b = verts[(i + 1) % n];
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const theta = 4 * Math.atan(a.bulge);
    const r = chord / (2 * Math.abs(Math.sin(theta / 2)) || 1);
    grow((a.x + b.x) / 2, (a.y + b.y) / 2, Math.min(r, chord / 2 + Math.abs(a.bulge) * chord));
  }
}

function pointInRing(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** TEXT control codes start with %%; a literal "%%" must be written as "%%%" + "%%%" … */
function escapePercent(s: string): string {
  return s.replace(/%%/g, '%%%%%%');
}

/** MTEXT inline-code escaping: backslash, braces; newlines → \P. */
export function escapeMText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(NEWLINES, '\\P');
}

const CHUNK_TOKEN = /\\U\+[0-9A-Fa-f]{4}|\\[\s\S]|\^[\s\S]|[\s\S]/gu;

/**
 * Splits an already DXF-encoded string into chunks of at most `max` code points without breaking
 * escapes (\\x, \\U+XXXX), caret pairs (^ ) or surrogate pairs.
 */
export function splitChunks(s: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  let len = 0;
  for (const m of s.matchAll(CHUNK_TOKEN)) {
    const tok = m[0];
    const n = [...tok].length;
    if (len + n > max && cur) {
      out.push(cur);
      cur = '';
      len = 0;
    }
    cur += tok;
    len += n;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text → outline polygons
// ---------------------------------------------------------------------------------------------

export interface TextOutlineOptions {
  /** Em size in drawing units. */
  height: number;
  /** Radians, counter-clockwise. */
  rotation?: number;
  anchor?: TextAnchor;
  baseline?: TextBaseline;
  font?: FontFamily;
  bold?: boolean;
  /** Chord tolerance in drawing units (default height / 400). */
  tolerance?: number;
}

/**
 * Shapes text with the bundled fonts (Arabic joining, bidi) and returns one list of closed rings
 * per glyph, in drawing coordinates (y-up) with the anchor at `position`. Rings follow the font's
 * contour structure, so even-odd filling reproduces counters (holes) per glyph.
 */
export function textToOutlines(
  fonts: FontSet,
  text: string,
  position: Pt,
  opts: TextOutlineOptions,
): Vertex[][][] {
  if (!(opts.height > 0)) return [];
  const layout = layoutText(fonts, text, {
    size: opts.height,
    font: opts.font,
    bold: opts.bold,
    anchor: opts.anchor,
    baseline: opts.baseline,
  });
  const tol = opts.tolerance ?? opts.height / 400;
  const c = Math.cos(opts.rotation ?? 0);
  const s = Math.sin(opts.rotation ?? 0);
  const out: Vertex[][][] = [];
  for (const g of layout.glyphs) {
    if (g.blank) continue;
    const rings = flattenPath(g.cmds, tol)
      .filter((sp) => sp.points.length >= 3)
      .map((sp) =>
        sp.points.map((p) => ({ x: position.x + p.x * c + p.y * s, y: position.y + p.x * s - p.y * c })),
      );
    if (rings.length) out.push(rings);
  }
  return out;
}
