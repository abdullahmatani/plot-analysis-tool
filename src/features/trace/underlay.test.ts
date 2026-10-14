import Flatbush from 'flatbush';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { apply, invert, multiply, similarity } from '@/core/affine';
import type { Affine2D, Drawing, Geometry, Pt, Vertex } from '@/core/types';
import { transformGeometry } from '@/geometry/convert';
import { parseDxf } from '@/import/dxf';
import { FLAG, GK, type EntityStore } from '@/underlay/entity-store';

import { boundaryGeometry, packEntities, solveBoundary } from './boundary-core';
import {
  chainModel,
  chainWorldGeometry,
  entityTraceable,
  entityWorldGeometry,
  nearestPrimOf,
  type VectorSource,
} from './underlay';

/**
 * Pick-trace (row 50), chain trace (row 51) and boundary pick (row 52) on the reference tracing
 * fixture (tests/fixtures/dxf/r2018_trace_site.dxf, UTM coordinates in metres).
 */

const DIR = fileURLToPath(new URL('../../../tests/fixtures/dxf/', import.meta.url));
const parsed = parseDxf(new Uint8Array(readFileSync(DIR + 'r2018_trace_site.dxf')));
const store = parsed.store;
const X0 = 600000;
const Y0 = 2500000;
const P = (x: number, y: number): Pt => ({ x: X0 + x, y: Y0 + y });

const IDENTITY: Affine2D = [1, 0, 0, 1, 0, 0];

function source(placement: Affine2D = IDENTITY, id = 'd1'): VectorSource {
  const index = new Flatbush(store.count);
  for (let i = 0; i < store.count; i++)
    index.add(store.bbox[i * 4], store.bbox[i * 4 + 1], store.bbox[i * 4 + 2], store.bbox[i * 4 + 3]);
  index.finish();
  const drawing = { id, hiddenSourceLayers: [] as string[] } as unknown as Drawing;
  const unit = Math.sqrt(Math.abs(placement[0] * placement[3] - placement[1] * placement[2]));
  return {
    drawing,
    store,
    index,
    placement,
    inverse: invert(placement),
    unit,
    layerVisible: new Uint8Array(store.layers.length).fill(1),
  };
}

function findEntity(s: EntityStore, kind: number, test: (g: number[]) => boolean): number {
  for (let i = 0; i < s.count; i++) {
    if (s.geomKind[i] !== kind) continue;
    if (test(Array.from(s.geom.subarray(s.geomStart[i], s.geomStart[i] + s.geomLen[i])))) return i;
  }
  throw new Error('entity not found');
}

const line = (a: Pt, b: Pt) =>
  findEntity(store, GK.LINE, (g) => g[0] === a.x && g[1] === a.y && g[2] === b.x && g[3] === b.y);
const tank = findEntity(store, GK.CIRCLE, (g) => g[2] === 12.5);

