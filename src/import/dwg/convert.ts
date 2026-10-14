import type {
  Dwg3dFaceEntity,
  DwgArcEntity,
  DwgAttdefEntity,
  DwgAttribEntity,
  DwgBlockRecordTableEntry,
  DwgCircleEntity,
  DwgDatabase,
  DwgDimensionEntity,
  DwgEllipseEntity,
  DwgEntity,
  DwgHatchEntity,
  DwgInsertEntity,
  DwgLeaderEntity,
  DwgLineEntity,
  DwgLWPolylineEntity,
  DwgMTextEntity,
  DwgPointEntity,
  DwgPolyline2dEntity,
  DwgPolyline3dEntity,
  DwgSolidEntity,
  DwgSplineEntity,
  DwgTextBase,
  DwgTextEntity,
} from '@mlightcad/libredwg-web';

import { arcSegments } from '@/geometry/bulge';
import { TAU, normAngle } from '@/geometry/vec';
import { aciToRgb } from '@/underlay/aci';
import {
  ET,
  EntityStoreBuilder,
  FLAG,
  GK,
  emptyReport,
  storeExtents,
  type DrawingParseResult,
  type EntityMeta,
  type EntityTypeCode,
  type GeomKind,
  type ImportReport,
  type SourceLayer,
  fontIndex,
} from '@/underlay/entity-store';

import { BBox } from './bounds';
import { DwgReadError } from './errors';
import { flattenRings, generatePatternSegments, hatchGeometry, type HatchGeometry, type Ring } from './hatch';
import { tessellateSpline } from './spline';
import { decodeTextCodes, mtextToPlain } from './text';
import { dwgVersionInfo } from './version';
import { Xform, compose, ocsXform, unitNormal } from './xform';

/**
 * LibreDWG `DwgDatabase` → flattened {@link DrawingParseResult} (FDR rows 14, 22).
 *
 * Produces the same EntityStore semantics as the DXF importer (`src/import/dxf`):
 * - geometry in drawing units, projected onto the WCS XY plane; block references, dimensions and
 *   tables are flattened, their entities carry `FLAG.IN_BLOCK` and the index of the top-level
 *   reference in `store.inserts`;
 * - colours resolved (true colour / ACI / BYLAYER / BYBLOCK / layer "0" inheritance), ACI 7 stored
 *   as white; linetypes, lineweights (1/100 mm) and the effective linetype scale resolved;
 * - TEXT frames use the GK.TEXT conventions documented in `src/import/dxf/index.ts` (negative width
 *   factor = mirrored, boxWidth for aligned/fit text and MTEXT columns);
 * - pattern hatches give one GK.FILL with FLAG.PATTERN plus generated pattern lines (FLAG.DERIVED);
 * - `report.counts` counts the top-level entities of the layout by DXF type name (plus ATTRIBs of
 *   top-level INSERTs); `report.skipped` counts unsupported/invalid entities once per definition.
 *
 * DWG specifics: angles are radians; lineweights are raw DWG indices; LWPOLYLINE "closed" is flag
 * bit 512; angles of clockwise hatch edges are mirrored like in DXF.
 *
 * The input is never modified. This module has no runtime dependency on LibreDWG, so it can be
 * tested with hand-built databases.
 */
export interface DwgConvertOptions {
  /** Layout name; default (undefined or "Model") converts model space. */
  layout?: string;
  onProgress?: (fraction: number) => void;
  /** Format code from the file header (e.g. "AC1032"); becomes `result.version`. */
  version?: string;
  /** Overrides MAX_ENTITIES (tests). */
  maxEntities?: number;
  /** Overrides MAX_VISITS (tests). */
  maxVisits?: number;
}

/** Maximum nesting depth of block references. */
export const MAX_BLOCK_DEPTH = 32;
/** Maximum cells of a single INSERT array (MINSERT). */
export const MAX_ARRAY_CELLS = 10000;
/** Hard cap on flattened entities. */
export const MAX_ENTITIES = 5_000_000;
/** Hard cap on visited block-content entities (guards nested arrays of empty blocks). */
export const MAX_VISITS = 10_000_000;
/** Coordinates beyond this magnitude are treated as corrupt. */
const COORD_LIMIT = 1e15;

/** DWG lineweight index → 1/100 mm (indices 29/30/31 = BYLAYER/BYBLOCK/DEFAULT). */
const LINEWEIGHTS = [
  0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211,
];

/** Raw DWG lineweight → DXF semantics (-1 BYLAYER, -2 BYBLOCK, -3 default, ≥0 1/100 mm). */
export function dwgLineweight(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return -1;
  if (raw === -1 || raw === -2 || raw === -3) return raw;
  if (raw >= 0 && raw < LINEWEIGHTS.length && Number.isInteger(raw)) return LINEWEIGHTS[raw];
  if (raw === 29) return -1;
  if (raw === 30) return -2;
  return -3;
}

const SKIP_REASON: Record<string, string> = {
  RAY: 'infinite construction lines are not imported',
  XLINE: 'infinite construction lines are not imported',
  VIEWPORT: 'paper-space viewports are not rendered',
  IMAGE: 'raster images are not imported',
  WIPEOUT: 'wipeouts are not supported',
  MLINE: 'multilines are not supported',
  MULTILEADER: 'multileaders are not supported',
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
  ARCALIGNEDTEXT: 'arc-aligned text is not supported',
  SECTIONOBJECT: 'section objects are not supported',
  ACAD_TABLE: 'the table graphics could not be read from the DWG',
  HELIX: 'helices are not converted by the DWG reader',
  ARC_DIMENSION: 'arc-length dimensions are not converted by the DWG reader',
  LARGE_RADIAL_DIMENSION: 'jogged radius dimensions are not converted by the DWG reader',
  MINSERT: 'block arrays (MINSERT) could not be read from the DWG',
  LIGHT: 'lights are not rendered',
  CAMERA: 'cameras are not rendered',
  UNDERLAY: 'attached underlays (PDF/DWF/DGN) are not loaded',
  POINTCLOUD: 'point clouds are not supported',
  UNKNOWN: 'unknown or custom entities are not supported',
  '3DLINE': 'R10 3D lines are not converted by the DWG reader',
  'POLYLINE (polyface mesh)': 'polyface meshes are not supported',
  'POLYLINE (polygon mesh)': 'polygon meshes are not supported',
};

/** DXF type name used in reports. */
function reportName(type: string): string {
  return type === 'POLYLINE2D' || type === 'POLYLINE3D' ? 'POLYLINE' : type;
}

interface BlockDef {
  name: string;
  handle: string;
  flags: number;
  base: [number, number, number];
  ents: DwgEntity[];
}

interface Ctx {
  xf: Xform | null;
  byBlockColor: number;
  byBlockLt: number;
  byBlockLw: number;
  /** Layer that entities on layer "0" resolve to (-1 = layer "0" itself). */
  layer0: number;
  flags: number;
  insertIndex: number;
  depth: number;
  stack: string[];
}

interface LayoutInfo {
  name: string;
  ents: DwgEntity[];
}

