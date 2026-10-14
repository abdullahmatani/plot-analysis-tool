import type { Affine2D, Bounds, Pt, Vertex } from '@/core/types';
import { bulgeToArc } from '@/geometry/bulge';
import { TAU, ccwSweep } from '@/geometry/vec';

/**
 * Backend-neutral vector display list used by every export backend (PDF, SVG, canvas/PNG) and by
 * the WYSIWYG export preview (rows 76–81).
 *
 * Coordinates are **paper millimetres, origin at the top-left of the sheet, y pointing down**.
 * Angles called "CCW on paper" are counter-clockwise as seen on the printed sheet.
 */

export type PathCmd =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Z' };

export interface StrokeStyle {
  /** `#rrggbb` */
  color: string;
  /** Line width in mm. */
  width: number;
  opacity?: number;
  /** Dash pattern in mm (on, off, on, off …). */
  dash?: number[];
  /** Default 'butt'. */
  cap?: 'butt' | 'round' | 'square';
  /** Default 'miter' (miter limit 10 in every backend). */
  join?: 'miter' | 'round' | 'bevel';
}

export type HatchPatternName =
  'diagonal' | 'back-diagonal' | 'cross' | 'diagonal-cross' | 'horizontal' | 'vertical' | 'dots';

export interface HatchStyle {
  pattern: HatchPatternName;
  /** Perpendicular distance between hatch lines (or dot pitch) in mm. */
  spacing: number;
  /** Hatch line width in mm (dots: dot diameter is 2 × lineWidth). */
  lineWidth: number;
  /** Hatch colour; defaults to the fill colour. */
  color?: string;
  /** Hatch opacity, default 1. */
  opacity?: number;
}

/**
 * Area fill. The solid tint (`color` × `opacity`) is always painted first; when `hatch` is set the
 * hatch lines are drawn on top of it, clipped to the shape. Use `opacity: 0` for hatch-only fills.
 */
export interface FillStyle {
  color: string;
  opacity?: number;
  /** Default 'nonzero'. */
  rule?: 'nonzero' | 'evenodd';
  hatch?: HatchStyle;
}

export type FontFamily = 'sans' | 'serif' | 'mono';
/** Physical horizontal anchor: 'start' = left end of each line, 'end' = right end (also for RTL text). */
export type TextAnchor = 'start' | 'middle' | 'end';
/**
 * Vertical reference: 'alphabetic' = first line's baseline; 'top' / 'bottom' = ascender of the first
 * line / descender of the last line; 'middle' = centre of that box; 'hanging' = cap height of the
 * first line.
 */
export type TextBaseline = 'alphabetic' | 'middle' | 'top' | 'bottom' | 'hanging';

export interface PathItem {
  kind: 'path';
  d: PathCmd[];
  stroke?: StrokeStyle;
  fill?: FillStyle;
}

export interface TextItem {
  kind: 'text';
  /** May contain '\n' for multi-line text (line height 1.2 × size). */
  text: string;
  x: number;
  y: number;
  /** Font size (em) in mm. */
  size: number;
  font: FontFamily;
  bold?: boolean;
  color: string;
  opacity?: number;
  anchor: TextAnchor;
  baseline: TextBaseline;
  /** Radians, CCW on paper, about (x, y). */
  rotation?: number;
  /** Outline stroke painted under the text; `width` is the full stroke width in mm. */
  halo?: { color: string; width: number };
}

export interface ImageItem {
  kind: 'image';
  /** Top-left corner on paper (before rotation). */
  x: number;
  y: number;
  w: number;
  h: number;
  png: Uint8Array;
  /** Radians, CCW on paper, about (x, y). */
  rotation?: number;
  opacity?: number;
}

export interface PdfPageItem {
  kind: 'pdfPage';
  /** Source PDF file bytes. */
  bytes: Uint8Array;
  /** 0-based page index. */
  pageIndex: number;
  /** PDF user space (pt, y-up, unrotated page) → paper mm (y-down), Canvas/SVG matrix convention. */
  transform: Affine2D;
  opacity?: number;
  /** Raster stand-in for backends that cannot embed PDF (SVG, canvas) or if embedding fails. */
  fallbackPng?: { png: Uint8Array; x: number; y: number; w: number; h: number };
  /**
   * Names of the source PDF's own optional-content groups (layers) to export switched off, e.g. the
   * drawing's `hiddenSourceLayers`. Other source layers keep the source document's default state.
   */
  hiddenLayers?: string[];
}

