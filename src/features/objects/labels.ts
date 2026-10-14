import { formatNumber, fromMetres, AREA_FACTORS, AREA_LABEL, UNIT_LABEL } from '@/core/units';
import type { AnalysisObject, Geometry, Project, Pt } from '@/core/types';
import { area, bounds, centroid, length, perimeter, radiusOf } from '@/geometry/measure';
import { isClosed } from '@/geometry/convert';
import { renderTemplate } from '@/tables/template';

import { layerOf } from './style';

/**
 * Object labels (row 40): template fields {name}, {area}, {perimeter}, {length}, {radius},
 * {diameter}, {layer}, {category}, {notes}, {text}, {tag} and every custom attribute. Measures are
 * computed live from the geometry in the project's display units.
 */

export interface Measures {
  area?: number;
  perimeter?: number;
  length?: number;
  radius?: number;
}

const measureCache = new WeakMap<Geometry, Measures>();

export function measures(g: Geometry): Measures {
  let m = measureCache.get(g);
  if (m) return m;
  m = {};
  if (g.type !== 'point') {
    if (isClosed(g)) {
      m.area = area(g);
      m.perimeter = perimeter(g);
    } else {
      m.length = length(g);
    }
    const r = radiusOf(g);
    if (r !== null) m.radius = r;
  }
  measureCache.set(g, m);
  return m;
}

export function labelContext(project: Project, o: AnalysisObject): Record<string, unknown> {
  const { units, precision, areaUnits } = project.display;
  const m = measures(o.geometry);
  const len = (v?: number) => (v === undefined ? '' : formatNumber(fromMetres(v, units), precision));
  return {
    ...o.attributes,
    name: o.name,
    layer: layerOf(project, o)?.name ?? '',
    category: o.category ?? '',
    notes: o.notes ?? '',
    text: o.text ?? '',
    tag: o.tagNumber !== undefined ? `${layerOf(project, o)?.tagPrefix ?? ''}${o.tagNumber}` : '',
    area: m.area === undefined ? '' : formatNumber(m.area / AREA_FACTORS[areaUnits], precision),
    perimeter: len(m.perimeter),
    length: len(m.length ?? m.perimeter),
    radius: len(m.radius),
    diameter: m.radius === undefined ? '' : len(m.radius * 2),
    area_unit: AREA_LABEL[areaUnits],
    unit: UNIT_LABEL[units],
    length_unit: UNIT_LABEL[units],
  };
}

export function labelText(project: Project, o: AnalysisObject): string {
  if (!o.label?.visible) return '';
  return renderTemplate(o.label.template, labelContext(project, o));
}

/** Anchor point of the label in world coordinates (before the user offset). */
export function labelAnchor(o: AnalysisObject): Pt {
  const g = o.geometry;
  const placement = o.label?.placement ?? 'centroid';
  if (g.type === 'point') return g.p;
  if (placement === 'top' || placement === 'boundary') {
    const b = bounds(g);
    return { x: (b.minX + b.maxX) / 2, y: b.maxY };
  }
  if (g.type === 'polyline' && !g.closed) {
    // Midpoint along an open line.
    const pts = g.pts;
    return pts.length
      ? { x: (pts[0].x + pts[pts.length - 1].x) / 2, y: (pts[0].y + pts[pts.length - 1].y) / 2 }
      : { x: 0, y: 0 };
  }
  return centroid(g);
}

export const DEFAULT_LABEL_TEMPLATE = '{name}';
