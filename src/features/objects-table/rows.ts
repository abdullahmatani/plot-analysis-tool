import type { AnalysisObject, Bounds, Project } from '@/core/types';
import { geomBounds } from '@/features/objects/geometry-cache';
import { measures } from '@/features/objects/labels';

/**
 * Objects table rows (row 46): one row per analysis object with its layer, type and live measures
 * (area, perimeter, length, radius in world metres) and attributes. Pure; the measures are cached per
 * geometry identity, so rebuilding the rows after an edit is cheap.
 */

export interface ObjectRow {
  id: string;
  name: string;
  layerId: string;
  layer: string;
  /** Layer is hidden or locked: the object cannot be selected (row 37). */
  selectable: boolean;
  type: string;
  area: number | null;
  perimeter: number | null;
  length: number | null;
  radius: number | null;
  category: string;
  /** "key=value; …" of the custom attributes. */
  attributes: string;
  /** Text searched by the quick filter. */
  search: string;
}

const KIND_LABEL: Record<AnalysisObject['kind'], string> = {
  shape: '',
  trace: 'Trace',
  offset: 'Offset',
  measurement: 'Measurement',
  text: 'Text',
  callout: 'Callout',
  tag: 'Tag',
  cloud: 'Cloud',
};

export function objectType(o: AnalysisObject): string {
  if (o.kind !== 'shape') return KIND_LABEL[o.kind];
  const g = o.geometry;
  switch (g.type) {
    case 'circle':
      return 'Circle';
    case 'arc':
      return 'Arc';
    case 'rect':
      return 'Rectangle';
    case 'ellipse':
      return 'Ellipse';
    case 'polyline':
      return g.closed ? 'Polygon' : g.pts.length === 2 ? 'Line' : 'Polyline';
    case 'multipolygon':
      return 'Area';
    case 'point':
      return 'Point';
  }
}

const rowCache = new WeakMap<AnalysisObject, { layers: Project['layers']; row: ObjectRow }>();

export function objectRows(p: Project): ObjectRow[] {
  const layers = new Map(p.layers.map((l) => [l.id, l]));
  return p.objects.map((o) => {
    const hit = rowCache.get(o);
    if (hit && hit.layers === p.layers) return hit.row;
    const l = layers.get(o.layerId);
    const m = measures(o.geometry);
    const attrs = Object.entries(o.attributes)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const type = objectType(o);
    const row: ObjectRow = {
      id: o.id,
      name: o.name,
      layerId: o.layerId,
      layer: l?.name ?? '',
      selectable: !!l && l.visible && !l.locked,
      type,
      area: m.area ?? null,
      perimeter: m.perimeter ?? null,
      length: m.length ?? null,
      radius: m.radius ?? null,
      category: o.category ?? '',
      attributes: attrs,
      search:
        `${o.name}\u0001${l?.name ?? ''}\u0001${type}\u0001${o.category ?? ''}\u0001${attrs}\u0001${o.text ?? ''}`.toLowerCase(),
    };
    rowCache.set(o, { layers: p.layers, row });
    return row;
  });
}

/** Bounds of objects (zoom to selection); tiny or point objects get a minimum extent. */
export function objectsBounds(p: Project, ids: Iterable<string>, minSize = 2): Bounds | null {
  const set = new Set(ids);
  let b: Bounds | null = null;
  for (const o of p.objects) {
    if (!set.has(o.id)) continue;
    const g = geomBounds(o.geometry);
    b = b
      ? {
          minX: Math.min(b.minX, g.minX),
          minY: Math.min(b.minY, g.minY),
          maxX: Math.max(b.maxX, g.maxX),
          maxY: Math.max(b.maxY, g.maxY),
        }
      : { ...g };
  }
  return b && padToMinSize(b, minSize);
}

/** Grows `b` about its centre so each side is at least `minSize`. */
export function padToMinSize(b: Bounds, minSize: number): Bounds {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const hw = Math.max(minSize / 2, (b.maxX - b.minX) / 2);
  const hh = Math.max(minSize / 2, (b.maxY - b.minY) / 2);
  return { minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh };
}
