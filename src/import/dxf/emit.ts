import { TAU, normAngle } from '@/geometry/vec';
import { arcSegments } from '@/geometry/bulge';
import { aciToRgb } from '@/underlay/aci';
import {
  ET,
  FLAG,
  GK,
  type EntityMeta,
  type EntityStoreBuilder,
  type EntityTypeCode,
  type GeomKind,
  type ImportReport,
  type LinetypeDef,
  type SourceLayer,
} from '@/underlay/entity-store';
import { BBox } from './bounds';
import { where, type DxfBlock, type DxfDocument } from './document';
import { decodeText } from './encoding';
import { DxfAbortError, InvalidEntityError } from './errors';
import { flattenRings, generatePattern, parseHatch, type HatchData, type Ring } from './hatch';
import { mtextToPlain } from './mtext';
import { tessellateSpline, type SplineData } from './spline';
import { recNum, recStr, type Rec, type Tags } from './tokenizer';
import { Xform, compose, ocsXform } from './xform';

const DEG = Math.PI / 180;
/** Maximum nesting depth of block references. */
export const MAX_BLOCK_DEPTH = 32;
/** Maximum cells of a single MINSERT array. */
const MAX_ARRAY_CELLS = 10000;
/** Hard cap on flattened entities (protects the worker against exploding nested arrays). */
export const MAX_ENTITIES = 5_000_000;
/** Hard cap on visited block-content records (guards nested arrays of empty blocks). */
export const MAX_VISITS = 10_000_000;
/** Coordinates beyond this magnitude are treated as corrupt. */
const COORD_LIMIT = 1e15;
const SLOTS = 1072;

interface Ctx {
  xf: Xform | null;
  byBlockColor: number;
  byBlockLt: number;
  byBlockLw: number;
  /** Layer index that entities on layer "0" resolve to (-1 = layer "0" itself). */
  layer0: number;
  flags: number;
  insertIndex: number;
  depth: number;
  stack: string[];
}

class LimitError extends Error {}

export interface EmitOptions {
  tick: (fraction: number) => void;
  signal?: { aborted: boolean };
  /** Overrides MAX_ENTITIES (tests). */
  maxEntities?: number;
  /** Overrides MAX_VISITS (tests). */
  maxVisits?: number;
}

const SKIP_REASON: Record<string, string> = {
  RAY: 'infinite construction lines are not imported',
  XLINE: 'infinite construction lines are not imported',
  VIEWPORT: 'paper-space viewports are not rendered',
  IMAGE: 'raster images are not imported',
  WIPEOUT: 'wipeouts are not supported',
  MLINE: 'multilines are not supported',
  MULTILEADER: 'multileaders are not supported',
  MLEADER: 'multileaders are not supported',
  OLE2FRAME: 'OLE objects are not supported',
  OLEFRAME: 'OLE objects are not supported',
  '3DSOLID': '3D solids are not supported',
  REGION: 'regions (ACIS bodies) are not supported',
  BODY: 'ACIS bodies are not supported',
  SURFACE: 'surfaces are not supported',
  MESH: 'meshes are not supported',
  ACAD_PROXY_ENTITY: 'proxy entities are not supported',
  SHAPE: 'SHX shapes are not supported',
  TOLERANCE: 'geometric tolerances are not supported',
  'POLYLINE (polyface mesh)': 'polyface meshes are not supported',
  'POLYLINE (polygon mesh)': 'polygon meshes are not supported',
};

/** Converts DXF records to the flattened EntityStore. */
export class Emitter {
  private readonly t: Tags;
  private readonly layerIdx = new Map<string, number>();
  private readonly layerLt: number[] = [];
  private readonly ltIdx = new Map<string, number>();
  private readonly ltScale: number;
  private readonly meta: EntityMeta = { type: ET.LINE, layer: 0, color: 0 };
  private readonly bb = new BBox();
  private readonly bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  // Slot lookup for the entity currently being converted (first occurrence of each code wins).
  private readonly sNum = new Float64Array(SLOTS);
  private readonly sStr: string[] = new Array<string>(SLOTS).fill('');
  private readonly sGen = new Int32Array(SLOTS);
  private gen = 0;
  private readonly skippedRecs = new WeakSet<Rec>();
  private readonly skipReasons = new Map<string, string>();
  private readonly invalidSamples: string[] = [];
  private invalidCount = 0;
  private readonly warned = new Set<string>();
  private readonly splineCache = new WeakMap<Rec, number[]>();
  private readonly hatchCache = new WeakMap<
    Rec,
    { data: HatchData; segs: Float64Array | null; capped: boolean; tooDense: boolean }
  >();
  private emitted = 0;
  private visits = 0;

  constructor(
    private readonly doc: DxfDocument,
    private readonly b: EntityStoreBuilder,
    private readonly report: ImportReport,
    private readonly opts: EmitOptions,
  ) {
    this.t = doc.tags;
    // Effective linetype scale = $LTSCALE × entity 48 (× block scale). $CELTSCALE is only the default
    // for *new* entities: AutoCAD treats a missing 48 as 1.0, so it is intentionally not applied here.
    const lts = doc.header.get('$LTSCALE')?.num;
    this.ltScale = lts && lts > 0 && Number.isFinite(lts) ? lts : 1;
    this.buildLinetypes();
    this.buildLayers();
  }

  // ------------------------------------------------------------------------------------------
  // Tables

  private buildLinetypes() {
    const t = this.t;
    this.ltIdx.set('CONTINUOUS', 0);
    for (const r of this.doc.tables.get('LTYPE') ?? []) {
      const name = recStr(t, r, 2).trim();
      const key = name.toUpperCase();
      if (!name || key === 'BYLAYER' || key === 'BYBLOCK' || this.ltIdx.has(key)) continue;
      const pattern: number[] = [];
      for (let i = r.s; i < r.e; i++)
        if (t.code[i] === 49 && Number.isFinite(t.num[i])) pattern.push(t.num[i]);
      if (key === 'CONTINUOUS') continue;
      const def: LinetypeDef = { name, pattern };
      this.ltIdx.set(key, this.b.linetypes.length);
      this.b.linetypes.push(def);
    }
  }

  private buildLayers() {
    const t = this.t;
    for (const r of this.doc.tables.get('LAYER') ?? []) {
      const name = recStr(t, r, 2).trim();
      if (!name || this.layerIdx.has(name.toUpperCase())) continue;
      const aci = recNum(t, r, 62, 7);
      const tc = recNum(t, r, 420, -1);
      const flags = recNum(t, r, 70, 0);
      const lt = recStr(t, r, 6, 'CONTINUOUS').trim() || 'CONTINUOUS';
      const lw = recNum(t, r, 370, -3);
      const layer: SourceLayer = {
        name,
        color: tc >= 0 ? tc & 0xffffff : aciToRgb(aci === 0 ? 7 : aci),
        linetype: lt,
        lineweight: lw >= 0 ? lw : -3,
        off: aci < 0,
        frozen: (flags & 1) === 1,
        // "Defpoints" never plots (R12 files cannot store the plot flag).
        plot: recNum(t, r, 290, 1) !== 0 && name.toUpperCase() !== 'DEFPOINTS',
      };
      this.addLayer(layer);
    }
    if (!this.layerIdx.has('0')) {
      this.addLayer({
        name: '0',
        color: 0xffffff,
        linetype: 'CONTINUOUS',
        lineweight: -3,
        off: false,
        frozen: false,
        plot: true,
      });
    }
  }

