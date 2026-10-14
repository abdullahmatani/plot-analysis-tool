import type { AnalysisObject, Bounds, ObjectKind, Project, Pt } from '@/core/types';
import {
  distanceToGeometry,
  geometryInsidePolygon,
  geometryInsideRect,
  geometryIntersectsPolygon,
  geometryIntersectsRect,
  pointInGeometry,
} from '@/geometry/hit';
import { isClosedGeometry } from '@/render/draw-geometry';

import { expand, geomBounds, intersects } from './geometry-cache';
import { resolveStyle } from './style';

/** Object hit-testing for selection (row 43). Hidden and locked layers are excluded. */

/**
 * Custom hit tests for kinds whose visible extent is not their geometry (text boxes, tag bubbles).
 * Returns a distance in world units (≤ tolerance counts as a hit) or null when not hit.
 */
export const kindHitTests: Partial<
  Record<ObjectKind, (o: AnalysisObject, world: Pt, scale: number, p: Project) => number | null>
> = {};

function selectable(p: Project): (o: AnalysisObject) => boolean {
  const off = new Set(p.layers.filter((l) => !l.visible || l.locked).map((l) => l.id));
  return (o) => !off.has(o.layerId);
}

export function pickObject(p: Project, world: Pt, scale: number, tolPx = 6): AnalysisObject | null {
  const tol = tolPx / scale;
  const ok = selectable(p);
  const layerOrder = new Map(p.layers.map((l, i) => [l.id, i]));
  const ordered = [...p.objects]
    .filter(ok)
    .sort(
      (a, b) =>
        (layerOrder.get(b.layerId) ?? 0) - (layerOrder.get(a.layerId) ?? 0) ||
        p.objects.indexOf(b) - p.objects.indexOf(a),
    );
  let best: AnalysisObject | null = null;
  let bestD = Infinity;
  for (const o of ordered) {
    const custom = kindHitTests[o.kind];
    if (custom) {
      const d = custom(o, world, scale, p);
      if (d !== null && d <= tol && d < bestD) {
        best = o;
        bestD = d;
      }
      continue;
    }
    const b = expand(geomBounds(o.geometry), tol);
    if (world.x < b.minX || world.x > b.maxX || world.y < b.minY || world.y > b.maxY) continue;
    const d = distanceToGeometry(world, o.geometry);
    if (d <= tol && d < bestD) {
      best = o;
      bestD = d;
      continue;
    }
    if (!best && isClosedGeometry(o.geometry)) {
      const s = resolveStyle(p, o);
      if (s.hatch !== 'none' && s.fillOpacity > 0 && pointInGeometry(world, o.geometry)) return o;
    }
  }
  return best;
}

/** Window (inside) or crossing (touching) rectangle selection. */
export function objectsInRect(p: Project, b: Bounds, crossing: boolean): string[] {
  const ok = selectable(p);
  return p.objects
    .filter((o) => ok(o) && intersects(geomBounds(o.geometry), b))
    .filter((o) =>
      crossing
        ? geometryIntersectsRect(o.geometry, b) || geometryInsideRect(o.geometry, b)
        : geometryInsideRect(o.geometry, b),
    )
    .map((o) => o.id);
}

export function objectsInLasso(p: Project, poly: Pt[], crossing: boolean): string[] {
  const ok = selectable(p);
  return p.objects
    .filter((o) => ok(o))
    .filter((o) =>
      crossing
        ? geometryIntersectsPolygon(o.geometry, poly) || geometryInsidePolygon(o.geometry, poly)
        : geometryInsidePolygon(o.geometry, poly),
    )
    .map((o) => o.id);
}