describe('pick-trace (row 50)', () => {
  it('a picked circle has the source centre and radius exactly; similarity placements stay exact', () => {
    expect(entityWorldGeometry(source(), tank, 0.005)).toEqual({
      type: 'circle',
      c: P(35.125, 80.375),
      r: 12.5,
    });
    // mm drawing rotated 30° and shifted: centre = placement(centre), r = 12.5 × scale.
    const m = similarity(0.001, Math.PI / 6, 1000, -50);
    const g = entityWorldGeometry(source(m), tank, 0.005) as Extract<Geometry, { type: 'circle' }>;
    expect(g.type).toBe('circle');
    expect(g.c).toEqual(apply(m, P(35.125, 80.375)));
    expect(g.r).toBeCloseTo(0.0125, 15);
  });

  it('polylines keep their bulges, hatches their boundary, partial ellipses stay within the chord tolerance', () => {
    const rounded = findEntity(store, GK.POLY, (g) => g[0] === 8);
    const pg = entityWorldGeometry(source(), rounded, 0.005) as Extract<Geometry, { type: 'polyline' }>;
    expect(pg.closed).toBe(true);
    expect(pg.pts.filter((v) => v.bulge).map((v) => v.bulge)).toEqual(Array(4).fill(0.41421356237));
    const hatch = findEntity(store, GK.FILL, () => true);
    const hg = entityWorldGeometry(source(), hatch, 0.005) as Extract<Geometry, { type: 'polyline' }>;
    expect(hg).toMatchObject({ type: 'polyline', closed: true });
    expect(hg.pts.map((v) => [v.x, v.y])).toEqual([
      [X0 + 70, Y0 + 60],
      [X0 + 100, Y0 + 60],
      [X0 + 100, Y0 + 75],
      [X0 + 70, Y0 + 75],
    ]);
    expect(hg.pts[2].bulge).toBe(0.4);
    const half = findEntity(store, GK.ELLIPSE, (g) => g[6] - g[5] < 6);
    const eg = entityWorldGeometry(source(), half, 0.002) as Extract<Geometry, { type: 'polyline' }>;
    // Major axis 8 along +Y, ratio 0.5 → x = cx − 4 sin t·…: every vertex on the ellipse, chords within 2 mm.
    const c = P(130, 50);
    for (const v of eg.pts) expect(Math.hypot((v.x - c.x) / 4, (v.y - c.y) / 8)).toBeCloseTo(1, 9);
    for (let k = 0; k + 1 < eg.pts.length; k++) {
      const a = eg.pts[k];
      const b = eg.pts[k + 1];
      const mx = (a.x + b.x) / 2 - c.x;
      const my = (a.y + b.y) / 2 - c.y;
      // Sagitta bound: midpoint of the chord is inside the ellipse by at most the tolerance.
      const t = Math.atan2(-mx / 4, my / 8);
      const onCurve = { x: -4 * Math.sin(t), y: 8 * Math.cos(t) };
      expect(Math.hypot(onCurve.x - mx, onCurve.y - my)).toBeLessThan(0.0021);
    }
  });
});

describe('chain trace (row 51)', () => {
  it('building drawn as separate lines: one click + one junction choice → one closed polygon, exact corners', () => {
    const s = source();
    const model = chainModel(s, 0.1, 0.005);
    const leftWall = line(P(10, 40), P(10, 10));
    const np = nearestPrimOf(model, leftWall, P(10, 25))!;
    let st = model.tracer.start(np.prim, np.local);
    expect(st.status).toBe('junction');
    expect(st.junction!.alternatives).toHaveLength(2);
    // Tab cycles (to the partition and back); Enter follows the straight continuation.
    expect(model.tracer.cycle().junction!.current).toBe(1);
    st = model.tracer.cycle();
    st = model.tracer.accept();
    expect(st.status).toBe('closed');
    const g = chainWorldGeometry(s, st.pts, true, 0.005) as Extract<Geometry, { type: 'polyline' }>;
    expect(g.closed).toBe(true);
    const corners = [P(10, 10), P(50, 10), P(50, 25), P(35, 25), P(35, 40), P(10, 40)];
    expect(g.pts).toHaveLength(6);
    for (const c of corners) expect(g.pts).toContainEqual(c);
  });

  it('a rectangle of four lines with 5 cm gaps closes with its exact corners', () => {
    const s = source();
    const model = chainModel(s, 0.1, 0.005);
    const bottom = line(P(70.05, 10), P(99.95, 10));
    const np = nearestPrimOf(model, bottom, P(85, 10))!;
    const st = model.tracer.start(np.prim, np.local);
    expect(st.status).toBe('closed');
    const g = chainWorldGeometry(s, st.pts, true, 0.005) as Extract<Geometry, { type: 'polyline' }>;
    expect(g.pts).toHaveLength(4);
    for (const c of [P(70, 10), P(100, 10), P(100, 30), P(70, 30)]) expect(g.pts).toContainEqual(c);
    // Without gap closing the chain stays open.
    const tight = chainModel(s, 0, 0.005);
    const np2 = nearestPrimOf(tight, bottom, P(85, 10))!;
    expect(tight.tracer.start(np2.prim, np2.local).status).toBe('open');
  });

  it('block outline: chaining only the parts of one block reference', () => {
    const s = source();
    const ins = store.insertIndex.findIndex((v) => v >= 0);
    const insert = store.insertIndex[ins];
    const model = chainModel(s, 0.01, 0.005, {
      key: `insert:${insert}`,
      filter: (i) => store.insertIndex[i] === insert,
    });
    const part = findEntity(store, GK.LINE, (g) => g[0] > X0 + 120);
    const np = nearestPrimOf(
      model,
      part,
      apply(IDENTITY, { x: store.geom[store.geomStart[part]], y: store.geom[store.geomStart[part] + 1] }),
    )!;
    const st = model.tracer.start(np.prim, np.local);
    expect(st.status).toBe('closed');
    // Skid 4 m × 2 m scaled 1.5 → area 18 m².
    const g = chainWorldGeometry(s, st.pts, true, 0.005)!;
    const pts = (g as Extract<Geometry, { type: 'polyline' }>).pts;
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += (p.x - X0) * (q.y - Y0) - (q.x - X0) * (p.y - Y0);
    }
    expect(Math.abs(a / 2)).toBeCloseTo(18, 6);
  });
});

