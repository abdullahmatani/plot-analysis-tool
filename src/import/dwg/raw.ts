import {
  Dwg_Object_Supertype,
  Dwg_Object_Type,
  Dwg_Object_Type_Inverted,
  type DwgDatabase,
  type DwgEntity,
  type DwgInsertEntity,
  type LibreDwgEx,
} from '@mlightcad/libredwg-web';

/**
 * Supplements LibreDWG's DwgDatabase conversion with information read directly from the raw
 * objects (before `dwg_free`):
 *
 * - Entity linetypes "BYBLOCK" and "CONTINUOUS" (DWG linetype flags 1 and 2) are reported by the
 *   converter as an empty name, which would make them BYLAYER. They are restored here.
 * - MINSERT (block arrays) is not converted by LibreDWG's converter; it is rebuilt here as an INSERT
 *   with column/row counts.
 * - Every other entity type the converter drops (REGION, HELIX, meshes, surfaces, underlays, …) gets
 *   a placeholder so the import report lists it as skipped instead of losing it silently.
 */

/** Entity types LibreDWG's converter turns into DwgEntity objects. */
const CONVERTED = new Set<number>([
  Dwg_Object_Type.DWG_TYPE_3DFACE,
  Dwg_Object_Type.DWG_TYPE_3DSOLID,
  Dwg_Object_Type.DWG_TYPE_ARC,
  Dwg_Object_Type.DWG_TYPE_ARCALIGNEDTEXT,
  Dwg_Object_Type.DWG_TYPE_ATTDEF,
  Dwg_Object_Type.DWG_TYPE_CIRCLE,
  Dwg_Object_Type.DWG_TYPE_DIMENSION_ALIGNED,
  Dwg_Object_Type.DWG_TYPE_DIMENSION_LINEAR,
  Dwg_Object_Type.DWG_TYPE_DIMENSION_ANG3PT,
  Dwg_Object_Type.DWG_TYPE_DIMENSION_ANG2LN,
  Dwg_Object_Type.DWG_TYPE_DIMENSION_DIAMETER,
  Dwg_Object_Type.DWG_TYPE_DIMENSION_ORDINATE,
  Dwg_Object_Type.DWG_TYPE_DIMENSION_RADIUS,
  Dwg_Object_Type.DWG_TYPE_ELLIPSE,
  Dwg_Object_Type.DWG_TYPE_HATCH,
  Dwg_Object_Type.DWG_TYPE_IMAGE,
  Dwg_Object_Type.DWG_TYPE_INSERT,
  Dwg_Object_Type.DWG_TYPE_LEADER,
  Dwg_Object_Type.DWG_TYPE_LINE,
  Dwg_Object_Type.DWG_TYPE_LWPOLYLINE,
  Dwg_Object_Type.DWG_TYPE_MLINE,
  Dwg_Object_Type.DWG_TYPE_MULTILEADER,
  Dwg_Object_Type.DWG_TYPE_MTEXT,
  Dwg_Object_Type.DWG_TYPE_OLE2FRAME,
  Dwg_Object_Type.DWG_TYPE_OLEFRAME,
  Dwg_Object_Type.DWG_TYPE_POINT,
  Dwg_Object_Type.DWG_TYPE_POLYLINE_2D,
  Dwg_Object_Type.DWG_TYPE_POLYLINE_3D,
  Dwg_Object_Type.DWG_TYPE_PROXY_ENTITY,
  Dwg_Object_Type.DWG_TYPE_RAY,
  Dwg_Object_Type.DWG_TYPE_SECTIONOBJECT,
  Dwg_Object_Type.DWG_TYPE_SHAPE,
  Dwg_Object_Type.DWG_TYPE_SOLID,
  Dwg_Object_Type.DWG_TYPE_TRACE,
  Dwg_Object_Type.DWG_TYPE_SPLINE,
  Dwg_Object_Type.DWG_TYPE_TABLE,
  Dwg_Object_Type.DWG_TYPE_TEXT,
  Dwg_Object_Type.DWG_TYPE_TOLERANCE,
  Dwg_Object_Type.DWG_TYPE_VIEWPORT,
  Dwg_Object_Type.DWG_TYPE_WIPEOUT,
  Dwg_Object_Type.DWG_TYPE_XLINE,
]);

