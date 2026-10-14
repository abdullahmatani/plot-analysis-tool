import { beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '@/core/project';
import { getProject, useProjectStore } from '@/store/project';
import { makeDataset } from '@/tables/test-helpers';

import {
  addAnchors,
  anchorReferences,
  anchorsFromCircles,
  anchorUsage,
  deleteAnchors,
  moveAnchor,
  nextAnchorName,
  renameAnchor,
  uniqueAnchorNames,
} from './ops';

function load() {
  const table = {
    columns: ['Tag', 'X', 'Y', 'R'],
    rows: [
      ['P-101', 0, 0, 10],
      [' p-101 ', 0, 0, 20],
      ['V-201', 0, 0, 5],
    ],
  };
  const ds = makeDataset(table, {
    mapping: {
      position: { mode: 'anchor', anchor: 'Tag' },
      sizeColumns: ['R'],
      sizeMode: 'radius',
      sizeUnit: 'm',
    },
  });
  useProjectStore.getState().load({ project: { ...createProject('A'), datasets: [ds] }, undo: [], redo: [] });
}

const p = () => getProject()!;

describe('anchors (row 47)', () => {
  beforeEach(load);

  it('places anchors with unique names', () => {
    expect(nextAnchorName(p())).toBe('A1');
    addAnchors([{ name: 'P-101', p: { x: 1, y: 2 } }]);
    addAnchors([
      { name: 'p-101', p: { x: 3, y: 4 } },
      { name: 'A1', p: { x: 5, y: 6 } },
    ]);
    expect(p().anchors.map((a) => a.name)).toEqual(['P-101', 'p-101 (2)', 'A1']);
    expect(nextAnchorName(p())).toBe('A2');
    expect(uniqueAnchorNames(p(), ['A1', 'A1'])).toEqual(['A1 (2)', 'A1 (3)']);
  });

  it('renaming an anchor updates every dataset row referencing it, in one undo step', () => {
    addAnchors([{ name: 'P-101', p: { x: 1, y: 2 } }]);
    const id = p().anchors[0].id;
    expect(anchorReferences(p(), 'P-101').get(p().datasets[0].id)).toEqual([0, 1]);
    const undoBefore = useProjectStore.getState().history!.undo.length;
    expect(renameAnchor(id, 'P-101A')).toEqual({ ok: true, rows: 2 });
    expect(useProjectStore.getState().history!.undo.length).toBe(undoBefore + 1);
    expect(p().anchors[0].name).toBe('P-101A');
    expect(p().datasets[0].table.rows.map((r) => r[0])).toEqual(['P-101A', 'P-101A', 'V-201']);
    expect(anchorUsage(p().datasets).get('p-101a')).toBe(2);
    useProjectStore.getState().undo();
    expect(p().anchors[0].name).toBe('P-101');
    expect(p().datasets[0].table.rows.map((r) => r[0])).toEqual(['P-101', ' p-101 ', 'V-201']);
  });

  it('refuses empty or duplicate names', () => {
    addAnchors([
      { name: 'P-101', p: { x: 1, y: 2 } },
      { name: 'V-201', p: { x: 3, y: 4 } },
    ]);
    const id = p().anchors[0].id;
    expect(renameAnchor(id, ' ')).toMatchObject({ ok: false });
    expect(renameAnchor(id, 'v-201')).toMatchObject({ ok: false });
  });

  it('moves and deletes anchors', () => {
    addAnchors([{ name: 'P-101', p: { x: 1, y: 2 } }]);
    const id = p().anchors[0].id;
    moveAnchor(id, { x: 10, y: 20 });
    expect(p().anchors[0].p).toEqual({ x: 10, y: 20 });
    deleteAnchors([id]);
    expect(p().anchors).toEqual([]);
  });

  it('bulk-creates anchors from circle centres: one per centre, text tags first, reading order', () => {
    addAnchors([{ name: 'Existing', p: { x: 500, y: 500 } }]);
    const list = anchorsFromCircles(
      p(),
      [
        { key: 'a', c: { x: 0, y: 0 }, r: 5 },
        { key: 'b', c: { x: 0, y: 0 }, r: 10, text: 'P-201' }, // concentric: one anchor, outer tag
        { key: 'c', c: { x: 50, y: 100 }, r: 3 },
        { key: 'd', c: { x: 10, y: 100 }, r: 3 },
        { key: 'e', c: { x: 500, y: 500 }, r: 3 }, // already has an anchor
      ],
      'N-',
    );
    expect(list).toEqual([
      { name: 'N-1', p: { x: 10, y: 100 } },
      { name: 'N-2', p: { x: 50, y: 100 } },
      { name: 'P-201', p: { x: 0, y: 0 } },
    ]);
  });
});