describe('boundary pick (row 52)', () => {
  const traceable = (s: VectorSource) => {
    const ids: number[] = [];
    for (let i = 0; i < store.count; i++) if (entityTraceable(s, i)) ids.push(i);
    return ids;
  };

  it('picking inside the bunded area returns the bund outline (exact corners) with the tank as a hole', () => {
    const s = source();
    expect(traceable(s).some((i) => store.flags[i] & FLAG.DERIVED)).toBe(false);
    const packed = packEntities(store, traceable(s), s.placement);
    const { result } = solveBoundary({
      pick: P(13, 63),
      drawings: [packed],
      opts: { gapTol: 0.1, detectIslands: true, chordTol: 0.005 },
    });
    expect(result).not.toBeNull();
    const g = boundaryGeometry(result!) as Extract<Geometry, { type: 'multipolygon' }>;
    expect(g.type).toBe('multipolygon');
    expect(g.rings[0]).toHaveLength(4);
    for (const c of [P(10, 60), P(60, 60), P(60, 100), P(10, 100)]) expect(g.rings[0]).toContainEqual(c);
    // The hole is the tank circle: two half-circle bulges, exact radius.
    const hole = g.rings[1];
    expect(hole.every((v) => Math.abs(Math.abs(v.bulge ?? 0) - 1) < 1e-12)).toBe(true);
    for (const v of hole) expect(Math.hypot(v.x - (X0 + 35.125), v.y - (Y0 + 80.375))).toBeCloseTo(12.5, 9);
    // Islands off: the bund outline alone.
    const plain = solveBoundary({
      pick: P(13, 63),
      drawings: [packEntities(store, traceable(s), s.placement)],
      opts: { gapTol: 0.1, detectIslands: false, chordTol: 0.005 },
    });
    expect(boundaryGeometry(plain.result!).type).toBe('polyline');
  });

  it('under a similarity placement (rotation, scale, mirror) the result is the placed drawing-unit result', () => {
    const local = { x: 13, y: 63 };
    for (const m of [
      similarity(0.001, 0.3, 12.5, -40),
      multiply([1, 0, 0, -1, 0, 0], similarity(2, -1.1, 0, 0)), // mirrored
    ] as Affine2D[]) {
      // Re-centre the fixture near the origin first so the placement is meaningful.
      const centred = multiply(m, [1, 0, 0, 1, -X0, -Y0]);
      const s = source(centred);
      const pick = apply(centred, P(local.x, local.y));
      const { result } = solveBoundary({
        pick,
        drawings: [packEntities(store, traceable(s), centred)],
        opts: { gapTol: 0.1 * s.unit, detectIslands: true, chordTol: 0.005 * s.unit },
      });
      const expected = transformGeometry(
        boundaryGeometry(
          solveBoundary({
            pick: P(local.x, local.y),
            drawings: [packEntities(store, traceable(source()), IDENTITY)],
            opts: { gapTol: 0.1, detectIslands: true, chordTol: 0.005 },
          }).result!,
        ),
        centred,
        0.005,
      ) as Extract<Geometry, { type: 'multipolygon' }>;
      const got = boundaryGeometry(result!) as Extract<Geometry, { type: 'multipolygon' }>;
      const near = (ring: Vertex[], p: Vertex) =>
        ring.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9 * Math.max(1, s.unit * 100));
      for (const v of expected.rings[0]) expect(near(got.rings[0], v)).toBe(true);
      expect(got.rings).toHaveLength(2);
    }
  });

  it('a point outside every enclosure returns null', () => {
    const s = source();
    const { result } = solveBoundary({
      pick: P(-50, -50),
      drawings: [packEntities(store, traceable(s), s.placement)],
      opts: { gapTol: 0.1, detectIslands: true, chordTol: 0.005 },
    });
    expect(result).toBeNull();
  });
});