/** Sub-entities and block structure, never shown on their own. */
const STRUCTURAL = new Set<number>([
  Dwg_Object_Type.DWG_TYPE_ATTRIB,
  Dwg_Object_Type.DWG_TYPE_BLOCK,
  Dwg_Object_Type.DWG_TYPE_ENDBLK,
  Dwg_Object_Type.DWG_TYPE_SEQEND,
  Dwg_Object_Type.DWG_TYPE_VERTEX_2D,
  Dwg_Object_Type.DWG_TYPE_VERTEX_3D,
  Dwg_Object_Type.DWG_TYPE_VERTEX_MESH,
  Dwg_Object_Type.DWG_TYPE_VERTEX_PFACE,
  Dwg_Object_Type.DWG_TYPE_VERTEX_PFACE_FACE,
  // Pre-R13 control entities.
  Dwg_Object_Type.DWG_TYPE_JUMP,
  Dwg_Object_Type.DWG_TYPE_REPEAT,
  Dwg_Object_Type.DWG_TYPE_ENDREP,
  Dwg_Object_Type.DWG_TYPE_LOAD,
]);

const SURFACES = /SURFACE$/;

/** Report name for a dropped entity type. */
function droppedName(fixedtype: number, dxfname: string): string {
  if (fixedtype === Dwg_Object_Type.DWG_TYPE_POLYLINE_PFACE) return 'POLYLINE (polyface mesh)';
  if (fixedtype === Dwg_Object_Type.DWG_TYPE_POLYLINE_MESH) return 'POLYLINE (polygon mesh)';
  if (
    fixedtype === Dwg_Object_Type.DWG_TYPE_UNKNOWN_ENT ||
    fixedtype === Dwg_Object_Type.DWG_TYPE_PROXY_ENTITY
  )
    return 'ACAD_PROXY_ENTITY';
  const fromEnum = (Dwg_Object_Type_Inverted[fixedtype] ?? '').replace(/^DWG_TYPE_/, '');
  const name = (dxfname || fromEnum || 'UNKNOWN').toUpperCase();
  if (SURFACES.test(name)) return 'SURFACE';
  if (/UNDERLAY$/.test(name)) return 'UNDERLAY';
  if (name.startsWith('POINTCLOUD')) return 'POINTCLOUD';
  return name;
}

type Ref = {
  value?: number | bigint;
  absolute_ref?: number | bigint;
  handleref?: { value?: number | bigint };
} | null;

const hex = (v: number | bigint | undefined | null): string =>
  v === undefined || v === null ? '' : v.toString(16).toUpperCase();

export interface RawSupplement {
  /** Entity handle → linetype flag (1 = BYBLOCK, 2 = CONTINUOUS). */
  ltypeFlags: Map<string, number>;
  /** Entities to add to the block record with the given handle. */
  extras: { owner: string; entity: DwgEntity }[];
  /** MINSERTs that could not be rebuilt. */
  minsertFailures: number;
  /** Custom (proxy) entity classes the reader cannot interpret, with counts. */
  customClasses: Map<string, number>;
}

