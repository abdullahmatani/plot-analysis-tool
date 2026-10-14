import { apply, invert, multiply } from '@/core/affine';
import type { Affine2D, Drawing, Pt } from '@/core/types';
import { distanceToGeometry, pointInGeometry } from '@/geometry/hit';

import { FLAG, GK } from './entity-store';
import { entityToGeometry } from './entity-geometry';
import { getModel, placementOf } from './models';

/** Underlay picking: the entity under a world point within a pixel tolerance (rows 20, 50). */

export interface UnderlayHit {
  drawingId: string;
  index: number;
  /** Distance in screen pixels. */
  distPx: number;
}

/** Layer visibility flags for a drawing (source layers hidden by the user are excluded from view, snapping and export — row 19). */
export function visibleLayerFlags(d: Drawing): Uint8Array {
  const m = getModel(d.id);
  const layers = m?.result?.store.layers ?? [];
  const hidden = new Set(d.hiddenSourceLayers);
  const flags = new Uint8Array(Math.max(1, layers.length));
  layers.forEach((l, i) => (flags[i] = hidden.has(l.ocgId ?? l.name) || hidden.has(l.name) ? 0 : 1));
  if (!layers.length) flags[0] = 1;
  return flags;
}

export function drawingPlacement(d: Drawing): Affine2D {
  return placementOf(d, getModel(d.id)?.result?.insunits);
}

/**
 * Finds underlay entities near `world`. Drawings are searched top-most first.
 * `scale` = screen px per world metre.
 */
export function pickUnderlay(
  drawings: Drawing[],
  world: Pt,
  scale: number,
  tolPx: number,
  opts: { includeText?: boolean; includeDerived?: boolean; limit?: number } = {},
): UnderlayHit[] {
  const hits: UnderlayHit[] = [];
  const sorted = [...drawings].filter((d) => d.visible).sort((a, b) => b.order - a.order);
  for (const d of sorted) {
    const m = getModel(d.id);
    const store = m?.result?.store;
    if (!m?.index || !store) continue;
    const place = drawingPlacement(d);
    let inv: Affine2D;
    try {
      inv = invert(place);
    } catch {
      continue;
    }
    const p = apply(inv, world);
    const unitPx = scale * Math.sqrt(Math.abs(place[0] * place[3] - place[1] * place[2]));
    const tol = tolPx / unitPx;
    const flags = visibleLayerFlags(d);
    const ids = m.index.search(p.x - tol, p.y - tol, p.x + tol, p.y + tol);
    for (const i of ids) {
      if (store.flags[i] & FLAG.HIDDEN) continue;
      if (!opts.includeDerived && store.flags[i] & FLAG.DERIVED) continue;
      if (!flags[store.layer[i]]) continue;
      if (!opts.includeText && store.geomKind[i] === GK.TEXT) {
        // Text is pickable by its insertion box only.
        const o = i * 4;
        if (
          p.x < store.bbox[o] ||
          p.x > store.bbox[o + 2] ||
          p.y < store.bbox[o + 1] ||
          p.y > store.bbox[o + 3]
        )
          continue;
        hits.push({ drawingId: d.id, index: i, distPx: tolPx * 0.9 });
        continue;
      }
      const g = entityToGeometry(store, i);
      if (!g) continue;
      let dist = distanceToGeometry(p, g);
      if (store.geomKind[i] === GK.FILL && dist > tol && pointInGeometry(p, g)) dist = tol * 0.95;
      if (dist <= tol) hits.push({ drawingId: d.id, index: i, distPx: dist * unitPx });
    }
    if (hits.length && opts.limit === 1) break;
  }
  hits.sort((a, b) => a.distPx - b.distPx);
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

/** Composes alignment and calibration (exported for tests). */
export function compose(a: Affine2D, b: Affine2D): Affine2D {
  return multiply(a, b);
}