  private addLayer(layer: SourceLayer): number {
    const idx = this.b.layers.length;
    if (idx >= 65535) return 0;
    this.b.layers.push(layer);
    this.layerIdx.set(layer.name.toUpperCase(), idx);
    const key = layer.linetype.toUpperCase();
    let lt = this.ltIdx.get(key);
    if (lt === undefined) {
      if (key !== 'BYLAYER' && key !== 'BYBLOCK')
        this.warnOnce(`lt:${key}`, `Linetype "${layer.linetype}" is not defined — drawn continuous.`);
      lt = 0;
    }
    this.layerLt[idx] = lt;
    return idx;
  }

  private layerOf(name: string): number {
    const key = name.trim().toUpperCase() || '0';
    const idx = this.layerIdx.get(key);
    if (idx !== undefined) return idx;
    return this.addLayer({
      name: name.trim() || '0',
      color: 0xffffff,
      linetype: 'CONTINUOUS',
      lineweight: -3,
      off: false,
      frozen: false,
      plot: true,
    });
  }

  // ------------------------------------------------------------------------------------------
  // Helpers

  warnOnce(key: string, msg: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.report.warnings.push(msg);
  }

  private load(r: Rec) {
    const g = ++this.gen;
    const t = this.t;
    const { sGen, sNum, sStr } = this;
    for (let i = r.s; i < r.e; i++) {
      const c = t.code[i];
      if (c >= 0 && c < SLOTS && sGen[c] !== g) {
        sGen[c] = g;
        sNum[c] = t.num[i];
        sStr[c] = t.str[i];
      }
    }
  }

  private has(code: number): boolean {
    return this.sGen[code] === this.gen;
  }

  private n(code: number, def: number): number {
    return this.sGen[code] === this.gen ? this.sNum[code] : def;
  }

  private s(code: number, def = ''): string {
    return this.sGen[code] === this.gen ? this.sStr[code] : def;
  }

  /** Resolves layer, colour, linetype, lineweight, linetype scale and flags of the loaded record. */
  private props(type: EntityTypeCode, ctx: Ctx): EntityMeta {
    const m = this.meta;
    m.type = type;
    let layer = this.layerOf(this.s(8, '0'));
    if (ctx.layer0 >= 0 && layer === this.layerIdx.get('0')) layer = ctx.layer0;
    m.layer = layer;
    const L = this.b.layers[layer];
    const tc = this.n(420, -1);
    if (tc >= 0) m.color = tc & 0xffffff;
    else {
      const aci = Math.abs(this.n(62, 256));
      m.color = aci === 0 ? ctx.byBlockColor : aci >= 256 ? L.color : aciToRgb(aci);
    }
    const ltName = this.s(6, '');
    if (!ltName) m.linetype = this.layerLt[layer];
    else {
      const key = ltName.trim().toUpperCase();
      if (key === 'BYLAYER') m.linetype = this.layerLt[layer];
      else if (key === 'BYBLOCK') m.linetype = ctx.byBlockLt;
      else {
        let lt = this.ltIdx.get(key);
        if (lt === undefined) {
          this.warnOnce(`lt:${key}`, `Linetype "${ltName.trim()}" is not defined — drawn continuous.`);
          lt = 0;
        }
        m.linetype = lt;
      }
    }
    const lw = this.n(370, -1);
    m.lineweight = lw === -1 ? L.lineweight : lw === -2 ? ctx.byBlockLw : lw < 0 ? -3 : lw;
    const els = this.n(48, 1);
    m.ltscale = this.ltScale * (els > 0 ? els : 1) * (ctx.xf ? ctx.xf.scale || 1 : 1);
    m.flags = ctx.flags | (this.n(60, 0) === 1 ? FLAG.HIDDEN : 0);
    m.handle = this.s(5, '');
    m.insertIndex = ctx.insertIndex;
    return m;
  }

  private tick() {
    if (this.opts.signal?.aborted) throw new DxfAbortError();
  }

  /** Counts one unit of flattening work (entity or array cell); checks abort and the work limit. */
  private visit() {
    if ((++this.visits & 4095) === 0) {
      this.tick();
      if (this.visits > (this.opts.maxVisits ?? MAX_VISITS)) throw new LimitError();
    }
  }

  private add(kind: GeomKind, values: ArrayLike<number>, bb: BBox, text?: string) {
    if (!(
      Math.abs(bb.minX) < COORD_LIMIT &&
      Math.abs(bb.minY) < COORD_LIMIT &&
      Math.abs(bb.maxX) < COORD_LIMIT &&
      Math.abs(bb.maxY) < COORD_LIMIT
    )) {
      throw new InvalidEntityError('invalid or out-of-range coordinates');
    }
    for (let i = 0; i < values.length; i++)
      if (!Number.isFinite(values[i])) throw new InvalidEntityError('invalid geometry values');
    const out = this.bounds;
    out.minX = bb.minX;
    out.minY = bb.minY;
    out.maxX = bb.maxX;
    out.maxY = bb.maxY;
    this.b.add(this.meta, kind, values, out, text);
    if ((++this.emitted & 4095) === 0) {
      this.tick();
      if (this.b.count > (this.opts.maxEntities ?? MAX_ENTITIES)) throw new LimitError();
    }
  }

  skip(r: Rec, name: string, reason: string) {
    if (this.skippedRecs.has(r)) return;
    this.skippedRecs.add(r);
    this.report.skipped[name] = (this.report.skipped[name] ?? 0) + 1;
    if (!this.skipReasons.has(name)) this.skipReasons.set(name, reason);
  }

  private invalid(r: Rec, type: string, msg: string) {
    if (this.skippedRecs.has(r)) return;
    this.skip(r, type, 'invalid data');
    this.invalidCount++;
    if (this.invalidSamples.length < 20) this.invalidSamples.push(`${type} at ${where(this.doc, r)}: ${msg}`);
  }

  // ------------------------------------------------------------------------------------------
  // Driver

  rootCtx(): Ctx {
    return {
      xf: null,
      byBlockColor: 0xffffff,
      byBlockLt: 0,
      byBlockLw: -3,
      layer0: -1,
      flags: 0,
      insertIndex: -1,
      depth: 0,
      stack: [],
    };
  }

  /** Emits top-level entities of a layout. */
  run(ents: Rec[]) {
    const ctx = this.rootCtx();
    const counts = this.report.counts;
    const n = ents.length;
    const step = Math.max(1, Math.floor(n / 100));
    let limitHit = false;
    for (let i = 0; i < n; i++) {
      if (i % step === 0) {
        this.tick();
        this.opts.tick(i / n);
      }
      const r = ents[i];
      try {
        if (this.entity(r, ctx)) {
          counts[r.type] = (counts[r.type] ?? 0) + 1;
          if (r.type === 'INSERT' && r.sub) counts.ATTRIB = (counts.ATTRIB ?? 0) + r.sub.length;
        }
      } catch (e) {
        if (e instanceof LimitError) {
          limitHit = true;
          break;
        }
        throw e;
      }
    }
    if (limitHit) {
      this.report.errors.push(
        `The drawing expands to too many entities through nested block references/arrays (limit ${(this.opts.maxEntities ?? MAX_ENTITIES).toLocaleString('en')}); import stopped there.`,
      );
    }
    this.opts.tick(1);
    this.finishReport();
  }