class InvalidEntity extends Error {}
class LimitError extends Error {}

type P3 = { x?: number; y?: number; z?: number } | null | undefined;

const fin = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const px = (p: P3): number => fin(p?.x, NaN);
const py = (p: P3): number => fin(p?.y, NaN);
const pz = (p: P3): number => fin(p?.z, 0);

/** Layouts of a DWG database: "Model" first, then paper-space layouts in tab order. */
export function listDwgLayouts(db: DwgDatabase): string[] {
  return layoutInfos(db, indexBlocks(db)).map((l) => l.name);
}

function indexBlocks(db: DwgDatabase): { byName: Map<string, BlockDef>; byHandle: Map<string, BlockDef> } {
  const byName = new Map<string, BlockDef>();
  const byHandle = new Map<string, BlockDef>();
  for (const r of (db.tables?.BLOCK_RECORD?.entries ?? []) as DwgBlockRecordTableEntry[]) {
    const name = String(r.name ?? '').trim();
    const def: BlockDef = {
      name,
      handle: String(r.handle ?? '').toUpperCase(),
      flags: fin(r.flags, 0),
      base: [fin(r.basePoint?.x, 0), fin(r.basePoint?.y, 0), fin(r.basePoint?.z, 0)],
      ents: Array.isArray(r.entities) ? r.entities : [],
    };
    const key = name.toUpperCase();
    if (key && !byName.has(key)) byName.set(key, def);
    if (def.handle && !byHandle.has(def.handle)) byHandle.set(def.handle, def);
  }
  return { byName, byHandle };
}

function layoutInfos(
  db: DwgDatabase,
  blocks: { byName: Map<string, BlockDef>; byHandle: Map<string, BlockDef> },
): LayoutInfo[] {
  const model = blocks.byName.get('*MODEL_SPACE');
  const out: LayoutInfo[] = [
    { name: 'Model', ents: model ? model.ents : (db.entities ?? []).filter((e) => e.type !== 'ATTRIB') },
  ];
  const seen = new Set(['MODEL']);
  const layouts = [...(db.objects?.LAYOUT ?? [])].sort((a, b) => fin(a.tabOrder, 0) - fin(b.tabOrder, 0));
  for (const l of layouts) {
    const name = String(l.layoutName ?? '').trim();
    const key = name.toUpperCase();
    if (!name || seen.has(key)) continue;
    const blk = blocks.byHandle.get(String(l.paperSpaceTableId ?? '').toUpperCase());
    if (!blk || blk === model) continue;
    out.push({ name, ents: blk.ents });
    seen.add(key);
  }
  if (out.length === 1) {
    // No LAYOUT objects (pre-2000 files): "*Paper_Space" with content is "Layout1", further
    // "*Paper_SpaceN" blocks with content follow.
    const paper = blocks.byName.get('*PAPER_SPACE');
    if (paper?.ents.length) out.push({ name: 'Layout1', ents: paper.ents });
    const extra = [...blocks.byName.entries()]
      .map(([key, b]) => ({ n: /^\*PAPER_SPACE(\d+)$/.exec(key)?.[1], b }))
      .filter((x) => x.n !== undefined && x.b.ents.length > 0)
      .sort((a, b) => Number(a.n) - Number(b.n));
    for (const x of extra) out.push({ name: `Layout${out.length}`, ents: x.b.ents });
  }
  return out;
}

class Converter {
  private readonly layerIdx = new Map<string, number>();
  private readonly layerLt: number[] = [];
  private readonly ltIdx = new Map<string, number>();
  private readonly ltScale: number;
  private readonly preR2000: boolean;
  private readonly blocks: Map<string, BlockDef>;
  private readonly blocksByHandle: Map<string, BlockDef>;
  private readonly meta: EntityMeta = { type: ET.LINE, layer: 0, color: 0 };
  private readonly bb = new BBox();
  private readonly box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly skippedEnts = new WeakSet<object>();
  private readonly skipReasons = new Map<string, string>();
  private readonly invalidSamples: string[] = [];
  private invalidCount = 0;
  private readonly warned = new Set<string>();
  private readonly splineCache = new WeakMap<object, number[]>();
  private readonly hatchCache = new WeakMap<
    object,
    { g: HatchGeometry; segs: Float64Array | null; capped: boolean; tooDense: boolean }
  >();
  private readonly costMemo = new Map<string, number>();
  private emitted = 0;
  private visits = 0;
  private layer0Index = -1;

  constructor(
    private readonly db: DwgDatabase,
    private readonly b: EntityStoreBuilder,
    private readonly report: ImportReport,
    private readonly opts: DwgConvertOptions & { tick: (f: number) => void },
    blocks: { byName: Map<string, BlockDef>; byHandle: Map<string, BlockDef> },
  ) {
    const lts = db.header?.LTSCALE;
    this.ltScale = typeof lts === 'number' && lts > 0 && Number.isFinite(lts) ? lts : 1;
    this.preR2000 = opts.version ? dwgVersionInfo(opts.version).preR2000 : false;
    this.blocks = blocks.byName;
    this.blocksByHandle = blocks.byHandle;
    this.buildLinetypes();
    this.buildLayers();
    this.buildStyles();
  }

  // ------------------------------------------------------------------------------------------
  // Tables

  /** Text style name (upper case) → index into the store's font table (row 24). */
  private readonly styleFont = new Map<string, number>();
  private curFont = -1;

  private buildStyles() {
    for (const st of this.db.tables?.STYLE?.entries ?? []) {
      const name = String(st.name ?? '')
        .trim()
        .toUpperCase();
      if (!name || this.styleFont.has(name) || fin(st.standardFlag, 0) & 1) continue; // 1 = shape file
      const font = String(st.font || st.extendedFont || '').trim();
      this.styleFont.set(name, fontIndex(this.b, font || 'txt'));
    }
  }

  private fontOfStyle(style: string | undefined): number {
    const key = (style || 'STANDARD').trim().toUpperCase();
    return this.styleFont.get(key) ?? this.styleFont.get('STANDARD') ?? -1;
  }

  private buildLinetypes() {
    this.ltIdx.set('CONTINUOUS', 0);
    for (const lt of this.db.tables?.LTYPE?.entries ?? []) {
      const name = String(lt.name ?? '').trim();
      const key = name.toUpperCase();
      if (!name || key === 'BYLAYER' || key === 'BYBLOCK' || key === 'CONTINUOUS' || this.ltIdx.has(key))
        continue;
      const pattern: number[] = [];
      for (const el of lt.pattern ?? []) {
        const v = el?.elementLength;
        if (typeof v === 'number' && Number.isFinite(v)) pattern.push(v);
      }
      this.ltIdx.set(key, this.b.linetypes.length);
      this.b.linetypes.push({ name, pattern });
    }
  }