export interface GroupItem {
  kind: 'group';
  name: string;
  /** Becomes a PDF optional-content group (layer) and an Inkscape layer in SVG. */
  layer?: boolean;
  /** Clip path in paper mm (nonzero rule). */
  clip?: PathCmd[];
  opacity?: number;
  children: SceneItem[];
}

export type SceneItem = PathItem | TextItem | ImageItem | PdfPageItem | GroupItem;

export interface SceneMeta {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
}

export interface Scene {
  widthMm: number;
  heightMm: number;
  /** Sheet background colour; transparent when omitted. */
  background?: string;
  items: SceneItem[];
  meta?: SceneMeta;
}

export const MM_PER_PT = 25.4 / 72;
export const PT_PER_MM = 72 / 25.4;
/** Miter limit used by every backend (PDF default; SVG's default of 4 is overridden). */
export const MITER_LIMIT = 10;

/** Default maximum sweep per cubic segment: keeps the radial error below 4e-7 · r. */
export const DEFAULT_ARC_SEGMENT = Math.PI / 6;

// ---------------------------------------------------------------------------------------------
// Arc → cubic Bézier conversion
// ---------------------------------------------------------------------------------------------

/**
 * Cubic Bézier segments ('C' commands only, no initial move) approximating a circular arc that
 * starts at angle `a0` and sweeps `sweep` radians (positive = increasing angle). The point at
 * angle a is (cx + r·cos a, cy + r·sin a) in whatever axis convention the caller uses.
 *
 * Each segment spans at most `maxSegment` (default 30°, i.e. ≤ 90° as required), which bounds the
 * radial error of the classic 4/3·tan(θ/4) construction to ≈ 3.7e-7 · r.
 */
export function arcSweepToCubics(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  sweep: number,
  maxSegment = DEFAULT_ARC_SEGMENT,
): PathCmd[] {
  const out: PathCmd[] = [];
  if (!(r > 0) || sweep === 0 || !Number.isFinite(sweep)) return out;
  const seg = Math.min(Math.max(maxSegment, 1e-3), Math.PI / 2);
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / seg - 1e-9));
  const delta = sweep / n;
  const k = (4 / 3) * Math.tan(delta / 4);
  let c0 = Math.cos(a0);
  let s0 = Math.sin(a0);
  for (let i = 1; i <= n; i++) {
    const a = i === n ? a0 + sweep : a0 + delta * i;
    const c1 = Math.cos(a);
    const s1 = Math.sin(a);
    out.push({
      op: 'C',
      x1: cx + r * (c0 - k * s0),
      y1: cy + r * (s0 + k * c0),
      x2: cx + r * (c1 + k * s1),
      y2: cy + r * (s1 - k * c1),
      x: cx + r * c1,
      y: cy + r * s1,
    });
    c0 = c1;
    s0 = s1;
  }
  return out;
}

/**
 * Cubic segments ('C' commands only) for the arc from angle `a0` to `a1`, travelling in the
 * direction of increasing angle when `ccw` (in the caller's axis convention) and decreasing
 * otherwise. Equal angles give a full circle. Max radial error < 1e-6 · r.
 */
export function arcToCubics(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  ccw: boolean,
  maxSegment = DEFAULT_ARC_SEGMENT,
): PathCmd[] {
  const sweep = ccw ? ccwSweep(a0, a1) : -ccwSweep(a1, a0);
  return arcSweepToCubics(cx, cy, r, a0, sweep, maxSegment);
}

/** Arc as a standalone open path (M + C…). */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number, ccw: boolean): PathCmd[] {
  return [
    { op: 'M', x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) },
    ...arcToCubics(cx, cy, r, a0, a1, ccw),
  ];
}

/**
 * Cubic segments ('C' only) for an elliptical arc between parametric angles t0 → t1. The ellipse
 * point at parameter t is c + R(rotation)·(rx·cos t, ry·sin t). Exact affine image of
 * {@link arcToCubics}, so the relative error bound carries over.
 */
export function ellipseToCubics(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  t0: number,
  t1: number,
  ccw: boolean,
  maxSegment = DEFAULT_ARC_SEGMENT,
): PathCmd[] {
  const unit = arcToCubics(0, 0, 1, t0, t1, ccw, maxSegment);
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return transformPath(unit, [rx * c, rx * s, -ry * s, ry * c, cx, cy]);
}

