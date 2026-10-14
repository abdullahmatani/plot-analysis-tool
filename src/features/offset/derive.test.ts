import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit, redo, registerDerivation, undo, type HistoryState } from '@/core/history';
import { createProject } from '@/core/project';
import type { AnalysisObject, Geometry, OffsetDerivation } from '@/core/types';
import { area } from '@/geometry/measure';

import { deriveOffsets, type DeriveReport } from './derive';

/** Parametric (live) offsets (row 59): recomputed in the same undo step as the source edit. */

let seq = 0;
function obj(geometry: Geometry, extra: Partial<AnalysisObject> = {}): AnalysisObject {
  return {
    id: `o${++seq}`,
    layerId: 'L',
    name: `Obj ${seq}`,
    kind: 'shape',
    geometry,
    style: {},
    attributes: {},
    createdAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

const der = (
  sourceId: string,
  distance: number,
  extra: Partial<OffsetDerivation> = {},
): OffsetDerivation => ({
  kind: 'offset',
  sourceId,
  distance,
  join: 'round',
  ...extra,
});

const square: Geometry = {
  type: 'polyline',
  pts: [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
  ],
  closed: true,
};

let reports: DeriveReport[] = [];
let un: () => void = () => {};
beforeEach(() => {
  reports = [];
  un = registerDerivation((d, before) => void reports.push(deriveOffsets(d, before)));
});
afterEach(() => un());

function setup(objects: AnalysisObject[]): HistoryState {
  const p = createProject('Live');
  // Initial state: created without running derivations (as a load would be).
  return { project: { ...p, objects }, undo: [], redo: [] };
}

const byId = (s: HistoryState, id: string) => s.project.objects.find((o) => o.id === id)!;
const g = (s: HistoryState, id: string) => byId(s, id).geometry;

describe('live offsets', () => {
  it('moving a source vertex updates the offset in the same command; undo restores both', () => {
    const src = obj(square);
    const off = obj({ type: 'circle', c: { x: 0, y: 0 }, r: 1 }, { kind: 'offset', derived: der(src.id, 5) });
    let s = setup([src, off]);
    const r = commit(s, 'Move vertex', (d) => {
      const pts = (d.objects[0].geometry as Extract<Geometry, { type: 'polyline' }>).pts;
      pts[2] = { x: 50, y: 30 };
    })!;
    s = r.state;
    expect(s.undo).toHaveLength(1);
    const og = g(s, off.id);
    expect(og.type).toBe('polyline');
    // Every vertex of the new offset is ≥ 5 m (round join) from the moved source; the far corner moved out.
    const xs = (og as Extract<Geometry, { type: 'polyline' }>).pts.map((p) => p.x);
    expect(Math.max(...xs)).toBeGreaterThan(54.9);
    expect(reports.at(-1)!.recomputed).toEqual([off.id]);
    // Patches carry the recomputed geometry: undo restores the original, redo the new one.
    const u = undo(s)!.state;
    expect(g(u, off.id)).toEqual(off.geometry);
    expect(redo(u)!.state.project.objects[1].geometry).toEqual(og);
  });

  it('changing the distance or the chord tolerance recomputes; other edits leave offsets alone', () => {
    const src = obj({ type: 'circle', c: { x: 10, y: 10 }, r: 10 });
    const off = obj(
      { type: 'circle', c: { x: 10, y: 10 }, r: 15 },
      { kind: 'offset', derived: der(src.id, 5) },
    );
    let s = setup([src, off]);
    s = commit(s, 'Distance', (d) => void (d.objects[1].derived!.distance = 12))!.state;
    expect(g(s, off.id)).toEqual({ type: 'circle', c: { x: 10, y: 10 }, r: 22 });
    const before = byId(s, off.id);
    s = commit(s, 'Rename source', (d) => void (d.objects[0].name = 'Tank'))!.state;
    expect(byId(s, off.id)).toBe(before);
    s = commit(s, 'Chord tolerance', (d) => void (d.chordTolerance = 0.001))!.state;
    expect(reports.at(-1)!.recomputed).toEqual([off.id]);
  });

  it('editing the offset itself detaches it (the edit is kept); deleting the source detaches too', () => {
    const src = obj(square);
    const a = obj(square, { kind: 'offset', derived: der(src.id, 2) });
    const b = obj(square, { kind: 'offset', derived: der(src.id, 4) });
    let s = setup([src, a, b]);
    s = commit(
      s,
      'Move offset',
      (d) => void (d.objects[1].geometry = { type: 'circle', c: { x: 0, y: 0 }, r: 3 }),
    )!.state;
    expect(byId(s, a.id).derived).toBeUndefined();
    expect(g(s, a.id)).toEqual({ type: 'circle', c: { x: 0, y: 0 }, r: 3 });
    expect(reports.at(-1)!.detached).toEqual([{ id: a.id, reason: 'edited' }]);
    s = commit(s, 'Delete source', (d) => void (d.objects = d.objects.filter((o) => o.id !== src.id)))!.state;
    expect(byId(s, b.id).derived).toBeUndefined();
    expect(reports.at(-1)!.detached).toEqual([{ id: b.id, reason: 'source-deleted' }]);
    // Undo brings source and link back in one step.
    const u = undo(s)!.state;
    expect(byId(u, b.id).derived?.sourceId).toBe(src.id);
  });

  it('offsets of offsets update source-first; cycles are detached', () => {
    const src = obj({ type: 'circle', c: { x: 0, y: 0 }, r: 10 });
    // Listed child-first to check the ordering.
    const second = obj({ type: 'circle', c: { x: 0, y: 0 }, r: 18 }, { kind: 'offset' });
    const first = obj(
      { type: 'circle', c: { x: 0, y: 0 }, r: 15 },
      { kind: 'offset', derived: der(src.id, 5) },
    );
    second.derived = der(first.id, 3);
    let s = setup([second, src, first]);
    s = commit(s, 'Grow', (d) => void ((d.objects[1].geometry as { r: number }).r = 20))!.state;
    expect((g(s, first.id) as { r: number }).r).toBe(25);
    expect((g(s, second.id) as { r: number }).r).toBe(28);

    const x = obj(square, { kind: 'offset' });
    const y = obj(square, { kind: 'offset', derived: der(x.id, 1) });
    x.derived = der(y.id, 1);
    let c = setup([x, y]);
    c = commit(c, 'Touch', (d) => void (d.objects[0].name = 'X'))!.state;
    expect(byId(c, x.id).derived).toBeUndefined();
    expect(byId(c, y.id).derived).toBeUndefined();
  });

  it('a contraction that collapses leaves a point at the centroid and stays live', () => {
    const src = obj({ type: 'circle', c: { x: 3, y: 4 }, r: 10 });
    const off = obj(
      { type: 'circle', c: { x: 3, y: 4 }, r: 5 },
      { kind: 'offset', derived: der(src.id, -5) },
    );
    let s = setup([src, off]);
    s = commit(s, 'Shrink', (d) => void ((d.objects[0].geometry as { r: number }).r = 4))!.state;
    expect(g(s, off.id)).toEqual({ type: 'point', p: { x: 3, y: 4 } });
    expect(byId(s, off.id).derived).toBeDefined();
    expect(reports.at(-1)!.collapsed[0].message).toMatch(/r ≤ 0/);
    s = commit(s, 'Grow', (d) => void ((d.objects[0].geometry as { r: number }).r = 12))!.state;
    expect(g(s, off.id)).toEqual({ type: 'circle', c: { x: 3, y: 4 }, r: 7 });
  });

  it('round live offset of a polygon matches the Steiner formula after an edit (NFR-7)', () => {
    const src = obj(square);
    const off = obj(square, { kind: 'offset', derived: der(src.id, 10) });
    let s = setup([src, off]);
    s = commit(s, 'Widen', (d) => {
      const pts = (d.objects[0].geometry as Extract<Geometry, { type: 'polyline' }>).pts;
      pts[1] = { x: 60, y: 0 };
      pts[2] = { x: 60, y: 20 };
    })!.state;
    // Convex polygon: A + P·d + π·d² (arcs tessellated within the chord tolerance, inscribed).
    const exact = 60 * 20 + 160 * 10 + Math.PI * 100;
    const got = area(g(s, off.id));
    expect(got).toBeLessThanOrEqual(exact + 1e-6);
    expect(exact - got).toBeLessThan(0.005 * 2 * Math.PI * 10);
  });
});