/** Converts a raw MINSERT object into an INSERT with array counts, or throws. */
function minsertToInsert(
  lib: LibreDwgEx,
  obj: number,
  layers: Map<string, string>,
  ltypes: Map<string, string>,
): DwgInsertEntity {
  const ent = lib.dwg_object_to_entity(obj);
  const tio = lib.dwg_object_to_entity_tio(obj);
  if (!ent || !tio) throw new Error('no entity data');
  let name = '';
  const ref = lib.dwg_dynapi_entity_data(tio, 'block_header') as number;
  if (ref) {
    const bobj = lib.dwg_ref_get_object(ref);
    const btio = bobj ? lib.dwg_object_to_object_tio(bobj) : 0;
    if (btio) name = String(lib.dwg_entity_block_header_get_block(btio)?.name ?? '');
  }
  if (!name) throw new Error('block not resolved');
  const ins = lib.dwg_dynapi_entity_data(tio, 'ins_pt') as { x: number; y: number; z: number };
  const scale = lib.dwg_dynapi_entity_data(tio, 'scale') as { x: number; y: number; z: number } | null;
  const color = lib.dwg_object_entity_get_color_object(ent) as { index: number; rgb: number; method: number };
  const layerRef = lib.dwg_object_entity_get_layer_object_ref(ent) as Ref;
  const ltypeRef = lib.dwg_object_entity_get_ltype_object_ref(ent) as Ref;
  const layerKey = hex(layerRef?.absolute_ref) || hex(layerRef?.handleref?.value);
  const ltypeKey = hex(ltypeRef?.absolute_ref) || hex(ltypeRef?.handleref?.value);
  const handle = lib.dwg_object_entity_get_handle_object(ent) as Ref;
  const trueColor = color && (color.method === 0xc2 || ((color.rgb >>> 24) & 0xff) === 0xc2);
  return {
    type: 'INSERT',
    handle: hex(handle?.value),
    ownerBlockRecordSoftId: '',
    layer: layers.get(layerKey) ?? '0',
    lineType: ltypes.get(ltypeKey) ?? '',
    colorIndex: color?.index ?? 256,
    color: trueColor ? color.rgb & 0xffffff : undefined,
    lineweight: lib.dwg_object_entity_get_line_weight(ent),
    lineTypeScale: lib.dwg_object_entity_get_ltype_scale(ent),
    isVisible: !lib.dwg_object_entity_get_invisible(ent),
    transparencyType: 0,
    name,
    insertionPoint: ins,
    xScale: scale ? scale.x : 1,
    yScale: scale ? scale.y : 1,
    zScale: scale ? scale.z : 1,
    rotation: lib.dwg_dynapi_entity_data(tio, 'rotation') as number,
    columnCount: lib.dwg_dynapi_entity_data(tio, 'num_cols') as number,
    rowCount: lib.dwg_dynapi_entity_data(tio, 'num_rows') as number,
    columnSpacing: lib.dwg_dynapi_entity_data(tio, 'col_spacing') as number,
    rowSpacing: lib.dwg_dynapi_entity_data(tio, 'row_spacing') as number,
    extrusionDirection: lib.dwg_dynapi_entity_data(tio, 'extrusion') as { x: number; y: number; z: number },
    attribs: [],
  };
}