/** Closed full ellipse path. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number, rotation = 0): PathCmd[] {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return [
    { op: 'M', x: cx + rx * c, y: cy + rx * s },
    ...ellipseToCubics(cx, cy, rx, ry, rotation, 0, TAU, true),
    { op: 'Z' },
  ];
}

/** Closed circle path starting at angle 0. */
export function circlePath(cx: number, cy: number, r: number): PathCmd[] {
  return [{ op: 'M', x: cx + r, y: cy }, ...arcSweepToCubics(cx, cy, r, 0, TAU), { op: 'Z' }];
}

/** Axis-aligned rectangle (optionally with rounded corners of radius `radius`). */
export function rectPath(x: number, y: number, w: number, h: number, radius = 0): PathCmd[] {
  const r = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
  if (r === 0) {
    return [
      { op: 'M', x, y },
      { op: 'L', x: x + w, y },
      { op: 'L', x: x + w, y: y + h },
      { op: 'L', x, y: y + h },
      { op: 'Z' },
    ];
  }
  const x0 = Math.min(x, x + w);
  const y0 = Math.min(y, y + h);
  const x1 = Math.max(x, x + w);
  const y1 = Math.max(y, y + h);
  const q = Math.PI / 2;
  return [
    { op: 'M', x: x0 + r, y: y0 },
    { op: 'L', x: x1 - r, y: y0 },
    ...arcSweepToCubics(x1 - r, y0 + r, r, -q, q),
    { op: 'L', x: x1, y: y1 - r },
    ...arcSweepToCubics(x1 - r, y1 - r, r, 0, q),
    { op: 'L', x: x0 + r, y: y1 },
    ...arcSweepToCubics(x0 + r, y1 - r, r, q, q),
    { op: 'L', x: x0, y: y0 + r },
    ...arcSweepToCubics(x0 + r, y0 + r, r, Math.PI, q),
    { op: 'Z' },
  ];
}

/** Straight-segment path through the given points. */
export function polylinePath(
  points: readonly (Pt | readonly [number, number])[],
  closed: boolean,
): PathCmd[] {
  const out: PathCmd[] = [];
  points.forEach((p, i) => {
    const [x, y] = Array.isArray(p) ? (p as readonly [number, number]) : [(p as Pt).x, (p as Pt).y];
    out.push({ op: i === 0 ? 'M' : 'L', x, y });
  });
  if (closed && out.length > 0) out.push({ op: 'Z' });
  return out;
}

/**
 * Converts a DXF-style polyline with bulges (e.g. world coordinates) to a paper path. Arc
 * segments become exact cubic Béziers (error < 1e-6 · r) built in the source space and mapped
 * through `toPaper`, which must be affine for the arcs to stay exact (calibration, view and print
 * scale are). Vertices map exactly.
 */
export function bulgePolylineToPath(
  pts: readonly Vertex[],
  closed: boolean,
  toPaper: (p: Pt) => [number, number],
): PathCmd[] {
  const n = pts.length;
  if (n === 0) return [];
  const mapped = pts.map((p) => toPaper(p));
  const out: PathCmd[] = [{ op: 'M', x: mapped[0][0], y: mapped[0][1] }];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const a = pts[i];
    const b = pts[j];
    const arc = a.bulge ? bulgeToArc(a, b, a.bulge) : null;
    if (!arc) {
      if (i === segs - 1 && closed && j === 0) break; // closing straight edge is implied by Z
      out.push({ op: 'L', x: mapped[j][0], y: mapped[j][1] });
      continue;
    }
    const cubics = arcSweepToCubics(arc.c.x, arc.c.y, arc.r, arc.a0, arc.sweep);
    cubics.forEach((c, k) => {
      if (c.op !== 'C') return;
      const [x1, y1] = toPaper({ x: c.x1, y: c.y1 });
      const [x2, y2] = toPaper({ x: c.x2, y: c.y2 });
      const [x, y] = k === cubics.length - 1 ? mapped[j] : toPaper({ x: c.x, y: c.y });
      out.push({ op: 'C', x1, y1, x2, y2, x, y });
    });
  }
  if (closed) out.push({ op: 'Z' });
  return out;
}

/** Applies an affine transform to every point of a path. */
export function transformPath(d: readonly PathCmd[], m: Affine2D): PathCmd[] {
  const [a, b, c, dd, e, f] = m;
  return d.map((cmd): PathCmd => {
    switch (cmd.op) {
      case 'M':
      case 'L':
        return { op: cmd.op, x: a * cmd.x + c * cmd.y + e, y: b * cmd.x + dd * cmd.y + f };
      case 'C':
        return {
          op: 'C',
          x1: a * cmd.x1 + c * cmd.y1 + e,
          y1: b * cmd.x1 + dd * cmd.y1 + f,
          x2: a * cmd.x2 + c * cmd.y2 + e,
          y2: b * cmd.x2 + dd * cmd.y2 + f,
          x: a * cmd.x + c * cmd.y + e,
          y: b * cmd.x + dd * cmd.y + f,
        };
      case 'Z':
        return cmd;
    }
  });
}