  private buildLayers() {
    for (const l of this.db.tables?.LAYER?.entries ?? []) {
      const name = String(l.name ?? '').trim();
      if (!name || this.layerIdx.has(name.toUpperCase())) continue;
      const aci = fin(l.colorIndex, 7);
      const tc = fin(l.color, 0xffffff);
      const lw = this.preR2000 ? -3 : dwgLineweight(l.lineweight);
      this.addLayer({
        name,
        color: Math.abs(aci) >= 1 && Math.abs(aci) <= 255 ? aciToRgb(Math.abs(aci)) : tc & 0xffffff,
        linetype: String(l.lineType ?? '').trim() || 'CONTINUOUS',
        lineweight: lw >= 0 ? lw : -3,
        off: !!l.off || aci < 0,
        frozen: !!l.frozen,
        // R14 and earlier store no plot flag; "Defpoints" never plots.
        plot: (this.preR2000 || l.plotFlag !== 0) && name.toUpperCase() !== 'DEFPOINTS',
      });
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
    this.layer0Index = this.layerIdx.get('0') ?? -1;
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

  private layerOf(name: unknown): number {
    const s = typeof name === 'string' ? name.trim() : '';
    const idx = this.layerIdx.get(s.toUpperCase() || '0');
    if (idx !== undefined) return idx;
    return this.addLayer({
      name: s || '0',
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

  /** Resolves layer, colour, linetype, lineweight, linetype scale and flags of an entity. */
  private props(e: DwgEntity, type: EntityTypeCode, ctx: Ctx): EntityMeta {
    const m = this.meta;
    m.type = type;
    let layer = this.layerOf(e.layer);
    if (ctx.layer0 >= 0 && layer === this.layer0Index) layer = ctx.layer0;
    m.layer = layer;
    const L = this.b.layers[layer];
    if (typeof e.color === 'number' && Number.isFinite(e.color) && e.color >= 0) {
      m.color = e.color & 0xffffff;
    } else {
      const aci = Math.abs(fin(e.colorIndex, 256));
      m.color = aci === 0 ? ctx.byBlockColor : aci >= 256 ? L.color : aciToRgb(aci);
    }
    const ltName = typeof e.lineType === 'string' ? e.lineType.trim() : '';
    const key = ltName.toUpperCase();
    if (!ltName || key === 'BYLAYER') m.linetype = this.layerLt[layer];
    else if (key === 'BYBLOCK') m.linetype = ctx.byBlockLt;
    else {
      let lt = this.ltIdx.get(key);
      if (lt === undefined) {
        this.warnOnce(`lt:${key}`, `Linetype "${ltName}" is not defined — drawn continuous.`);
        lt = 0;
      }
      m.linetype = lt;
    }
    const lw = this.preR2000 ? -1 : dwgLineweight(e.lineweight);
    m.lineweight = lw === -1 ? L.lineweight : lw === -2 ? ctx.byBlockLw : lw < 0 ? -3 : lw;
    const els = fin(e.lineTypeScale, 1);
    m.ltscale = this.ltScale * (els > 0 ? els : 1) * (ctx.xf ? ctx.xf.scale || 1 : 1);
    m.flags = ctx.flags | (e.isVisible === false ? FLAG.HIDDEN : 0);
    m.handle = typeof e.handle === 'string' ? e.handle : '';
    m.insertIndex = ctx.insertIndex;
    return m;
  }

  private visit() {
    if ((++this.visits & 4095) === 0 && this.visits > (this.opts.maxVisits ?? MAX_VISITS))
      throw new LimitError();
  }

  private add(kind: GeomKind, values: ArrayLike<number>, bb: BBox, text?: string) {
    if (!(
      Math.abs(bb.minX) < COORD_LIMIT &&
      Math.abs(bb.minY) < COORD_LIMIT &&
      Math.abs(bb.maxX) < COORD_LIMIT &&
      Math.abs(bb.maxY) < COORD_LIMIT
    )) {
      throw new InvalidEntity('invalid or out-of-range coordinates');
    }
    for (let i = 0; i < values.length; i++)
      if (!Number.isFinite(values[i])) throw new InvalidEntity('invalid geometry values');
    const box = this.box;
    box.minX = bb.minX;
    box.minY = bb.minY;
    box.maxX = bb.maxX;
    box.maxY = bb.maxY;
    this.b.add(this.meta, kind, values, box, text);
    if ((++this.emitted & 4095) === 0 && this.b.count > (this.opts.maxEntities ?? MAX_ENTITIES))
      throw new LimitError();
  }

  private skip(e: object, name: string, reason: string) {
    if (this.skippedEnts.has(e)) return;
    this.skippedEnts.add(e);
    this.report.skipped[name] = (this.report.skipped[name] ?? 0) + 1;
    if (!this.skipReasons.has(name)) this.skipReasons.set(name, reason);
  }

  private invalid(e: DwgEntity, type: string, msg: string) {
    if (this.skippedEnts.has(e)) return;
    this.skip(e, type, 'invalid data');
    this.invalidCount++;
    if (this.invalidSamples.length < 20) this.invalidSamples.push(`${type} ${e.handle || '?'}: ${msg}`);
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

  run(ents: DwgEntity[]) {
    const ctx = this.rootCtx();
    const counts = this.report.counts;
    const n = ents.length;
    const step = Math.max(1, Math.floor(n / 100));
    let limitHit = false;
    for (let i = 0; i < n; i++) {
      if (i % step === 0) this.opts.tick(i / n);
      const e = ents[i];
      if (!e || typeof e !== 'object') continue;
      try {
        if (this.entity(e, ctx)) {
          const name = reportName(String(e.type));
          counts[name] = (counts[name] ?? 0) + 1;
          if (e.type === 'INSERT') {
            const na = (e as DwgInsertEntity).attribs?.length ?? 0;
            if (na) counts.ATTRIB = (counts.ATTRIB ?? 0) + na;
          }
        }
      } catch (err) {
        if (err instanceof LimitError) {
          limitHit = true;
          break;
        }
        throw err;
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

  /** Converts one entity (and its children). Returns false when it was skipped. */
  private entity(e: DwgEntity, ctx: Ctx): boolean {
    this.visit();
    const type = String(e.type ?? 'UNKNOWN');
    try {
      switch (type) {
        case 'LINE':
          this.line(e as DwgLineEntity, ctx);
          return true;
        case 'POINT':
          this.point(e as DwgPointEntity, ctx);
          return true;
        case 'CIRCLE':
        case 'ARC':
          this.circleArc(e as DwgCircleEntity | DwgArcEntity, ctx, type === 'ARC');
          return true;
        case 'ELLIPSE':
          this.ellipse(e as DwgEllipseEntity, ctx);
          return true;
        case 'LWPOLYLINE':
          this.lwpolyline(e as DwgLWPolylineEntity, ctx);
          return true;
        case 'POLYLINE2D':
          return this.polyline2d(e as DwgPolyline2dEntity, ctx);
        case 'POLYLINE3D':
          this.polyline3d(e as DwgPolyline3dEntity, ctx);
          return true;
        case 'SPLINE':
          this.spline(e as DwgSplineEntity, ctx);
          return true;
        case 'SOLID':
        case 'TRACE':
          this.solid(e as DwgSolidEntity, ctx, type === 'SOLID' ? ET.SOLID : ET.TRACE);
          return true;
        case '3DFACE':
          this.face3d(e as Dwg3dFaceEntity, ctx);
          return true;
        case 'HATCH':
          this.hatch(e as DwgHatchEntity, ctx);
          return true;
        case 'TEXT':
          this.text(e, ctx, 'TEXT');
          return true;
        case 'ATTDEF':
          // Attribute definitions inside blocks are templates and are not displayed.
          if (ctx.depth > 0) return false;
          this.text(e, ctx, 'ATTDEF');
          return true;
        case 'ATTRIB':
          this.text(e, ctx, 'ATTRIB');
          return true;
        case 'MTEXT':
          this.mtext(e as DwgMTextEntity, ctx, ET.MTEXT);
          return true;
        case 'INSERT':
          return this.insert(e as DwgInsertEntity, ctx);
        case 'DIMENSION':
          return this.dimension(e as DwgDimensionEntity, ctx);
        case 'ACAD_TABLE':
          return this.table(e, ctx);
        case 'LEADER':
          this.leader(e as DwgLeaderEntity, ctx);
          return true;
        default:
          this.skip(e, type, SKIP_REASON[type] ?? 'entity type not supported');
          return false;
      }
    } catch (err) {
      if (err instanceof InvalidEntity || err instanceof RangeError || err instanceof TypeError) {
        this.invalid(e, reportName(type), (err as Error).message);
        return false;
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Simple entities

  private line(e: DwgLineEntity, ctx: Ctx) {
    this.props(e, ET.LINE, ctx);
    let x1 = px(e.startPoint);
    let y1 = py(e.startPoint);
    let x2 = px(e.endPoint);
    let y2 = py(e.endPoint);
    const xf = ctx.xf;
    if (xf) {
      const z1 = pz(e.startPoint);
      const z2 = pz(e.endPoint);
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

  private point(e: DwgPointEntity, ctx: Ctx) {
    this.props(e, ET.POINT, ctx);
    let x = px(e.position);
    let y = py(e.position);
    if (ctx.xf) {
      const z = pz(e.position);
      const a = ctx.xf.x(x, y, z);
      y = ctx.xf.y(x, y, z);
      x = a;
    }
    const bb = this.bb.reset();
    bb.add(x, y);
    this.add(GK.POINT, [x, y], bb);
  }

  private circleArc(e: DwgCircleEntity | DwgArcEntity, ctx: Ctx, isArc: boolean) {
    this.props(e, isArc ? ET.ARC : ET.CIRCLE, ctx);
    const cx = px(e.center);
    const cy = py(e.center);
    const cz = pz(e.center);
    const r = fin(e.radius, NaN);
    if (!(r > 0)) throw new InvalidEntity('radius must be positive');
    const t0 = isArc ? fin((e as DwgArcEntity).startAngle, 0) : 0;
    const t1 = isArc ? fin((e as DwgArcEntity).endAngle, TAU) : TAU;
    const xf = compose(ctx.xf, ocsXform(e.extrusionDirection));
    if (!xf) {
      const bb = this.bb.reset();
      if (!isArc) {
        bb.add(cx - r, cy - r);
        bb.add(cx + r, cy + r);
        this.add(GK.CIRCLE, [cx, cy, r], bb);
      } else {
        const a0 = normAngle(t0);
        const a1 = normAngle(t1);
        bb.addArc(cx, cy, r, a0, a1);
        this.add(GK.ARC, [cx, cy, r, a0, a1], bb);
      }
      return;
    }
    this.conic(xf, cx, cy, cz, r, 0, 0, 0, r, 0, t0, t1, !isArc, false);
  }

  private ellipse(e: DwgEllipseEntity, ctx: Ctx) {
    this.props(e, ET.ELLIPSE, ctx);
    const cx = px(e.center);
    const cy = py(e.center);
    const cz = pz(e.center);
    const mx = px(e.majorAxisEndPoint);
    const my = py(e.majorAxisEndPoint);
    const mz = pz(e.majorAxisEndPoint);
    let ratio = fin(e.axisRatio, 1);
    if (!(ratio > 0)) throw new InvalidEntity('axis ratio must be positive');
    if (ratio > 1) ratio = 1;
    const t0 = fin(e.startAngle, 0);
    const t1 = fin(e.endAngle, TAU);
    const [nx, ny, nz] = unitNormal(e.extrusionDirection);
    const full = Math.abs(t1 - t0) >= TAU - 1e-10 || (t0 === 0 && t1 === 0);
    if (!ctx.xf && Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) {
      if (!(Math.hypot(mx, my) > 0)) throw new InvalidEntity('zero-length major axis');
      const p1 = full ? t0 + TAU : t1;
      const bb = this.bb.reset();
      bb.addEllipse(cx, cy, mx, my, ratio, t0, p1 > t0 ? p1 : p1 + TAU);
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
   * Emits the projection of c + u·cos t + v·sin t, t ∈ [t0, t1], as a circle/arc when it stays
   * circular, otherwise as an ellipse; mirrored frames are reversed so curves stay CCW.
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
    if (Ux * Vy - Uy * Vx < 0) {
      Vx = -Vx;
      Vy = -Vy;
      const a = -t1;
      t1 = -t0;
      t0 = a;
    }
    const lu = Math.hypot(Ux, Uy);
    const lv = Math.hypot(Vx, Vy);
    if (!(lu > 0 || lv > 0)) throw new InvalidEntity('degenerate curve');
    const dot = Ux * Vx + Uy * Vy;
    const lmax = Math.max(lu, lv);
    const circular = Math.abs(lu - lv) <= 1e-9 * lmax && Math.abs(dot) <= 1e-9 * lu * lv;
    const bb = this.bb.reset();
    if (circular && !preferEllipse) {
      if (full) {
        bb.add(Cx - lu, Cy - lu);
        bb.add(Cx + lu, Cy + lu);
        this.add(GK.CIRCLE, [Cx, Cy, lu], bb);
      } else {
        const base = Math.atan2(Uy, Ux);
        const a0 = normAngle(base + t0);
        const a1 = normAngle(base + t1);
        bb.addArc(Cx, Cy, lu, a0, a1);
        this.add(GK.ARC, [Cx, Cy, lu, a0, a1], bb);
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
    if (!(lm > 0)) throw new InvalidEntity('degenerate ellipse');
    const ratio = Math.min(1, Math.hypot(Nx, Ny) / lm);
    const p0 = t0 - theta;
    const p1 = full ? p0 + TAU : t1 - theta;
    bb.addEllipse(Cx, Cy, Mx, My, ratio, p0, p1 > p0 ? p1 : p1 + TAU);
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
      if (!b || i >= segs) continue;
      const j = (i + 1) % n;
      const x1 = v[j * 3];
      const y1 = v[j * 3 + 1];
      const chord = Math.hypot(x1 - x0, y1 - y0);
      if (chord === 0) continue;
      const theta = 4 * Math.atan(b);
      const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
      const h = (chord / 2) * ((1 - b * b) / (2 * b));
      const ux = (x1 - x0) / chord;
      const uy = (y1 - y0) / chord;
      const cx = (x0 + x1) / 2 - uy * h;
      const cy = (y0 + y1) / 2 + ux * h;
      const a0 = Math.atan2(y0 - cy, x0 - cx);
      const k = Math.min(512, arcSegments(r, theta, r * 1e-3));
      for (let q = 1; q < k; q++) {
        const a = a0 + (theta * q) / k;
        const qx = cx + r * Math.cos(a);
        const qy = cy + r * Math.sin(a);
        out.push(xf.x(qx, qy, z), xf.y(qx, qy, z), 0);
      }
    }
    return out;
  }

  private polyBounds(v: number[], closed: boolean, bb: BBox) {
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
    const values = new Array<number>(1 + verts.length);
    values[0] = verts.length / 3;
    for (let i = 0; i < verts.length; i++) values[i + 1] = verts[i];
    const bb = this.bb.reset();
    this.polyBounds(verts, closed, bb);
    if (closed) this.meta.flags = (this.meta.flags ?? 0) | FLAG.CLOSED;
    this.add(GK.POLY, values, bb);
  }

  private lwpolyline(e: DwgLWPolylineEntity, ctx: Ctx) {
    const verts: number[] = [];
    for (const v of e.vertices ?? []) verts.push(fin(v.x, NaN), fin(v.y, NaN), fin(v.bulge, 0));
    if (verts.length < 6) throw new InvalidEntity('fewer than 2 vertices');
    this.props(e, ET.LWPOLYLINE, ctx);
    // DWG LWPOLYLINE flag bit 512 = closed (DXF 70 bit 1).
    const closed = (fin(e.flag, 0) & 512) !== 0;
    const xf = compose(ctx.xf, ocsXform(e.extrusionDirection));
    this.emitPoly(this.transformVerts(verts, fin(e.elevation, 0), xf, closed), closed);
  }

  private polyline2d(e: DwgPolyline2dEntity, ctx: Ctx): boolean {
    const flags = fin(e.flag, 0);
    if (flags & 64) {
      this.skip(e, 'POLYLINE (polyface mesh)', SKIP_REASON['POLYLINE (polyface mesh)']);
      return false;
    }
    if (flags & 16) {
      this.skip(e, 'POLYLINE (polygon mesh)', SKIP_REASON['POLYLINE (polygon mesh)']);
      return false;
    }
    const closed = (flags & 1) === 1;
    const verts: number[] = [];
    for (const v of e.vertices ?? []) {
      if (fin(v.flag, 0) & 16) continue; // spline frame control point (not displayed)
      verts.push(fin(v.x, NaN), fin(v.y, NaN), fin(v.bulge, 0));
    }
    if (verts.length < 6) throw new InvalidEntity('fewer than 2 vertices');
    this.props(e, ET.POLYLINE, ctx);
    const xf = compose(ctx.xf, ocsXform(e.extrusionDirection));
    this.emitPoly(this.transformVerts(verts, fin(e.elevation, 0), xf, closed), closed);
    return true;
  }

  private polyline3d(e: DwgPolyline3dEntity, ctx: Ctx) {
    const xf = ctx.xf;
    const verts: number[] = [];
    for (const v of e.vertices ?? []) {
      if (fin(v.flag, 0) & 16) continue;
      const x = fin(v.x, NaN);
      const y = fin(v.y, NaN);
      const z = fin(v.z, 0);
      verts.push(xf ? xf.x(x, y, z) : x, xf ? xf.y(x, y, z) : y, 0);
    }
    if (verts.length < 6) throw new InvalidEntity('fewer than 2 vertices');
    this.props(e, ET.POLYLINE, ctx);
    this.emitPoly(verts, (fin(e.flag, 0) & 1) === 1);
  }

  private spline(e: DwgSplineEntity, ctx: Ctx) {
    this.props(e, ET.SPLINE, ctx);
    let pts = this.splineCache.get(e);
    if (!pts) {
      const ctrl: number[] = [];
      for (const p of e.controlPoints ?? []) ctrl.push(px(p), py(p), pz(p));
      const fit: number[] = [];
      for (const p of e.fitPoints ?? []) fit.push(px(p), py(p), pz(p));
      const tan = (t: P3): [number, number, number] | null => {
        if (!t) return null;
        const v: [number, number, number] = [fin(t.x, 0), fin(t.y, 0), fin(t.z, 0)];
        return Math.hypot(v[0], v[1], v[2]) > 0 ? v : null;
      };
      const weights = Array.isArray(e.weights) && e.weights.length === ctrl.length / 3 ? e.weights : null;
      pts = tessellateSpline(
        {
          degree: fin(e.degree, 3),
          knots: Array.isArray(e.knots) ? e.knots : [],
          ctrl,
          weights,
          fit,
          startTangent: tan(e.startTangent),
          endTangent: tan(e.endTangent),
          closed: false,
        },
        (m) => this.warnOnce(`spline:${m}`, m),
      );
      this.splineCache.set(e, pts);
    }
    const n = pts.length / 3;
    if (n < 2) throw new InvalidEntity('spline has no control or fit points');
    const xf = ctx.xf;
    const verts: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      const z = pts[i * 3 + 2];
      verts.push(xf ? xf.x(x, y, z) : x, xf ? xf.y(x, y, z) : y, 0);
    }
    let closed = false;
    const last = verts.length - 3;
    if (
      verts.length > 6 &&
      Math.hypot(verts[0] - verts[last], verts[1] - verts[last + 1]) <=
        1e-12 * (1 + Math.abs(verts[0]) + Math.abs(verts[1]))
    ) {
      verts.length = last;
      closed = true;
    }
    this.emitPoly(verts, closed);
  }

  private leader(e: DwgLeaderEntity, ctx: Ctx) {
    this.props(e, ET.LEADER, ctx);
    const xf = ctx.xf;
    const verts: number[] = [];
    for (const v of e.vertices ?? []) {
      const x = px(v);
      const y = py(v);
      const z = pz(v);
      verts.push(xf ? xf.x(x, y, z) : x, xf ? xf.y(x, y, z) : y, 0);
    }
    if (verts.length < 6) throw new InvalidEntity('fewer than 2 vertices');
    this.emitPoly(verts, false);
  }

  // ------------------------------------------------------------------------------------------
  // Filled entities

  private emitFill(rings: number[][]) {
    const values: number[] = [rings.length];
    const bb = this.bb.reset();
    for (const ring of rings) {
      values.push(ring.length / 3);
      for (let i = 0; i < ring.length; i++) values.push(ring[i]);
      this.polyBounds(ring, true, bb);
    }
    this.add(GK.FILL, values, bb);
  }

  private solid(e: DwgSolidEntity, ctx: Ctx, type: EntityTypeCode) {
    this.props(e, type, ctx);
    const c1 = e.corner1;
    const c2 = e.corner2;
    const c3 = e.corner3;
    const c4 = e.corner4 ?? e.corner3;
    // DWG/DXF vertex order 1, 2, 4, 3.
    const ring: number[] = [px(c1), py(c1), 0, px(c2), py(c2), 0, px(c4), py(c4), 0];
    if (px(c4) !== px(c3) || py(c4) !== py(c3)) ring.push(px(c3), py(c3), 0);
    const xf = compose(ctx.xf, ocsXform(e.extrusionDirection));
    this.emitFill([this.transformVerts(ring, 0, xf, true)]);
  }

  private face3d(e: Dwg3dFaceEntity, ctx: Ctx) {
    this.props(e, ET.FACE3D, ctx);
    const xf = ctx.xf;
    const corners = [e.corner1, e.corner2, e.corner3, e.corner4 ?? e.corner3];
    const pts: number[] = [];
    for (const c of corners) {
      const x = px(c);
      const y = py(c);
      const z = pz(c);
      pts.push(xf ? xf.x(x, y, z) : x, xf ? xf.y(x, y, z) : y, 0);
    }
    if (pts[9] === pts[6] && pts[10] === pts[7]) pts.length = 9;
    this.emitPoly(pts, true);
  }

  private hatch(e: DwgHatchEntity, ctx: Ctx) {
    this.props(e, ET.HATCH, ctx);
    const meta = { ...this.meta };
    let cached = this.hatchCache.get(e);
    if (!cached) {
      cached = {
        g: hatchGeometry(e, (m) => this.warnOnce(`hatch:${m}`, m)),
        segs: null,
        capped: false,
        tooDense: false,
      };
      this.hatchCache.set(e, cached);
    }
    const h = cached.g;
    if (!h.rings.length) throw new InvalidEntity('hatch has no usable boundary');
    const xf = compose(ctx.xf, ocsXform(e.extrusionDirection));
    const pattern = !h.solid;
    Object.assign(this.meta, meta);
    this.meta.flags = (meta.flags ?? 0) | (pattern ? FLAG.PATTERN : 0);
    this.emitFill(h.rings.map((ring: Ring) => this.transformVerts(ring, 0, xf, true)));
    if (!pattern) return;
    if (!h.lines.length) {
      this.warnOnce(
        'hatch:nolines',
        'Some pattern hatches carry no pattern definition in the DWG — only their outlines are shown.',
      );
      return;
    }
    if (!cached.segs) {
      let size = 0;
      for (const ring of h.rings) {
        for (let i = 0; i < ring.length; i += 3)
          size = Math.max(size, Math.abs(ring[i] - h.rings[0][0]), Math.abs(ring[i + 1] - h.rings[0][1]));
      }
      const res = generatePatternSegments(flattenRings(h.rings, Math.max(size * 1e-4, 1e-9)), h.lines);
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
    Object.assign(this.meta, meta);
    this.meta.flags = (meta.flags ?? 0) | FLAG.DERIVED;
    const bb = this.bb;
    for (let i = 0; i < segs.length; i += 4) {
      let x1 = segs[i];
      let y1 = segs[i + 1];
      let x2 = segs[i + 2];
      let y2 = segs[i + 3];
      if (xf) {
        const a = xf.x(x1, y1, 0);
        y1 = xf.y(x1, y1, 0);
        x1 = a;
        const c = xf.x(x2, y2, 0);
        y2 = xf.y(x2, y2, 0);
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
   * Emits a GK.TEXT entity from an anchor and two local vectors (u = text direction, v = glyph "up"
   * incl. oblique slant), both mapped through `xf` and decomposed into rotation / height / width
   * factor / oblique. A mirrored frame yields a negative width factor.
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
    const cr = Ux * Vy - Uy * Vx;
    let rotation: number;
    let h: number;
    let w: number;
    let oblique: number;
    if (plain && !xf) {
      rotation = plain.rotation;
      h = height;
      w = wf;
      oblique = plain.oblique;
    } else if (!(lu > 1e-12) || !(Math.abs(cr) > 1e-12 * lu)) {
      rotation = lu > 1e-12 ? Math.atan2(Uy, Ux) : 0;
      h = height;
      w = wf;
      oblique = 0;
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
      [X, Y, h, rotation, w, hAlign, vAlign, oblique, bw, isMText ? lineSpacing : 1, this.curFont],
      bb,
      text,
    );
  }

  /** TEXT, ATTRIB (from an INSERT) and top-level ATTDEF (shows its tag). */
  private text(e: DwgEntity, ctx: Ctx, kind: 'TEXT' | 'ATTRIB' | 'ATTDEF') {
    const t: DwgTextBase | undefined =
      kind === 'TEXT' ? (e as DwgTextEntity) : (e as DwgAttribEntity | DwgAttdefEntity).text;
    if (!t) throw new InvalidEntity('missing text data');
    this.props(e, kind === 'ATTRIB' ? ET.ATTRIB : ET.TEXT, ctx);
    this.curFont = this.fontOfStyle((t as { styleName?: string }).styleName);
    const attrFlags = kind === 'TEXT' ? 0 : fin((e as DwgAttribEntity).flags, 0);
    if (kind === 'ATTRIB' && attrFlags & 1) this.meta.flags = (this.meta.flags ?? 0) | FLAG.HIDDEN;
    // Multi-line attributes carry an embedded MTEXT frame.
    const mtextFlag = kind === 'TEXT' ? 0 : fin((e as DwgAttribEntity).mtextFlag, 0);
    const embedded = (e as DwgAttribEntity).mtext;
    if (kind === 'ATTRIB' && mtextFlag & 2 && embedded?.insertionPoint) {
      this.mtextFrame(
        mtextToPlain(String(t.text ?? '')),
        ctx.xf,
        embedded.insertionPoint,
        embedded.direction,
        (e as { extrusionDirection?: P3 }).extrusionDirection ?? t.extrusionDirection,
        fin(t.textHeight, 1),
        fin(embedded.attachmentPoint, 1),
        fin(embedded.rectWidth, 0),
        1,
      );
      return;
    }
    const raw = kind === 'ATTDEF' ? (e as DwgAttdefEntity).tag : t.text;
    const text = decodeTextCodes(String(raw ?? ''));
    let height = fin(t.textHeight, 1);
    if (!(height > 0)) height = 1;
    const rot = fin(t.rotation, 0);
    let wf = fin(t.xScale, 1);
    if (wf === 0) wf = 1;
    const obl = fin(t.obliqueAngle, 0);
    const gen = fin(t.generationFlag, 0);
    const h72 = fin(t.halign, 0);
    const v7x = fin(t.valign, 0);
    const x10 = px(t.startPoint);
    const y10 = py(t.startPoint);
    const x11 = fin(t.endPoint?.x, x10);
    const y11 = fin(t.endPoint?.y, y10);
    let ax = x10;
    let ay = y10;
    let hAlign = 0;
    let vAlign = 0;
    let boxWidth = 0;
    let dir = rot;
    if (h72 === 3 || h72 === 5) {
      // Aligned / fit: the text spans the baseline from the first to the second alignment point.
      if (x11 !== x10 || y11 !== y10) {
        dir = Math.atan2(y11 - y10, x11 - x10);
        boxWidth = Math.hypot(x11 - x10, y11 - y10);
      }
    } else {
      hAlign = h72 === 1 || h72 === 4 ? 1 : h72 === 2 ? 2 : 0;
      vAlign = h72 === 4 ? 2 : v7x >= 0 && v7x <= 3 ? v7x : 0;
      if (hAlign !== 0 || vAlign !== 0) {
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
    const tn = Math.tan(obl);
    vx += tn * ux;
    vy += tn * uy;
    const xf = compose(
      ctx.xf,
      ocsXform((e as { extrusionDirection?: P3 }).extrusionDirection ?? t.extrusionDirection),
    );
    const plain = gen & 6 ? null : { rotation: normAngle(dir), oblique: obl };
    this.emitText(
      text,
      xf,
      ax,
      ay,
      0,
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

  private mtext(e: DwgMTextEntity, ctx: Ctx, type: EntityTypeCode) {
    this.props(e, type, ctx);
    this.curFont = this.fontOfStyle(e.styleName);
    const ls = fin(e.lineSpacing, 1);
    this.mtextFrame(
      mtextToPlain(String(e.text ?? '')),
      ctx.xf,
      e.insertionPoint,
      e.direction,
      e.extrusionDirection,
      fin(e.textHeight, 1),
      fin(e.attachmentPoint, 1),
      Math.max(0, fin(e.rectWidth, 0)),
      ls > 0 ? ls : 1,
      fin(e.rotation, 0),
    );
  }

  private mtextFrame(
    text: string,
    xf: Xform | null,
    ins: P3,
    direction: P3,
    extrusion: P3,
    textHeight: number,
    ap: number,
    rectWidth: number,
    lineSpacing: number,
    rotation = 0,
  ) {
    const height = textHeight > 0 ? textHeight : 1;
    const hAlign = ap >= 1 && ap <= 9 ? (ap - 1) % 3 : 0;
    const row = ap >= 1 && ap <= 9 ? Math.floor((ap - 1) / 3) : 0;
    const vAlign = row === 0 ? 3 : row === 1 ? 2 : 1;
    const [nx, ny, nz] = unitNormal(extrusion);
    let ux = fin(direction?.x, 0);
    let uy = fin(direction?.y, 0);
    let uz = fin(direction?.z, 0);
    if (!(Math.hypot(ux, uy, uz) > 0)) {
      const ocs = ocsXform(extrusion);
      const c = rotation === 0 ? 1 : Math.cos(rotation);
      const s = rotation === 0 ? 0 : Math.sin(rotation);
      if (ocs) {
        ux = ocs.vx(c, s, 0);
        uy = ocs.vy(c, s, 0);
        uz = ocs.vz(c, s, 0);
      } else {
        ux = c;
        uy = s;
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
      xf,
      px(ins),
      py(ins),
      pz(ins),
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
      rectWidth,
      lineSpacing,
      true,
    );
  }

  // ------------------------------------------------------------------------------------------
  // Block references

  private findBlock(name: unknown): BlockDef | undefined {
    return typeof name === 'string' ? this.blocks.get(name.trim().toUpperCase()) : undefined;
  }

  /** Upper estimate of the entities visited when flattening one reference to `blk`. */
  private blockCost(blk: BlockDef): number {
    const key = blk.name.toUpperCase();
    const memo = this.costMemo.get(key);
    if (memo !== undefined) return memo;
    this.costMemo.set(key, 0); // in progress: cycles contribute nothing
    let cost = 0;
    for (const e of blk.ents) {
      cost += 1;
      let child: BlockDef | undefined;
      let cells = 1;
      if (e.type === 'INSERT') {
        const ins = e as DwgInsertEntity;
        child = this.findBlock(ins.name);
        cells = Math.min(
          MAX_ARRAY_CELLS,
          Math.max(1, Math.floor(fin(ins.columnCount, 1))) * Math.max(1, Math.floor(fin(ins.rowCount, 1))),
        );
        cost += ins.attribs?.length ?? 0;
      } else if (e.type === 'DIMENSION') {
        child = this.findBlock((e as DwgDimensionEntity).name);
      }
      if (!child) continue;
      cost += cells * (1 + this.blockCost(child));
      if (cost > 1e15) break;
    }
    cost = Math.min(cost, 1e15);
    this.costMemo.set(key, cost);
    return cost;
  }

  /** Emits block content once per cell (`cellAt(k)` = block → parent transform); false when skipped. */
  private expandBlock(
    e: DwgEntity,
    ctx: Ctx,
    blk: BlockDef,
    cells: number,
    cellAt: (k: number) => Xform | null,
    kind: string,
    attribs: DwgAttribEntity[],
  ): boolean {
    const key = blk.name.toUpperCase();
    if (ctx.stack.includes(key)) {
      this.warnOnce(
        `cycle:${key}`,
        `Block "${blk.name}" references itself (directly or through nested blocks); the recursive reference was skipped.`,
      );
      this.skip(e, kind, 'recursive block reference');
      return false;
    }
    if (ctx.depth >= MAX_BLOCK_DEPTH) {
      this.warnOnce(
        `depth:${key}`,
        `Block nesting deeper than ${MAX_BLOCK_DEPTH} levels at "${blk.name}" — deeper levels were skipped.`,
      );
      this.skip(e, kind, 'block nesting too deep');
      return false;
    }
    const m = this.meta;
    let insertIndex = ctx.insertIndex;
    if (ctx.depth === 0) {
      insertIndex = this.b.inserts.length;
      this.b.inserts.push({ name: blk.name, handle: m.handle ?? '', type: kind });
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
    // Attributes are stored in the coordinate system of the reference's container, not the block.
    const attrCtx: Ctx = { ...base, xf: ctx.xf, stack: ctx.stack };
    for (let k = 0; k < cells; k++) {
      this.visit();
      const child: Ctx = { ...base, xf: compose(ctx.xf, cellAt(k)) };
      for (const c of blk.ents) if (c && typeof c === 'object') this.entity(c, child);
    }
    for (const a of attribs) {
      if (!a || typeof a !== 'object') continue;
      try {
        this.text(a, attrCtx, 'ATTRIB');
      } catch (err) {
        if (err instanceof InvalidEntity || err instanceof RangeError || err instanceof TypeError) {
          this.invalid(a, 'ATTRIB', (err as Error).message);
        } else throw err;
      }
    }
    return true;
  }

  private insert(e: DwgInsertEntity, ctx: Ctx): boolean {
    const name = String(e.name ?? '').trim();
    const blk = this.findBlock(name);
    if (!blk) {
      this.warnOnce(
        `noblock:${name.toUpperCase()}`,
        name
          ? `Block "${name}" is not defined — its references were skipped.`
          : 'Block references whose block the DWG reader could not identify were skipped.',
      );
      this.skip(e, 'INSERT', 'block definition missing');
      return false;
    }
    if (blk.flags & 4 && blk.ents.length === 0) {
      this.warnOnce(`xref:${name.toUpperCase()}`, `External reference "${name}" is not loaded.`);
      this.skip(e, 'INSERT (xref)', 'external references are not loaded');
      return false;
    }
    let sx = fin(e.xScale, 1);
    let sy = fin(e.yScale, 1);
    let sz = fin(e.zScale, 1);
    if (sx === 0) sx = 1;
    if (sy === 0) sy = 1;
    if (sz === 0) sz = 1;
    const rot = fin(e.rotation, 0);
    const ix = fin(e.insertionPoint?.x, NaN);
    const iy = fin(e.insertionPoint?.y, NaN);
    const iz = fin(e.insertionPoint?.z, 0);
    let cols = Math.max(1, Math.floor(fin(e.columnCount, 1)));
    let rows = Math.max(1, Math.floor(fin(e.rowCount, 1)));
    const cs = fin(e.columnSpacing, 0);
    const rs = fin(e.rowSpacing, 0);
    if (!Number.isFinite(ix + iy)) throw new InvalidEntity('invalid insertion point');
    if (cols * rows > MAX_ARRAY_CELLS) {
      this.warnOnce(
        `array:${e.handle}`,
        `INSERT array ${cols}×${rows} of "${name}" exceeds ${MAX_ARRAY_CELLS} cells — truncated.`,
      );
      cols = Math.min(cols, MAX_ARRAY_CELLS);
      rows = Math.max(1, Math.floor(MAX_ARRAY_CELLS / cols));
    }
    if (ctx.depth === 0) {
      const cost = cols * rows * (1 + this.blockCost(blk));
      if (cost > (this.opts.maxVisits ?? MAX_VISITS)) {
        this.report.errors.push(
          `Block reference "${name}" (handle ${e.handle || '?'}) would expand to about ${cost.toExponential(1)} entities through nested arrays — skipped.`,
        );
        this.skip(e, 'INSERT', 'expands to too many entities');
        return false;
      }
    }
    this.props(e, ET.OTHER, ctx);
    const head = compose(
      ocsXform(e.extrusionDirection),
      compose(Xform.translate(ix, iy, iz), Xform.rotateZ(rot)),
    );
    const [bx, by, bz] = blk.base;
    const tail = compose(
      sx === 1 && sy === 1 && sz === 1 ? null : Xform.scale(sx, sy, sz),
      bx || by || bz ? Xform.translate(-bx, -by, -bz) : null,
    );
    const first = compose(head, tail);
    const one = first ?? Xform.identity();
    const cellAt = (k: number): Xform | null => {
      if (k === 0) return first;
      const ox = (k % cols) * cs;
      const oy = Math.floor(k / cols) * rs;
      return one.translated(
        head ? head.vx(ox, oy, 0) : ox,
        head ? head.vy(ox, oy, 0) : oy,
        head ? head.vz(ox, oy, 0) : 0,
      );
    };
    return this.expandBlock(e, ctx, blk, cols * rows, cellAt, 'INSERT', e.attribs ?? []);
  }

  /** DIMENSION: renders the anonymous block that holds the dimension's graphics. */
  private dimension(e: DwgDimensionEntity, ctx: Ctx): boolean {
    const blk = this.findBlock(e.name);
    if (!blk) {
      this.skip(e, 'DIMENSION', 'no geometry block (dimension graphics were not saved in the file)');
      return false;
    }
    const ocs = ocsXform(e.extrusionDirection);
    const ip = (e as { insertionPoint?: P3 }).insertionPoint;
    let move: Xform | null = null;
    const ix = fin(ip?.x, 0);
    const iy = fin(ip?.y, 0);
    const iz = fin(ip?.z, 0);
    if (ix || iy || iz) {
      move = Xform.translate(
        ocs ? ocs.x(ix, iy, iz) : ix,
        ocs ? ocs.y(ix, iy, iz) : iy,
        ocs ? ocs.z(ix, iy, iz) : iz,
      );
    }
    const [bx, by, bz] = blk.base;
    const cell = compose(move, compose(ocs, bx || by || bz ? Xform.translate(-bx, -by, -bz) : null));
    this.props(e, ET.DIMENSION, ctx);
    return this.expandBlock(e, ctx, blk, 1, () => cell, 'DIMENSION', []);
  }

  /** ACAD_TABLE: renders its anonymous block when LibreDWG resolved the link to it. */
  private table(e: DwgEntity, ctx: Ctx): boolean {
    const t = e as DwgEntity & { blockRecordHandle?: string; startPoint?: P3 };
    const blk = t.blockRecordHandle
      ? this.blocksByHandle.get(String(t.blockRecordHandle).toUpperCase())
      : undefined;
    if (!blk) {
      this.skip(e, 'ACAD_TABLE', SKIP_REASON.ACAD_TABLE);
      return false;
    }
    const x = fin(t.startPoint?.x, 0);
    const y = fin(t.startPoint?.y, 0);
    const z = fin(t.startPoint?.z, 0);
    const [bx, by, bz] = blk.base;
    const cell = compose(
      x || y || z ? Xform.translate(x, y, z) : null,
      bx || by || bz ? Xform.translate(-bx, -by, -bz) : null,
    );
    this.props(e, ET.OTHER, ctx);
    return this.expandBlock(e, ctx, blk, 1, () => cell, 'ACAD_TABLE', []);
  }
}

/**
 * Converts a LibreDWG database into the flattened entity store used by all drawing importers.
 *
 * @throws DwgReadError ('layout-not-found') when `opts.layout` names a layout that does not exist.
 */
export function dwgDatabaseToStore(db: DwgDatabase, opts: DwgConvertOptions = {}): DrawingParseResult {
  let last = -1;
  const tick = (f: number) => {
    if (!opts.onProgress) return;
    const v = Math.min(1, Math.max(0, f));
    if (v - last >= 0.01 || (v === 1 && last < 1)) {
      last = v;
      opts.onProgress(v);
    }
  };
  const blocks = indexBlocks(db);
  const infos = layoutInfos(db, blocks);
  const wanted = opts.layout && opts.layout.trim().toUpperCase() !== 'MODEL' ? opts.layout.trim() : 'Model';
  const info = infos.find((l) => l.name.toUpperCase() === wanted.toUpperCase());
  if (!info) {
    throw new DwgReadError(
      'layout-not-found',
      `Layout "${wanted}" not found. Available layouts: ${infos.map((l) => l.name).join(', ')}`,
      opts.version,
    );
  }
  const builder = new EntityStoreBuilder();
  const report = emptyReport();
  const conv = new Converter(db, builder, report, { ...opts, tick }, blocks);
  conv.run(info.ents);
  const store = builder.finish();
  const preR2000 = opts.version ? dwgVersionInfo(opts.version).preR2000 : false;
  const ins = db.header?.INSUNITS;
  return {
    store,
    extents: storeExtents(store),
    insunits: !preR2000 && typeof ins === 'number' && Number.isFinite(ins) ? ins : 0,
    layouts: infos.map((l) => l.name),
    layout: info.name,
    report,
    version: opts.version,
  };
}
