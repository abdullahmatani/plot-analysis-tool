import { describe, expect, it } from 'vitest';

import { createLayer, createProject } from '@/core/project';
import type { AnalysisObject, Geometry, Project } from '@/core/types';

import { objectRows, objectsBounds, objectType } from './rows';

function obj(id: string, geometry: Geometry, extra: Partial<AnalysisObject> = {}): AnalysisObject {
  return {
    id,
    layerId: 'L1',
    name: id,
    kind: 'shape',
    geometry,
    style: {},
    attributes: {},
    createdAt: '',
    ...extra,
  };
}

function project(): Project {
  const p = createProject('T');
  const l1 = { ...createLayer('Zones', 0), id: 'L1' };
  const l2 = { ...createLayer('Locked', 1), id: 'L2', locked: true };
  return {
    ...p,
    layers: [l1, l2],
    objects: [
      obj(
        'c',
        { type: 'circle', c: { x: 0, y: 0 }, r: 10 },
        { attributes: { tag: 'P-101' }, category: 'Equip' },
      ),
      obj('r', { type: 'rect', c: { x: 100, y: 0 }, w: 20, h: 10, rot: 0 }, { layerId: 'L2' }),
      obj('l', {
        type: 'polyline',
        pts: [
          { x: 0, y: 0 },
          { x: 3, y: 4 },
        ],
        closed: false,
      }),
      obj('t', { type: 'point', p: { x: 5, y: 5 } }, { kind: 'text', text: 'Note' }),
    ],
  };
}

describe('objects table rows (row 46)', () => {
  it('lists layer, type, live measures and attributes', () => {
    const rows = objectRows(project());
    expect(rows.map((r) => [r.name, r.layer, r.type, r.selectable])).toEqual([
      ['c', 'Zones', 'Circle', true],
      ['r', 'Locked', 'Rectangle', false],
      ['l', 'Zones', 'Line', true],
      ['t', 'Zones', 'Text', true],
    ]);
    expect(rows[0].area).toBeCloseTo(Math.PI * 100, 9);
    expect(rows[0].perimeter).toBeCloseTo(Math.PI * 20, 9);
    expect(rows[0].radius).toBe(10);
    expect(rows[0].attributes).toBe('tag=P-101');
    expect(rows[1].area).toBe(200);
    expect(rows[2].length).toBe(5);
    expect(rows[2].area).toBeNull();
    expect(rows[0].search).toContain('p-101');
  });

  it('reuses rows of unchanged objects', () => {
    const p = project();
    const a = objectRows(p);
    const b = objectRows({ ...p, objects: [...p.objects] });
    expect(b[0]).toBe(a[0]);
  });

  it('computes zoom bounds with a minimum extent for points', () => {
    const p = project();
    expect(objectsBounds(p, ['c'])).toEqual({ minX: -10, minY: -10, maxX: 10, maxY: 10 });
    expect(objectsBounds(p, ['t'], 2)).toEqual({ minX: 4, minY: 4, maxX: 6, maxY: 6 });
    expect(objectsBounds(p, [])).toBeNull();
  });

  it('names geometry types', () => {
    expect(objectType(obj('x', { type: 'polyline', pts: [], closed: true }))).toBe('Polygon');
    expect(objectType(obj('x', { type: 'multipolygon', rings: [] }))).toBe('Area');
  });
});