/** Bounding box of all path points including Bézier control points (conservative). */
export function pathBounds(d: readonly PathCmd[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const cmd of d) {
    if (cmd.op === 'Z') continue;
    if (cmd.op === 'C') {
      add(cmd.x1, cmd.y1);
      add(cmd.x2, cmd.y2);
    }
    add(cmd.x, cmd.y);
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

export interface FlatSubpath {
  points: Pt[];
  closed: boolean;
}

/**
 * Flattens a path into polylines with every curve within `tolerance` of the true curve
 * (subdivision count from the cubic's second differences).
 */
export function flattenPath(d: readonly PathCmd[], tolerance: number): FlatSubpath[] {
  const out: FlatSubpath[] = [];
  let cur: FlatSubpath | null = null;
  let cx = 0;
  let cy = 0;
  const tol = Math.max(tolerance, 1e-12);
  for (const cmd of d) {
    if (cmd.op === 'M') {
      cur = { points: [{ x: cmd.x, y: cmd.y }], closed: false };
      out.push(cur);
      cx = cmd.x;
      cy = cmd.y;
    } else if (cmd.op === 'L') {
      if (!cur) {
        cur = { points: [{ x: cx, y: cy }], closed: false };
        out.push(cur);
      }
      cur.points.push({ x: cmd.x, y: cmd.y });
      cx = cmd.x;
      cy = cmd.y;
    } else if (cmd.op === 'C') {
      if (!cur) {
        cur = { points: [{ x: cx, y: cy }], closed: false };
        out.push(cur);
      }
      const ddx = Math.max(Math.abs(cx - 2 * cmd.x1 + cmd.x2), Math.abs(cmd.x1 - 2 * cmd.x2 + cmd.x));
      const ddy = Math.max(Math.abs(cy - 2 * cmd.y1 + cmd.y2), Math.abs(cmd.y1 - 2 * cmd.y2 + cmd.y));
      const dd = Math.hypot(ddx, ddy);
      const n = Math.min(1000, Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / tol))));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        const b0 = u * u * u;
        const b1 = 3 * u * u * t;
        const b2 = 3 * u * t * t;
        const b3 = t * t * t;
        cur.points.push({
          x: b0 * cx + b1 * cmd.x1 + b2 * cmd.x2 + b3 * cmd.x,
          y: b0 * cy + b1 * cmd.y1 + b2 * cmd.y2 + b3 * cmd.y,
        });
      }
      cx = cmd.x;
      cy = cmd.y;
    } else if (cur) {
      cur.closed = true;
      const first = cur.points[0];
      const last = cur.points[cur.points.length - 1];
      if (cur.points.length > 1 && first.x === last.x && first.y === last.y) cur.points.pop();
      cx = first.x;
      cy = first.y;
      cur = null;
    }
  }
  return out;
}

/** Rotation by `theta` CCW as seen on paper (y-down axes), as an affine matrix. */
export function paperRotation(theta: number): Affine2D {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c, -s, s, c, 0, 0];
}

// ---------------------------------------------------------------------------------------------
// SceneBuilder
// ---------------------------------------------------------------------------------------------

export type TextOptions = Partial<Omit<TextItem, 'kind' | 'text' | 'x' | 'y'>>;

/** Fluent helper for assembling a {@link Scene}; groups nest via begin/end or a callback. */
export class SceneBuilder {
  private readonly root: SceneItem[] = [];
  private readonly stack: GroupItem[] = [];

  constructor(
    readonly widthMm: number,
    readonly heightMm: number,
    private readonly options: { background?: string; meta?: SceneMeta } = {},
  ) {}

  /** Items list currently being appended to (innermost open group or the root). */
  get current(): SceneItem[] {
    return this.stack.length ? this.stack[this.stack.length - 1].children : this.root;
  }

  add(...items: SceneItem[]): this {
    this.current.push(...items);
    return this;
  }