/** Scans all raw objects of a read drawing (call before `dwg_free`). */
export function scanRawObjects(lib: LibreDwgEx, data: number, db: DwgDatabase): RawSupplement {
  const out: RawSupplement = {
    ltypeFlags: new Map(),
    extras: [],
    minsertFailures: 0,
    customClasses: new Map(),
  };
  const layers = new Map<string, string>();
  for (const l of db.tables?.LAYER?.entries ?? [])
    if (l.handle) layers.set(String(l.handle).toUpperCase(), l.name);
  const ltypes = new Map<string, string>();
  for (const l of db.tables?.LTYPE?.entries ?? [])
    if (l.handle) ltypes.set(String(l.handle).toUpperCase(), l.name);
  const n = lib.dwg_get_num_objects(data);
  // Block-header TIO pointer → block record handle (built on first use).
  let blockByTio: Map<number, string> | null = null;
  const ownerOf = (obj: number, ent: number): string => {
    const h = hex((lib.dwg_object_entity_get_ownerhandle_object(ent) as Ref)?.absolute_ref);
    if (h && h !== '0') return h;
    // Owner handle not resolved: LibreDWG's fallback via the entity mode (model/paper space).
    if (!blockByTio) {
      blockByTio = new Map();
      for (let k = 0; k < n; k++) {
        const o = lib.dwg_get_object(data, k);
        if (!o || lib.dwg_object_get_fixedtype(o) !== Dwg_Object_Type.DWG_TYPE_BLOCK_HEADER) continue;
        const tio = lib.dwg_object_to_object_tio(o);
        const v = lib.dwg_obj_get_handle_value(o);
        if (tio && v !== null && v !== undefined) blockByTio.set(tio, hex(v));
      }
    }
    const etio = lib.dwg_object_to_entity_tio(obj);
    const ownerTio = etio ? lib.dwg_entity_owner(etio) : 0;
    return (ownerTio && blockByTio.get(ownerTio)) || '';
  };
  for (let i = 0; i < n; i++) {
    const obj = lib.dwg_get_object(data, i);
    if (!obj || lib.dwg_object_get_supertype(obj) !== Dwg_Object_Supertype.DWG_SUPERTYPE_ENTITY) continue;
    const ft = lib.dwg_object_get_fixedtype(obj);
    if (STRUCTURAL.has(ft)) continue;
    const ent = lib.dwg_object_to_entity(obj);
    if (!ent) continue;
    if (CONVERTED.has(ft)) {
      const lf = lib.dwg_object_entity_get_ltype_flags(ent);
      if (lf === 1 || lf === 2) {
        const h = hex((lib.dwg_object_entity_get_handle_object(ent) as Ref)?.value);
        if (h) out.ltypeFlags.set(h, lf);
      }
      continue;
    }
    const owner = ownerOf(obj, ent);
    if (ft === Dwg_Object_Type.DWG_TYPE_MINSERT) {
      try {
        out.extras.push({ owner, entity: minsertToInsert(lib, obj, layers, ltypes) });
        continue;
      } catch {
        out.minsertFailures++;
      }
    }
    let dxfname = '';
    try {
      dxfname = String(lib.dwg_object_get_dxfname(obj) ?? '');
    } catch {
      // name not available
    }
    if (ft === Dwg_Object_Type.DWG_TYPE_UNKNOWN_ENT) {
      // Custom classes (numbered from 500 in the class section), e.g. from AutoCAD verticals.
      const cls = db.classes?.[lib.dwg_object_get_type(obj) - 500];
      const cname = String(cls?.dxfName || cls?.cppName || 'custom');
      out.customClasses.set(cname, (out.customClasses.get(cname) ?? 0) + 1);
    }
    const handle = hex((lib.dwg_object_entity_get_handle_object(ent) as Ref)?.value);
    out.extras.push({
      owner,
      entity: {
        type: ft === Dwg_Object_Type.DWG_TYPE_MINSERT ? 'MINSERT' : droppedName(ft, dxfname),
        handle,
        ownerBlockRecordSoftId: owner,
        layer: '0',
        transparencyType: 0,
      },
    });
  }
  return out;
}

/** Applies a raw supplement to the converted database (linetype flags, extra entities). */
export function applyRawSupplement(db: DwgDatabase, sup: RawSupplement): void {
  const records = db.tables?.BLOCK_RECORD?.entries ?? [];
  if (sup.ltypeFlags.size) {
    const patch = (e: DwgEntity) => {
      if (e.lineType) return;
      const lf = sup.ltypeFlags.get(String(e.handle ?? '').toUpperCase());
      if (lf === 1) e.lineType = 'ByBlock';
      else if (lf === 2) e.lineType = 'Continuous';
    };
    for (const r of records) {
      for (const e of r.entities ?? []) {
        patch(e);
        if (e.type === 'INSERT') for (const a of (e as DwgInsertEntity).attribs ?? []) patch(a);
      }
    }
  }
  if (sup.extras.length) {
    const byHandle = new Map(records.map((r) => [String(r.handle ?? '').toUpperCase(), r]));
    const model = records.find((r) => String(r.name ?? '').toUpperCase() === '*MODEL_SPACE');
    for (const x of sup.extras) {
      // Entities whose owner cannot be resolved at all are attributed to model space.
      const rec = byHandle.get(x.owner) ?? (x.owner && x.owner !== '0' ? undefined : model);
      if (!rec) continue;
      if (!Array.isArray(rec.entities)) rec.entities = [];
      x.entity.ownerBlockRecordSoftId = String(rec.handle ?? '');
      rec.entities.push(x.entity);
    }
  }
}