  private finishReport() {
    for (const [name, count] of Object.entries(this.report.skipped)) {
      const reason = this.skipReasons.get(name) ?? 'not supported';
      if (reason === 'invalid data') continue;
      this.report.warnings.push(
        `${count} ${name} ${count === 1 ? 'entity' : 'entities'} skipped: ${reason}.`,
      );
    }
    if (this.invalidCount) {
      this.report.warnings.push(
        `${this.invalidCount} invalid ${this.invalidCount === 1 ? 'entity was' : 'entities were'} skipped` +
          (this.invalidSamples.length
            ? ` (${this.invalidSamples.join('; ')}${this.invalidCount > this.invalidSamples.length ? '; …' : ''}).`
            : '.'),
      );
    }
  }

  /** Converts one record (and its children). Returns false when the entity was skipped. */
  private entity(r: Rec, ctx: Ctx): boolean {
    this.visit();
    const type = r.type;
    try {
      switch (type) {
        case 'LINE':
          this.line(r, ctx);
          return true;
        case 'POINT':
          this.point(r, ctx);
          return true;
        case 'CIRCLE':
        case 'ARC':
          this.circleArc(r, ctx, type === 'ARC');
          return true;
        case 'ELLIPSE':
          this.ellipse(r, ctx);
          return true;
        case 'LWPOLYLINE':
          return this.lwpolyline(r, ctx);
        case 'POLYLINE':
          return this.polyline(r, ctx);
        case 'SPLINE':
        case 'HELIX':
          return this.spline(r, ctx);
        case 'SOLID':
        case 'TRACE':
          this.solid(r, ctx, type === 'SOLID' ? ET.SOLID : ET.TRACE);
          return true;
        case '3DFACE':
          this.face3d(r, ctx);
          return true;
        case 'HATCH':
          this.hatch(r, ctx);
          return true;
        case 'TEXT':
          this.text(r, ctx, 'TEXT');
          return true;
        case 'ATTDEF':
          // Attribute definitions inside blocks are templates and are not displayed.
          if (ctx.depth > 0) return false;
          this.text(r, ctx, 'ATTDEF');
          return true;
        case 'MTEXT':
          this.mtext(r, ctx);
          return true;
        case 'INSERT':
          return this.insert(r, ctx);
        case 'DIMENSION':
        case 'ARC_DIMENSION':
        case 'LARGE_RADIAL_DIMENSION':
        case 'ACAD_TABLE':
          return this.blockGeometry(r, ctx);
        case 'LEADER':
          return this.leader(r, ctx);
        default:
          this.skip(r, type, SKIP_REASON[type] ?? 'entity type not supported');
          return false;
      }
    } catch (e) {
      if (e instanceof InvalidEntityError) {
        this.invalid(r, type, e.message);
        return false;
      }
      if (e instanceof DxfAbortError || e instanceof LimitError) throw e;
      if (e instanceof RangeError || e instanceof TypeError) {
        this.invalid(r, type, e.message);
        return false;
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Simple entities

  private line(r: Rec, ctx: Ctx) {
    this.load(r);
    this.props(ET.LINE, ctx);
    let x1 = this.n(10, NaN);
    let y1 = this.n(20, NaN);
    const z1 = this.n(30, 0);
    let x2 = this.n(11, NaN);
    let y2 = this.n(21, NaN);
    const z2 = this.n(31, 0);
    const xf = ctx.xf;
    if (xf) {
      const a = xf.x(x1, y1, z1);
      y1 = xf.y(x1, y1, z1);
      x1 = a;
      const c = xf.x(x2, y2, z2);
      y2 = xf.y(x2, y2, z2);
      x2 = c;
    }
    const bb = this.bb.reset();
    bb.add(x1, y1);
    bb.add(x2, y2);
    this.add(GK.LINE, [x1, y1, x2, y2], bb);
  }

  private point(r: Rec, ctx: Ctx) {
    this.load(r);
    this.props(ET.POINT, ctx);
    let x = this.n(10, NaN);
    let y = this.n(20, NaN);
    const z = this.n(30, 0);
    if (ctx.xf) {
      const a = ctx.xf.x(x, y, z);
      y = ctx.xf.y(x, y, z);
      x = a;
    }
    const bb = this.bb.reset();
    bb.add(x, y);
    this.add(GK.POINT, [x, y], bb);
  }

  private extrusion(): Xform | null {
    if (!this.has(210) && !this.has(220) && !this.has(230)) return null;
    return ocsXform(this.n(210, 0), this.n(220, 0), this.n(230, 1));
  }

  private circleArc(r: Rec, ctx: Ctx, isArc: boolean) {
    this.load(r);
    this.props(isArc ? ET.ARC : ET.CIRCLE, ctx);
    const cx = this.n(10, NaN);
    const cy = this.n(20, NaN);
    const cz = this.n(30, 0);
    const rad = this.n(40, NaN);
    if (!(rad > 0)) throw new InvalidEntityError('radius must be positive');
    const t0 = isArc ? this.n(50, 0) * DEG : 0;
    const t1 = isArc ? this.n(51, 360) * DEG : TAU;
    const xf = compose(ctx.xf, this.extrusion());
    if (!xf) {
      const bb = this.bb.reset();
      if (!isArc) {
        bb.add(cx - rad, cy - rad);
        bb.add(cx + rad, cy + rad);
        this.add(GK.CIRCLE, [cx, cy, rad], bb);
      } else {
        const a0 = normAngle(t0);
        const a1 = normAngle(t1);
        bb.addArc(cx, cy, rad, a0, a1);
        this.add(GK.ARC, [cx, cy, rad, a0, a1], bb);
      }
      return;
    }
    this.conic(xf, cx, cy, cz, rad, 0, 0, 0, rad, 0, t0, t1, !isArc, false);
  }

  private ellipse(r: Rec, ctx: Ctx) {
    this.load(r);
    this.props(ET.ELLIPSE, ctx);
    const cx = this.n(10, NaN);
    const cy = this.n(20, NaN);
    const cz = this.n(30, 0);
    const mx = this.n(11, NaN);
    const my = this.n(21, NaN);
    const mz = this.n(31, 0);
    let ratio = this.n(40, 1);
    if (!(ratio > 0)) throw new InvalidEntityError('axis ratio must be positive');
    if (ratio > 1) ratio = 1;
    const t0 = this.n(41, 0);
    const t1 = this.n(42, TAU);
    let nx = this.n(210, 0);
    let ny = this.n(220, 0);
    let nz = this.n(230, 1);
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 0) {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    } else {
      nx = 0;
      ny = 0;
      nz = 1;
    }
    const full = Math.abs(t1 - t0) >= TAU - 1e-10 || (t0 === 0 && t1 === 0);
    if (!ctx.xf && nx === 0 && ny === 0 && nz > 0) {
      if (!(Math.hypot(mx, my) > 0)) throw new InvalidEntityError('zero-length major axis');
      const p1 = full ? t0 + TAU : t1;
      const bb = this.bb.reset();
      bb.addEllipse(cx, cy, mx, my, ratio, t0, p1);
      this.add(GK.ELLIPSE, [cx, cy, mx, my, ratio, t0, p1], bb);
      return;
    }
    // Minor axis = N × major × ratio (WCS).
    const vx = (ny * mz - nz * my) * ratio;
    const vy = (nz * mx - nx * mz) * ratio;
    const vz = (nx * my - ny * mx) * ratio;
    this.conic(ctx.xf, cx, cy, cz, mx, my, mz, vx, vy, vz, t0, full ? t0 + TAU : t1, full, true);
  }

  /**
   * Emits the projection of c + u·cos t + v·sin t, t ∈ [t0, t1] (3D vectors before `xf`), as a
   * circle/arc when it stays circular, otherwise as an ellipse.
   */
  private conic(
    xf: Xform | null,
    cx: number,
    cy: number,
    cz: number,
    ux: number,
    uy: number,
    uz: number,
    vx: number,
    vy: number,
    vz: number,
    t0: number,
    t1: number,
    full: boolean,
    preferEllipse: boolean,
  ) {
    let Cx = cx;
    let Cy = cy;
    let Ux = ux;
    let Uy = uy;
    let Vx = vx;
    let Vy = vy;
    if (xf) {
      Cx = xf.x(cx, cy, cz);
      Cy = xf.y(cx, cy, cz);
      Ux = xf.vx(ux, uy, uz);
      Uy = xf.vy(ux, uy, uz);
      Vx = xf.vx(vx, vy, vz);
      Vy = xf.vy(vx, vy, vz);
    }
    let cr = Ux * Vy - Uy * Vx;
    if (cr < 0) {
      // Mirrored: reverse the parameter direction so the curve is CCW again.
      Vx = -Vx;
      Vy = -Vy;
      const a = -t1;
      t1 = -t0;
      t0 = a;
      cr = -cr;
    }
    const lu = Math.hypot(Ux, Uy);
    const lv = Math.hypot(Vx, Vy);
    if (!(lu > 0 || lv > 0)) throw new InvalidEntityError('degenerate curve');
    const dot = Ux * Vx + Uy * Vy;
    const lmax = Math.max(lu, lv);
    const circular = Math.abs(lu - lv) <= 1e-9 * lmax && Math.abs(dot) <= 1e-9 * lu * lv;
    const bb = this.bb.reset();
    if (circular && !preferEllipse) {
      const rad = lu;
      if (full) {
        bb.add(Cx - rad, Cy - rad);
        bb.add(Cx + rad, Cy + rad);
        this.add(GK.CIRCLE, [Cx, Cy, rad], bb);
      } else {
        const base = Math.atan2(Uy, Ux);
        const a0 = normAngle(base + t0);
        const a1 = normAngle(base + t1);
        bb.addArc(Cx, Cy, rad, a0, a1);
        this.add(GK.ARC, [Cx, Cy, rad, a0, a1], bb);
      }
      return;
    }
    const theta = 0.5 * Math.atan2(2 * dot, lu * lu - lv * lv);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const Mx = Ux * c + Vx * s;
    const My = Uy * c + Vy * s;
    const Nx = -Ux * s + Vx * c;
    const Ny = -Uy * s + Vy * c;
    const lm = Math.hypot(Mx, My);
    if (!(lm > 0)) throw new InvalidEntityError('degenerate ellipse');
    const ratio = Math.min(1, Math.hypot(Nx, Ny) / lm);
    const p0 = t0 - theta;
    const p1 = full ? p0 + TAU : t1 - theta;
    bb.addEllipse(Cx, Cy, Mx, My, ratio, p0, p1);
    this.add(GK.ELLIPSE, [Cx, Cy, Mx, My, ratio, p0, p1], bb);
  }

  // ------------------------------------------------------------------------------------------
  // Polylines

  /** Transforms (x, y, bulge) vertices at elevation z; arcs are tessellated under non-uniform transforms. */
  private transformVerts(v: number[], z: number, xf: Xform | null, closed: boolean): number[] {
    if (!xf) return v;
    const n = v.length / 3;
    const out: number[] = [];
    if (xf.similar) {
      const sgn = xf.det2 < 0 ? -1 : 1;
      for (let i = 0; i < n; i++) {
        const x = v[i * 3];
        const y = v[i * 3 + 1];
        out.push(xf.x(x, y, z), xf.y(x, y, z), v[i * 3 + 2] * sgn || 0);
      }
      return out;
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < n; i++) {
      const x0 = v[i * 3];
      const y0 = v[i * 3 + 1];
      const b = v[i * 3 + 2];
      out.push(xf.x(x0, y0, z), xf.y(x0, y0, z), 0);
      if (b && i < segs) {
        const j = (i + 1) % n;
        const x1 = v[j * 3];
        const y1 = v[j * 3 + 1];
        const chord = Math.hypot(x1 - x0, y1 - y0);
        if (chord === 0) continue;
        const theta = 4 * Math.atan(b);
        const rad = chord / (2 * Math.abs(Math.sin(theta / 2)));
        const h = (chord / 2) * ((1 - b * b) / (2 * b));
        const ux = (x1 - x0) / chord;
        const uy = (y1 - y0) / chord;
        const cx = (x0 + x1) / 2 - uy * h;
        const cy = (y0 + y1) / 2 + ux * h;
        const a0 = Math.atan2(y0 - cy, x0 - cx);
        const k = Math.min(512, arcSegments(rad, theta, rad * 1e-3));
        for (let q = 1; q < k; q++) {
          const a = a0 + (theta * q) / k;
          const px = cx + rad * Math.cos(a);
          const py = cy + rad * Math.sin(a);
          out.push(xf.x(px, py, z), xf.y(px, py, z), 0);
        }
      }
    }
    return out;
  }

  private addPolyBounds(v: number[], closed: boolean, bb: BBox) {
    const n = v.length / 3;
    for (let i = 0; i < n; i++) {
      const x = v[i * 3];
      const y = v[i * 3 + 1];
      bb.add(x, y);
      const b = v[i * 3 + 2];
      if (b && (closed || i < n - 1)) {
        const j = (i + 1) % n;
        bb.addBulge(x, y, v[j * 3], v[j * 3 + 1], b);
      }
    }
  }

  private emitPoly(verts: number[], closed: boolean) {
    const n = verts.length / 3;
    const values = new Array<number>(1 + verts.length);
    values[0] = n;
    for (let i = 0; i < verts.length; i++) values[i + 1] = verts[i];
    const bb = this.bb.reset();
    this.addPolyBounds(verts, closed, bb);
    if (closed) this.meta.flags = (this.meta.flags ?? 0) | FLAG.CLOSED;
    this.add(GK.POLY, values, bb);
  }

  private lwpolyline(r: Rec, ctx: Ctx): boolean {
    this.load(r);
    const t = this.t;
    const verts: number[] = [];
    for (let i = r.s; i < r.e; i++) {
      const c = t.code[i];
      if (c === 10) verts.push(t.num[i], 0, 0);
      else if (c === 20 && verts.length) verts[verts.length - 2] = t.num[i];
      else if (c === 42 && verts.length) verts[verts.length - 1] = t.num[i];
    }
    if (verts.length < 6) throw new InvalidEntityError('fewer than 2 vertices');
    this.props(ET.LWPOLYLINE, ctx);
    const closed = (this.n(70, 0) & 1) === 1;
    const xf = compose(ctx.xf, this.extrusion());
    this.emitPoly(this.transformVerts(verts, this.n(38, 0), xf, closed), closed);
    return true;
  }

  private polyline(r: Rec, ctx: Ctx): boolean {
    this.load(r);
    const flags = this.n(70, 0);
    if (flags & 64) {
      this.skip(r, 'POLYLINE (polyface mesh)', SKIP_REASON['POLYLINE (polyface mesh)']);
      return false;
    }
    if (flags & 16) {
      this.skip(r, 'POLYLINE (polygon mesh)', SKIP_REASON['POLYLINE (polygon mesh)']);
      return false;
    }
    const closed = (flags & 1) === 1;
    const is3d = (flags & 8) !== 0;
    const elevation = this.n(30, 0);
    const ocs = is3d ? null : this.extrusion();
    this.props(ET.POLYLINE, ctx);
    const meta = { ...this.meta };
    const t = this.t;
    const verts: number[] = [];
    const zs: number[] = [];
    for (const v of r.sub ?? []) {
      let x = NaN;
      let y = NaN;
      let z = 0;
      let b = 0;
      let vf = 0;
      for (let i = v.s; i < v.e; i++) {
        const c = t.code[i];
        if (c === 10) x = t.num[i];
        else if (c === 20) y = t.num[i];
        else if (c === 30) z = t.num[i];
        else if (c === 42) b = t.num[i];
        else if (c === 70) vf = t.num[i];
      }
      if (vf & 16) continue; // spline frame control point (not displayed)
      verts.push(x, y, is3d ? 0 : b);
      zs.push(z);
    }
    if (verts.length < 6) throw new InvalidEntityError('fewer than 2 vertices');
    Object.assign(this.meta, meta);
    if (is3d) {
      const xf = ctx.xf;
      const out: number[] = [];
      for (let i = 0; i < zs.length; i++) {
        const x = verts[i * 3];
        const y = verts[i * 3 + 1];
        const z = zs[i];
        out.push(xf ? xf.x(x, y, z) : x, xf ? xf.y(x, y, z) : y, 0);
      }
      this.emitPoly(out, closed);
    } else {
      this.emitPoly(this.transformVerts(verts, elevation, compose(ctx.xf, ocs), closed), closed);
    }
    return true;
  }

  private splineData(r: Rec): SplineData {
    const t = this.t;
    const sp: SplineData = {
      degree: 3,
      knots: [],
      ctrl: [],
      weights: [],
      fit: [],
      startTangent: null,
      endTangent: null,
      closed: false,
    };
    const weights: number[] = [];
    for (let i = r.s; i < r.e; i++) {
      const c = t.code[i];
      const v = t.num[i];
      switch (c) {
        case 70:
          sp.closed = (v & 1) === 1;
          break;
        case 71:
          sp.degree = v;
          break;
        case 40:
          sp.knots.push(v);
          break;
        case 41:
          weights.push(v);
          break;
        case 10:
          sp.ctrl.push(v, 0, 0);
          break;
        case 20:
          sp.ctrl[sp.ctrl.length - 2] = v;
          break;
        case 30:
          sp.ctrl[sp.ctrl.length - 1] = v;
          break;
        case 11:
          sp.fit.push(v, 0, 0);
          break;
        case 21:
          sp.fit[sp.fit.length - 2] = v;
          break;
        case 31:
          sp.fit[sp.fit.length - 1] = v;
          break;
        case 12:
          sp.startTangent = [v, 0, 0];
          break;
        case 22:
          if (sp.startTangent) sp.startTangent[1] = v;
          break;
        case 32:
          if (sp.startTangent) sp.startTangent[2] = v;
          break;
        case 13:
          sp.endTangent = [v, 0, 0];
          break;
        case 23:
          if (sp.endTangent) sp.endTangent[1] = v;
          break;
        case 33:
          if (sp.endTangent) sp.endTangent[2] = v;
          break;
      }
    }
    sp.weights = weights.length === sp.ctrl.length / 3 ? weights : null;
    return sp;
  }

  private spline(r: Rec, ctx: Ctx): boolean {
    this.load(r);
    this.props(ET.SPLINE, ctx);
    let pts = this.splineCache.get(r);
    let closed = (this.n(70, 0) & 1) === 1;
    if (!pts) {
      const sp = this.splineData(r);
      pts = tessellateSpline(sp, (m) => this.warnOnce(`spline:${m}`, m));
      this.splineCache.set(r, pts);
    }
    const n = pts.length / 3;
    if (n < 2) throw new InvalidEntityError('spline has no control or fit points');
    const xf = ctx.xf;
    const verts: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      const z = pts[i * 3 + 2];
      verts.push(xf ? xf.x(x, y, z) : x, xf ? xf.y(x, y, z) : y, 0);
    }
    const last = verts.length - 3;
    if (verts.length > 6 && verts[0] === verts[last] && verts[1] === verts[last + 1]) {
      verts.length = last;
      closed = true;
    } else if (
      closed &&
      verts.length > 6 &&
      Math.hypot(verts[0] - verts[last], verts[1] - verts[last + 1]) < 1e-9
    ) {
      verts.length = last;
    }
    this.emitPoly(verts, closed);
    return true;
  }

  private leader(r: Rec, ctx: Ctx): boolean {
    this.load(r);
    this.props(ET.LEADER, ctx);
    const t = this.t;
    const xf = ctx.xf;
    const verts: number[] = [];
    let x = NaN;
    let y = NaN;
    let z = 0;
    let pending = false;
    const flush = () => {
      if (pending) verts.push(xf ? xf.x(x, y, z) : x, xf ? xf.y(x, y, z) : y, 0);
      pending = false;
      z = 0;
    };
    for (let i = r.s; i < r.e; i++) {
      const c = t.code[i];
      if (c === 10) {
        flush();
        x = t.num[i];
        pending = true;
      } else if (c === 20) y = t.num[i];
      else if (c === 30) z = t.num[i];
    }
    flush();
    if (verts.length < 6) throw new InvalidEntityError('fewer than 2 vertices');
    this.emitPoly(verts, false);
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // Filled entities

  private emitFill(rings: number[][]) {
    const values: number[] = [rings.length];
    const bb = this.bb.reset();
    for (const ring of rings) {
      values.push(ring.length / 3);
      for (let i = 0; i < ring.length; i++) values.push(ring[i]);
      this.addPolyBounds(ring, true, bb);
    }
    this.add(GK.FILL, values, bb);
  }

  private solid(r: Rec, ctx: Ctx, type: EntityTypeCode) {
    this.load(r);
    this.props(type, ctx);
    const z = this.n(30, 0);
    const p: number[] = [
      this.n(10, NaN),
      this.n(20, NaN),
      this.n(11, NaN),
      this.n(21, NaN),
      this.n(12, NaN),
      this.n(22, NaN),
    ];
    p.push(this.n(13, p[4]), this.n(23, p[5]));
    // DXF vertex order 1, 2, 4, 3.
    const ring: number[] = [p[0], p[1], 0, p[2], p[3], 0, p[6], p[7], 0];
    if (p[6] !== p[4] || p[7] !== p[5]) ring.push(p[4], p[5], 0);
    const xf = compose(ctx.xf, this.extrusion());
    this.emitFill([this.transformVerts(ring, z, xf, true)]);
  }

  private face3d(r: Rec, ctx: Ctx) {
    this.load(r);
    this.props(ET.FACE3D, ctx);
    const xf = ctx.xf;
    const pts: number[] = [];
    for (let k = 0; k < 4; k++) {
      const x = this.n(10 + k, k === 3 ? this.n(12, NaN) : NaN);
      const y = this.n(20 + k, k === 3 ? this.n(22, NaN) : NaN);
      const z = this.n(30 + k, k === 3 ? this.n(32, 0) : 0);
      pts.push(xf ? xf.x(x, y, z) : x, xf ? xf.y(x, y, z) : y, 0);
    }
    if (pts[9] === pts[6] && pts[10] === pts[7]) pts.length = 9;
    this.emitPoly(pts, true);
  }

  private hatch(r: Rec, ctx: Ctx) {
    this.load(r);
    this.props(ET.HATCH, ctx);
    const meta = { ...this.meta };
    let cached = this.hatchCache.get(r);
    if (!cached) {
      const data = parseHatch(this.t, r, (m) => this.warnOnce(`hatch:${m}`, m));
      cached = { data, segs: null, capped: false, tooDense: false };
      this.hatchCache.set(r, cached);
    }
    const h = cached.data;
    if (!h.rings.length) throw new InvalidEntityError('hatch has no usable boundary');
    const [nx, ny, nz] = h.extrusion;
    const xf = compose(ctx.xf, nx === 0 && ny === 0 && nz > 0 ? null : ocsXform(nx, ny, nz));
    const pattern = !h.solid && h.patternName.toUpperCase() !== 'SOLID';
    Object.assign(this.meta, meta);
    this.meta.flags = (meta.flags ?? 0) | (pattern ? FLAG.PATTERN : 0);
    this.emitFill(h.rings.map((ring: Ring) => this.transformVerts(ring, h.elevation, xf, true)));
    if (!pattern || !h.lines.length) return;

    if (!cached.segs) {
      let size = 0;
      for (const ring of h.rings) {
        for (let i = 0; i < ring.length; i += 3)
          size = Math.max(size, Math.abs(ring[i] - h.rings[0][0]), Math.abs(ring[i + 1] - h.rings[0][1]));
      }
      const polys = flattenRings(h.rings, Math.max(size * 1e-4, 1e-9));
      const res = generatePattern(polys, h.lines);
      cached.segs = res.segs;
      cached.capped = res.capped;
      cached.tooDense = res.tooDense;
    }
    const handle = meta.handle || '?';
    if (cached.capped) {
      this.warnOnce(
        `hatchcap:${handle}`,
        `HATCH ${handle} (${h.patternName || 'pattern'}): more than 20 000 pattern line segments — pattern truncated.`,
      );
    }
    if (cached.tooDense) {
      this.warnOnce(
        `hatchdense:${handle}`,
        `HATCH ${handle} (${h.patternName || 'pattern'}): pattern too dense for its area — only the outline is shown.`,
      );
    }
    const segs = cached.segs;
    const z = h.elevation;
    Object.assign(this.meta, meta);
    this.meta.flags = (meta.flags ?? 0) | FLAG.DERIVED;
    const bb = this.bb;
    for (let i = 0; i < segs.length; i += 4) {
      let x1 = segs[i];
      let y1 = segs[i + 1];
      let x2 = segs[i + 2];
      let y2 = segs[i + 3];
      if (xf) {
        const a = xf.x(x1, y1, z);
        y1 = xf.y(x1, y1, z);
        x1 = a;
        const c = xf.x(x2, y2, z);
        y2 = xf.y(x2, y2, z);
        x2 = c;
      }
      bb.reset();
      bb.add(x1, y1);
      bb.add(x2, y2);
      this.add(GK.LINE, [x1, y1, x2, y2], bb);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Text

  /**
   * Emits a GK.TEXT entity. The text frame is given by the anchor and two local vectors (u = text
   * direction, v = glyph "up" including oblique slant), both mapped through `xf`, then decomposed
   * into rotation / height / width factor / oblique. A mirrored frame yields a negative width factor.
   */
  private emitText(
    text: string,
    xf: Xform | null,
    ax: number,
    ay: number,
    az: number,
    ux: number,
    uy: number,
    uz: number,
    vx: number,
    vy: number,
    vz: number,
    height: number,
    wf: number,
    hAlign: number,
    vAlign: number,
    boxWidth: number,
    lineSpacing: number,
    isMText: boolean,
    plain: { rotation: number; oblique: number } | null = null,
  ) {
    let X = ax;
    let Y = ay;
    let Ux = ux;
    let Uy = uy;
    let Vx = vx;
    let Vy = vy;
    if (xf) {
      X = xf.x(ax, ay, az);
      Y = xf.y(ax, ay, az);
      Ux = xf.vx(ux, uy, uz);
      Uy = xf.vy(ux, uy, uz);
      Vx = xf.vx(vx, vy, vz);
      Vy = xf.vy(vx, vy, vz);
    }
    const lu = Math.hypot(Ux, Uy);
    let cr = Ux * Vy - Uy * Vx;
    let rotation: number;
    let h: number;
    let w: number;
    let oblique: number;
    if (plain && !xf) {
      // Untransformed, unmirrored text: keep the file's values exactly.
      rotation = plain.rotation;
      h = height;
      w = wf;
      oblique = plain.oblique;
    } else if (!(lu > 1e-12) || !(Math.abs(cr) > 1e-12 * lu)) {
      // Degenerate (text plane seen edge-on): keep the size, lay it along whatever direction is left.
      rotation = lu > 1e-12 ? Math.atan2(Uy, Ux) : 0;
      h = height;
      w = wf;
      oblique = 0;
      cr = 1;
    } else {
      const sigma = cr < 0 ? -1 : 1;
      rotation = Math.atan2(sigma * Uy, sigma * Ux);
      h = (height * Math.abs(cr)) / lu;
      w = (wf * sigma * lu * lu) / Math.abs(cr);
      oblique = Math.atan((Ux * Vx + Uy * Vy) / cr);
    }
    rotation = normAngle(rotation);
    if (Math.abs(rotation - TAU) < 1e-12) rotation = 0;
    const bw = boxWidth * (xf ? lu : 1);

    // Approximate bounds from an estimated glyph box (0.6 × height per character).
    const lines = text.split('\n');
    let chars = 0;
    for (const l of lines) chars = Math.max(chars, l.length);
    let gw = Math.max(chars, 1) * 0.6;
    let nLines = lines.length;
    if (isMText && bw > 0 && h > 0) {
      const boxG = bw / (h * Math.abs(w || 1));
      if (gw > boxG) {
        let total = 0;
        for (const l of lines) total += Math.max(1, Math.ceil((l.length * 0.6) / boxG));
        nLines = total;
        gw = boxG;
      }
    }
    const pitch = isMText ? (5 / 3) * (lineSpacing > 0 ? lineSpacing : 1) : 1;
    const gh = 1 + (nLines - 1) * pitch;
    const x0 = hAlign === 1 ? -gw / 2 : hAlign === 2 ? -gw : 0;
    let y0: number;
    let y1: number;
    if (isMText) {
      y0 = vAlign === 3 ? -gh : vAlign === 2 ? -gh / 2 : 0;
      y1 = y0 + gh;
    } else {
      y0 = vAlign === 3 ? -1 : vAlign === 2 ? -0.5 : vAlign === 1 ? 0 : -0.3;
      y1 = vAlign === 3 ? 0 : vAlign === 2 ? 0.5 : vAlign === 1 ? 1.3 : 1;
    }
    const cs = Math.cos(rotation);
    const sn = Math.sin(rotation);
    const tn = Math.tan(oblique);
    const bb = this.bb.reset();
    for (const gx of [x0, x0 + gw]) {
      for (const gy of [y0, y1]) {
        const lx = h * (w * gx + tn * gy);
        const ly = h * gy;
        bb.add(X + cs * lx - sn * ly, Y + sn * lx + cs * ly);
      }
    }
    this.add(
      GK.TEXT,
      [X, Y, h, rotation, w, hAlign, vAlign, oblique, bw, isMText ? lineSpacing : 1],
      bb,
      text,
    );
  }

  private text(r: Rec, ctx: Ctx, kind: 'TEXT' | 'ATTRIB' | 'ATTDEF') {
    this.load(r);
    this.props(kind === 'TEXT' || kind === 'ATTDEF' ? ET.TEXT : ET.ATTRIB, ctx);
    if (kind === 'ATTRIB' && this.n(70, 0) & 1) this.meta.flags = (this.meta.flags ?? 0) | FLAG.HIDDEN;
    const raw = kind === 'ATTDEF' ? this.s(2, '') : this.s(1, '');
    const text = decodeText(raw);
    let height = this.n(40, 1);
    if (!(height > 0)) height = 1;
    const rot = this.n(50, 0) * DEG;
    let wf = this.n(41, 1);
    if (!(wf !== 0) || !Number.isFinite(wf)) wf = 1;
    const obl = this.n(51, 0) * DEG;
    const gen = this.n(71, 0);
    const h72 = this.n(72, 0);
    const v7x = kind === 'TEXT' ? this.n(73, 0) : this.n(74, 0);
    const x10 = this.n(10, NaN);
    const y10 = this.n(20, NaN);
    const z = this.n(30, 0);
    const has11 = this.has(11);
    const x11 = this.n(11, x10);
    const y11 = this.n(21, y10);
    let ax = x10;
    let ay = y10;
    let hAlign = 0;
    let vAlign = 0;
    let boxWidth = 0;
    let dir = rot;
    if (h72 === 3 || h72 === 5) {
      // Aligned / fit: the text spans the baseline from the first to the second alignment point.
      if (has11 && (x11 !== x10 || y11 !== y10)) {
        dir = Math.atan2(y11 - y10, x11 - x10);
        boxWidth = Math.hypot(x11 - x10, y11 - y10);
      }
    } else {
      hAlign = h72 === 1 || h72 === 4 ? 1 : h72 === 2 ? 2 : 0;
      vAlign = h72 === 4 ? 2 : v7x >= 0 && v7x <= 3 ? v7x : 0;
      if ((h72 !== 0 || vAlign !== 0) && has11) {
        ax = x11;
        ay = y11;
      }
    }
    let ux = Math.cos(dir);
    let uy = Math.sin(dir);
    let vx = -uy;
    let vy = ux;
    if (gen & 2) {
      ux = -ux;
      uy = -uy;
    }
    if (gen & 4) {
      vx = -vx;
      vy = -vy;
    }
    // Oblique slant leans the glyph "up" vector along the glyph x direction.
    const tn = Math.tan(obl);
    vx += tn * ux;
    vy += tn * uy;
    const xf = compose(ctx.xf, this.extrusion());
    const plain = gen & 6 ? null : { rotation: normAngle(dir), oblique: obl };
    this.emitText(
      text,
      xf,
      ax,
      ay,
      z,
      ux,
      uy,
      0,
      vx,
      vy,
      0,
      height,
      wf,
      hAlign,
      vAlign,
      boxWidth,
      1,
      false,
      plain,
    );
  }

  private mtext(r: Rec, ctx: Ctx) {
    this.load(r);
    this.props(ET.MTEXT, ctx);
    const t = this.t;
    let chunks = '';
    let last = '';
    for (let i = r.s; i < r.e; i++) {
      const c = t.code[i];
      if (c === 3) chunks += t.str[i];
      else if (c === 1) last = t.str[i];
    }
    const text = mtextToPlain(chunks + last);
    let height = this.n(40, 1);
    if (!(height > 0)) height = 1;
    const ap = this.n(71, 1);
    const hAlign = ap >= 1 && ap <= 9 ? (ap - 1) % 3 : 0;
    const row = ap >= 1 && ap <= 9 ? Math.floor((ap - 1) / 3) : 0;
    const vAlign = row === 0 ? 3 : row === 1 ? 2 : 1;
    const boxWidth = Math.max(0, this.n(41, 0));
    const ls = this.n(44, 1);
    let nx = this.n(210, 0);
    let ny = this.n(220, 0);
    let nz = this.n(230, 1);
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 0) {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    } else {
      nx = 0;
      ny = 0;
      nz = 1;
    }
    let ux: number;
    let uy: number;
    let uz: number;
    if (this.has(11) && Math.hypot(this.n(11, 0), this.n(21, 0), this.n(31, 0)) > 0) {
      ux = this.n(11, 1);
      uy = this.n(21, 0);
      uz = this.n(31, 0);
    } else {
      const a = this.n(50, 0) * DEG;
      const ocs = ocsXform(nx, ny, nz);
      const cx = a === 0 ? 1 : Math.cos(a);
      const sx = a === 0 ? 0 : Math.sin(a);
      if (ocs) {
        ux = ocs.vx(cx, sx, 0);
        uy = ocs.vy(cx, sx, 0);
        uz = ocs.z(cx, sx, 0);
      } else {
        ux = cx;
        uy = sx;
        uz = 0;
      }
    }
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul;
    uy /= ul;
    uz /= ul;
    // v = N × u
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;
    this.emitText(
      text,
      ctx.xf,
      this.n(10, NaN),
      this.n(20, NaN),
      this.n(30, 0),
      ux,
      uy,
      uz,
      vx,
      vy,
      vz,
      height,
      1,
      hAlign,
      vAlign,
      boxWidth,
      ls > 0 ? ls : 1,
      true,
    );
  }

  // ------------------------------------------------------------------------------------------
  // Block references

  private findBlock(name: string): DxfBlock | undefined {
    return this.doc.blocks.get(name.trim().toUpperCase());
  }

  private readonly costMemo = new Map<string, number>();

  /**
   * Upper estimate of the records visited when flattening one reference to `blk` (nested references
   * × array cells). Memoised per block; recursive references count as 0 (they are skipped anyway).
   */
  private blockCost(blk: DxfBlock): number {
    const key = blk.name.toUpperCase();
    const memo = this.costMemo.get(key);
    if (memo !== undefined) return memo;
    this.costMemo.set(key, 0); // in progress: cycles contribute nothing
    const t = this.t;
    let cost = 0;
    for (const e of blk.ents) {
      cost += 1 + (e.sub?.length ?? 0);
      const isRef = e.type === 'INSERT' || e.type === 'DIMENSION' || e.type === 'ACAD_TABLE';
      if (!isRef) continue;
      const child = this.findBlock(recStr(t, e, 2));
      if (!child) continue;
      const cells =
        e.type === 'INSERT'
          ? Math.min(
              MAX_ARRAY_CELLS,
              Math.max(1, Math.floor(recNum(t, e, 70, 1))) * Math.max(1, Math.floor(recNum(t, e, 71, 1))),
            )
          : 1;
      cost += cells * (1 + this.blockCost(child));
      if (cost > 1e15) break;
    }
    cost = Math.min(cost, 1e15);
    this.costMemo.set(key, cost);
    return cost;
  }

  /** Emits block content once per cell (`cellAt(k)` = block → parent transform), or returns false when skipped. */
  private expandBlock(
    r: Rec,
    ctx: Ctx,
    blk: DxfBlock,
    cells: number,
    cellAt: (k: number) => Xform | null,
    kind: string,
  ): boolean {
    const key = blk.name.toUpperCase();
    if (ctx.stack.includes(key)) {
      this.warnOnce(
        `cycle:${key}`,
        `Block "${blk.name}" references itself (directly or through nested blocks); the recursive reference was skipped.`,
      );
      this.skip(r, kind, 'recursive block reference');
      return false;
    }
    if (ctx.depth >= MAX_BLOCK_DEPTH) {
      this.warnOnce(
        `depth:${key}`,
        `Block nesting deeper than ${MAX_BLOCK_DEPTH} levels at "${blk.name}" — deeper levels were skipped.`,
      );
      this.skip(r, kind, 'block nesting too deep');
      return false;
    }
    const m = this.meta;
    let insertIndex = ctx.insertIndex;
    if (ctx.depth === 0) {
      insertIndex = this.b.inserts.length;
      this.b.inserts.push({ name: blk.name, handle: m.handle ?? '', type: r.type });
    }
    const base: Ctx = {
      xf: null,
      byBlockColor: m.color,
      byBlockLt: m.linetype ?? 0,
      byBlockLw: m.lineweight ?? -3,
      layer0: m.layer,
      flags: (ctx.flags | FLAG.IN_BLOCK | ((m.flags ?? 0) & FLAG.HIDDEN)) & ~FLAG.CLOSED,
      insertIndex,
      depth: ctx.depth + 1,
      stack: [...ctx.stack, key],
    };
    const attrCtx: Ctx = { ...base, xf: ctx.xf, stack: ctx.stack };
    for (let k = 0; k < cells; k++) {
      this.visit();
      const child: Ctx = { ...base, xf: compose(ctx.xf, cellAt(k)) };
      for (const e of blk.ents) this.entity(e, child);
    }
    if (r.sub) for (const a of r.sub) this.text(a, attrCtx, 'ATTRIB');
    return true;
  }

  private insert(r: Rec, ctx: Ctx): boolean {
    this.load(r);
    const name = this.s(2, '').trim();
    const blk = this.findBlock(name);
    if (!blk) {
      this.warnOnce(
        `noblock:${name.toUpperCase()}`,
        `Block "${name}" is not defined — its references were skipped.`,
      );
      this.skip(r, 'INSERT', 'block definition missing');
      return false;
    }
    if (blk.flags & 4 && blk.ents.length === 0) {
      this.warnOnce(
        `xref:${name.toUpperCase()}`,
        `External reference "${name}"${blk.xrefPath ? ` (${blk.xrefPath})` : ''} is not loaded.`,
      );
      this.skip(r, 'INSERT (xref)', 'external references are not loaded');
      return false;
    }
    let sx = this.n(41, 1);
    let sy = this.n(42, 1);
    let sz = this.n(43, 1);
    if (!Number.isFinite(sx) || sx === 0) sx = 1;
    if (!Number.isFinite(sy) || sy === 0) sy = 1;
    if (!Number.isFinite(sz) || sz === 0) sz = 1;
    const rotDeg = this.n(50, 0);
    const ix = this.n(10, 0);
    const iy = this.n(20, 0);
    const iz = this.n(30, 0);
    let cols = Math.max(1, Math.floor(this.n(70, 1)));
    let rows = Math.max(1, Math.floor(this.n(71, 1)));
    const cs = this.n(44, 0);
    const rs = this.n(45, 0);
    if (!Number.isFinite(ix + iy + iz + rotDeg + cs + rs))
      throw new InvalidEntityError('invalid insertion parameters');
    if (cols * rows > MAX_ARRAY_CELLS) {
      this.warnOnce(
        `array:${this.s(5, '')}`,
        `INSERT array ${cols}×${rows} of "${name}" exceeds ${MAX_ARRAY_CELLS} cells — truncated.`,
      );
      cols = Math.min(cols, MAX_ARRAY_CELLS);
      rows = Math.max(1, Math.floor(MAX_ARRAY_CELLS / cols));
    }
    if (ctx.depth === 0) {
      const cost = cols * rows * (1 + this.blockCost(blk));
      if (cost > (this.opts.maxVisits ?? MAX_VISITS)) {
        this.report.errors.push(
          `Block reference "${name}" (${where(this.doc, r)}) would expand to about ${cost.toExponential(1)} entities through nested arrays — skipped.`,
        );
        this.skip(r, 'INSERT', 'expands to too many entities');
        return false;
      }
    }
    const ocs = this.extrusion();
    this.props(ET.OTHER, ctx);
    const rot = rotationXform(rotDeg);
    const head = compose(ocs, compose(Xform.translate(ix, iy, iz), rot));
    const tail = compose(
      Xform.scale(sx, sy, sz),
      blk.base[0] || blk.base[1] || blk.base[2]
        ? Xform.translate(-blk.base[0], -blk.base[1], -blk.base[2])
        : null,
    );
    // Cell (c, r) = head · T(c·colSpacing, r·rowSpacing) · tail: only the translation differs per cell.
    const first = compose(head, tail);
    const one = first ?? Xform.identity();
    const cellAt = (k: number): Xform | null => {
      if (k === 0) return first;
      const ox = (k % cols) * cs;
      const oy = Math.floor(k / cols) * rs;
      const dx = head ? head.vx(ox, oy, 0) : ox;
      const dy = head ? head.vy(ox, oy, 0) : oy;
      const dz = head ? head.vz(ox, oy, 0) : 0;
      return new Xform(
        one.m0,
        one.m1,
        one.m2,
        one.m3 + dx,
        one.m4,
        one.m5,
        one.m6,
        one.m7 + dy,
        one.m8,
        one.m9,
        one.m10,
        one.m11 + dz,
      );
    };
    return this.expandBlock(r, ctx, blk, cols * rows, cellAt, 'INSERT');
  }

  /** DIMENSION / ACAD_TABLE: render the anonymous block that holds the entity's graphics. */
  private blockGeometry(r: Rec, ctx: Ctx): boolean {
    this.load(r);
    const name = this.s(2, '').trim();
    const blk = name ? this.findBlock(name) : undefined;
    if (!blk) {
      this.skip(r, r.type, 'no geometry block (dimension/table graphics were not saved in the file)');
      return false;
    }
    const isTable = r.type === 'ACAD_TABLE';
    const ocs = isTable ? null : this.extrusion();
    let move: Xform | null = null;
    const px = this.n(isTable ? 10 : 12, 0);
    const py = this.n(isTable ? 20 : 22, 0);
    const pz = this.n(isTable ? 30 : 32, 0);
    if (px || py || pz) {
      const wx = ocs ? ocs.x(px, py, pz) : px;
      const wy = ocs ? ocs.y(px, py, pz) : py;
      const wz = ocs ? ocs.z(px, py, pz) : pz;
      move = Xform.translate(wx, wy, wz);
    }
    const base =
      blk.base[0] || blk.base[1] || blk.base[2]
        ? Xform.translate(-blk.base[0], -blk.base[1], -blk.base[2])
        : null;
    const cell = compose(move, compose(ocs, base));
    this.props(r.type === 'ACAD_TABLE' ? ET.OTHER : ET.DIMENSION, ctx);
    return this.expandBlock(r, ctx, blk, 1, () => cell, r.type);
  }
}

/** Rotation about Z by degrees, exact for multiples of 90°. */
function rotationXform(deg: number): Xform | null {
  if (!deg) return null;
  const q = deg / 90;
  if (Number.isInteger(q)) {
    const k = ((q % 4) + 4) % 4;
    const c = [1, 0, -1, 0][k];
    const s = [0, 1, 0, -1][k];
    return Xform.rotateZ(c, s);
  }
  return Xform.rotateZ(Math.cos(deg * DEG), Math.sin(deg * DEG));
}