  path(d: PathCmd[], stroke?: StrokeStyle, fill?: FillStyle): this {
    if (d.length === 0) return this;
    const item: PathItem = { kind: 'path', d };
    if (stroke) item.stroke = stroke;
    if (fill) item.fill = fill;
    return this.add(item);
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: StrokeStyle): this {
    return this.path(
      [
        { op: 'M', x: x1, y: y1 },
        { op: 'L', x: x2, y: y2 },
      ],
      stroke,
    );
  }

  polyline(
    points: readonly (Pt | readonly [number, number])[],
    closed: boolean,
    stroke?: StrokeStyle,
    fill?: FillStyle,
  ): this {
    return this.path(polylinePath(points, closed), stroke, fill);
  }

  rect(x: number, y: number, w: number, h: number, stroke?: StrokeStyle, fill?: FillStyle, radius = 0): this {
    return this.path(rectPath(x, y, w, h, radius), stroke, fill);
  }

  circle(cx: number, cy: number, r: number, stroke?: StrokeStyle, fill?: FillStyle): this {
    return this.path(circlePath(cx, cy, r), stroke, fill);
  }

  /** World polyline with bulges, mapped to paper through an affine `toPaper`. */
  bulgePolyline(
    pts: readonly Vertex[],
    closed: boolean,
    toPaper: (p: Pt) => [number, number],
    stroke?: StrokeStyle,
    fill?: FillStyle,
  ): this {
    return this.path(bulgePolylineToPath(pts, closed, toPaper), stroke, fill);
  }

  text(text: string, x: number, y: number, opts: TextOptions = {}): this {
    const item: TextItem = {
      kind: 'text',
      text,
      x,
      y,
      size: opts.size ?? 2.5,
      font: opts.font ?? 'sans',
      color: opts.color ?? '#000000',
      anchor: opts.anchor ?? 'start',
      baseline: opts.baseline ?? 'alphabetic',
    };
    if (opts.bold) item.bold = true;
    if (opts.opacity !== undefined) item.opacity = opts.opacity;
    if (opts.rotation) item.rotation = opts.rotation;
    if (opts.halo) item.halo = opts.halo;
    return this.add(item);
  }

  image(
    x: number,
    y: number,
    w: number,
    h: number,
    png: Uint8Array,
    opts: { rotation?: number; opacity?: number } = {},
  ): this {
    return this.add({ kind: 'image', x, y, w, h, png, ...opts });
  }

  pdfPage(
    bytes: Uint8Array,
    pageIndex: number,
    transform: Affine2D,
    opts: { opacity?: number; fallbackPng?: PdfPageItem['fallbackPng'] } = {},
  ): this {
    return this.add({ kind: 'pdfPage', bytes, pageIndex, transform, ...opts });
  }

  beginGroup(name: string, opts: { layer?: boolean; clip?: PathCmd[]; opacity?: number } = {}): this {
    const g: GroupItem = { kind: 'group', name, children: [] };
    if (opts.layer) g.layer = true;
    if (opts.clip) g.clip = opts.clip;
    if (opts.opacity !== undefined) g.opacity = opts.opacity;
    this.current.push(g);
    this.stack.push(g);
    return this;
  }

  endGroup(): this {
    if (!this.stack.length) throw new Error('SceneBuilder.endGroup() without matching beginGroup()');
    this.stack.pop();
    return this;
  }

  group(
    name: string,
    opts: { layer?: boolean; clip?: PathCmd[]; opacity?: number },
    fn: (b: this) => void,
  ): this {
    this.beginGroup(name, opts);
    try {
      fn(this);
    } finally {
      this.endGroup();
    }
    return this;
  }

  /** Shorthand for an optional-content layer group. */
  layer(name: string, fn: (b: this) => void): this {
    return this.group(name, { layer: true }, fn);
  }

  build(): Scene {
    if (this.stack.length) throw new Error(`SceneBuilder.build(): ${this.stack.length} group(s) left open`);
    const scene: Scene = { widthMm: this.widthMm, heightMm: this.heightMm, items: this.root };
    if (this.options.background) scene.background = this.options.background;
    if (this.options.meta) scene.meta = this.options.meta;
    return scene;
  }
}

/** Depth-first visit of all items (groups before their children). */
export function walkScene(
  items: readonly SceneItem[],
  fn: (item: SceneItem, parents: readonly GroupItem[]) => void,
): void {
  const parents: GroupItem[] = [];
  const visit = (list: readonly SceneItem[]) => {
    for (const it of list) {
      fn(it, parents);
      if (it.kind === 'group') {
        parents.push(it);
        visit(it.children);
        parents.pop();
      }
    }
  };
  visit(items);
}
