import { transformBounds } from '@/core/affine';
import type { Affine2D, Bounds, Project } from '@/core/types';
import { objectsBounds, padToMinSize } from '@/features/objects-table/rows';
import type { EntityStore } from '@/underlay/entity-store';

/**
 * Bounds for "Zoom to selection" (row 17): the selected analysis objects or, when none are
 * selected, the underlay entity picked in the inspector. Point-like selections are padded to
 * `minSize` metres so the view does not zoom to the scale limit.
 */

/** World bounds of underlay entity `index` (its stored box is in drawing units). */
export function entityWorldBounds(store: EntityStore, index: number, placement: Affine2D): Bounds {
  const o = index * 4;
  const b = store.bbox;
  return transformBounds(placement, { minX: b[o], minY: b[o + 1], maxX: b[o + 2], maxY: b[o + 3] });
}

export interface PickedEntity {
  store: EntityStore;
  index: number;
  placement: Affine2D;
}

export function selectionBounds(
  project: Project,
  selection: readonly string[],
  picked: PickedEntity | null,
  minSize = 2,
): Bounds | null {
  if (selection.length) {
    const b = objectsBounds(project, selection, minSize);
    if (b) return b;
  }
  if (picked && picked.index >= 0 && picked.index < picked.store.count)
    return padToMinSize(entityWorldBounds(picked.store, picked.index, picked.placement), minSize);
  return null;
}
