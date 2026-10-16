import { describe, expect, it } from 'vitest';

import { createLayer, createProject } from '@/core/project';
import type { Affine2D, AnalysisObject, Project } from '@/core/types';
import type { EntityStore } from '@/underlay/entity-store';

import { entityWorldBounds, selectionBounds } from './bounds';

const circle = (id: string, x: number, y: number, r: number): AnalysisObject => ({
  id,
  layerId: 'L1',
  name: id,
  kind: 'shape',
  geometry: { type: 'circle', c: { x, y }, r },
  style: {},
  attributes: {},
  createdAt: '',
});

function project(): Project {
  const p = createProject('T');
  return {
    ...p,
    layers: [{ ...createLayer('Zones', 0), id: 'L1' }],
    objects: [circle('a', 600_000, 2_500_000, 15), circle('b', 600_100, 2_500_050, 5)],
  };
}

// Two entities in drawing millimetres: a 2 000 × 1 000 mm box, and a point.
const store = {
  count: 2,
  bbox: new Float64Array([1000, 2000, 3000, 3000, 500, 500, 500, 500]),
} as unknown as EntityStore;
// Drawing mm → world m, placed at plant coordinates.
const placement: Affine2D = [0.001, 0, 0, 0.001, 600_000, 2_500_000];

describe('zoom to selection bounds (row 17)', () => {
  it('covers every selected object', () => {
    expect(selectionBounds(project(), ['a', 'b'], null)).toEqual({
      minX: 599_985,
      minY: 2_499_985,
      maxX: 600_105,
      maxY: 2_500_055,
    });
  });

  it('prefers selected objects over the picked underlay entity', () => {
    const b = selectionBounds(project(), ['b'], { store, index: 0, placement });
    expect(b).toEqual({ minX: 600_095, minY: 2_500_045, maxX: 600_105, maxY: 2_500_055 });
  });

  it('uses the picked underlay entity, placed in world metres, when no object is selected', () => {
    expect(entityWorldBounds(store, 0, placement)).toEqual({
      minX: 600_001,
      minY: 2_500_002,
      maxX: 600_003,
      maxY: 2_500_003,
    });
    expect(selectionBounds(project(), [], { store, index: 0, placement })).toEqual({
      minX: 600_001,
      minY: 2_500_001.5,
      maxX: 600_003,
      maxY: 2_500_003.5,
    });
  });

  it('pads a point-like selection to the minimum size', () => {
    expect(selectionBounds(project(), [], { store, index: 1, placement }, 4)).toEqual({
      minX: 599_998.5,
      minY: 2_499_998.5,
      maxX: 600_002.5,
      maxY: 2_500_002.5,
    });
  });

  it('returns null when nothing usable is selected', () => {
    expect(selectionBounds(project(), [], null)).toBeNull();
    expect(selectionBounds(project(), ['deleted'], null)).toBeNull();
    expect(selectionBounds(project(), [], { store, index: 7, placement })).toBeNull();
  });
});
