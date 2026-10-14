import type { Drawing, Geometry } from '@/core/types';
import { transformGeometry } from '@/geometry/convert';
import { area, length, radiusOf } from '@/geometry/measure';

import { substituteFont } from './cad-fonts';
import { FLAG, GK } from './entity-store';
import { entityText, entityToGeometry, entityTypeName } from './entity-geometry';
import { getModel } from './models';
import { drawingPlacement } from './pick';

/** Entity inspector data (row 20): type, layer and world-unit measurements of an underlay entity. */
export interface EntityInfo {
  type: string;
  layer: string;
  color: string;
  handle?: string;
  text?: string;
  block?: string;
  /** Text: font named by the drawing and the bundled substitute used (row 24). */
  font?: string;
  /** World metres. */
  length?: number;
  radius?: number;
  area?: number;
  /** Geometry in world coordinates. */
  world: Geometry | null;
  calibrated: boolean;
}

export function entityInfo(d: Drawing, index: number): EntityInfo | null {
  const m = getModel(d.id);
  const s = m?.result?.store;
  if (!s || index < 0 || index >= s.count) return null;
  const g = entityToGeometry(s, index);
  const world = g ? transformGeometry(g, drawingPlacement(d), 0.0005) : null;
  const closed =
    s.geomKind[index] === GK.CIRCLE ||
    s.geomKind[index] === GK.FILL ||
    (s.geomKind[index] === GK.POLY && (s.flags[index] & FLAG.CLOSED) !== 0);
  const ins = s.insertIndex[index] >= 0 ? s.inserts[s.insertIndex[index]] : undefined;
  const info: EntityInfo = {
    type: entityTypeName(s, index),
    layer: s.layers[s.layer[index]]?.name ?? '0',
    color: `#${s.color[index].toString(16).padStart(6, '0')}`,
    handle: s.handles[index] || undefined,
    text: entityText(s, index) ?? undefined,
    block: ins ? `${ins.type} ${ins.name}` : undefined,
    world,
    calibrated: !!d.calibration,
  };
  if (s.geomKind[index] === GK.TEXT && s.geomLen[index] > 10) {
    const fi = s.geom[s.geomStart[index] + 10];
    const name = fi >= 0 ? s.fonts?.[fi] : undefined;
    if (name) {
      const sub = substituteFont(name);
      info.font = `${name} → ${sub.kind === 'mono' ? 'monospace' : 'Noto Sans'}${sub.widthScale !== 1 ? ` (width ×${sub.widthScale})` : ''}`;
    }
  }
  if (world && world.type !== 'point') {
    info.length = length(world);
    const r = radiusOf(world);
    if (r !== null) info.radius = r;
    if (closed) info.area = area(world);
  }
  return info;
}
