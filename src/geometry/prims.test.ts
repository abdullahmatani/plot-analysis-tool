import { describe, expect, it } from 'vitest';

import { EntityStoreBuilder, ET, FLAG, GK } from '@/underlay/entity-store';
import {
  arcEnd,
  arcFromBulge,
  arcStart,
  arcSweep,
  ellipseArcLength,
  ellipseSweep,
  inSpan,
  isFullEllipse,
  primBounds,
  primEndpoints,
  primIsClosed,
  primLength,
  primPointAt,
  primTangentAt,
  primsFromGeometry,
  primsFromPolyline,
  primsFromStoreEntity,
  spanParam,
  unionBounds,
  type Prim,
} from './prims';

const B = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

describe('primsFromPolyline / arcFromBulge', () => {
  it('turns straight segments into segs with exact endpoints', () => {
    const pts = [
      { x: 612345.123, y: 2534210.004 },
      { x: 612355.5, y: 2534210.004 },
      { x: 612355.5, y: 2534220.75 },
    ];
    const prims = primsFromPolyline(pts, false);
    expect(prims).toHaveLength(2);
    expect(prims[0]).toEqual({ k: 'seg', a: pts[0], b: pts[1] });
    expect(prims[1]).toEqual({ k: 'seg', a: pts[1], b: pts[2] });
    expect(primsFromPolyline(pts, true)).toHaveLength(3);
  });

  it('skips zero-length segments and handles single vertices', () => {
    expect(primsFromPolyline([], false)).toEqual([]);
    expect(primsFromPolyline([{ x: 1, y: 2 }], false)).toEqual([{ k: 'point', p: { x: 1, y: 2 } }]);
    const prims = primsFromPolyline(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      false,
    );
    expect(prims).toHaveLength(1);
  });

  it('CCW bulge gives a CCW arc with exact stored endpoints', () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 2, y: 0 };
    const arc = arcFromBulge(p0, p1, 1)!;
    expect(arc.k).toBe('arc');
    expect(arc.rev).toBeUndefined();
    expect(arc.p0).toEqual(p0);
    expect(arc.p1).toEqual(p1);
    expect(arc.r).toBeCloseTo(1, 12);
    expect(arcSweep(arc)).toBeCloseTo(Math.PI, 12);
    // CCW from (0,0) to (2,0) around (1,0) passes below the chord.
    const mid = primPointAt(arc, 0.5);
    expect(mid.y).toBeCloseTo(-1, 12);
  });

  it('CW bulge becomes a CCW arc with swapped endpoints and rev flag', () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 2, y: 0 };
    const arc = arcFromBulge(p0, p1, -1)!;
    expect(arc.rev).toBe(true);
    expect(arc.p0).toEqual(p1);
    expect(arc.p1).toEqual(p0);
    expect(arcStart(arc)).toEqual(p1);
    expect(arcEnd(arc)).toEqual(p0);
    expect(primPointAt(arc, 0.5).y).toBeCloseTo(1, 12);
    expect(arcFromBulge(p0, p1, 0)).toBeNull();
  });

  it('polyline with bulges yields arc prims', () => {
    const prims = primsFromPolyline(
      [
        { x: 0, y: 0, bulge: 1 },
        { x: 2, y: 0, bulge: 1 },
      ],
      true,
    );
    expect(prims.map((p) => p.k)).toEqual(['arc', 'arc']);
    const total = prims.reduce((s, p) => s + primLength(p), 0);
    expect(total).toBeCloseTo(2 * Math.PI, 12);
  });
});

describe('primsFromGeometry', () => {
  it('converts every geometry type', () => {
    expect(primsFromGeometry({ type: 'circle', c: { x: 1, y: 2 }, r: 3 })).toEqual([
      { k: 'circle', c: { x: 1, y: 2 }, r: 3 },
    ]);
    expect(primsFromGeometry({ type: 'arc', c: { x: 0, y: 0 }, r: 1, a0: 0, a1: 1 })[0].k).toBe('arc');
    const rect = primsFromGeometry({ type: 'rect', c: { x: 10, y: 20 }, w: 4, h: 2, rot: 0 });
    expect(rect).toHaveLength(4);
    expect(rect[0]).toEqual({ k: 'seg', a: { x: 8, y: 19 }, b: { x: 12, y: 19 } });
    const ell = primsFromGeometry({ type: 'ellipse', c: { x: 0, y: 0 }, rx: 4, ry: 2, rot: Math.PI / 2 });
    expect(ell[0].k).toBe('ellipse');
    const e = ell[0] as Extract<Prim, { k: 'ellipse' }>;
    expect(e.ratio).toBe(0.5);
    expect(e.major.y).toBeCloseTo(4, 12);
    expect(primsFromGeometry({ type: 'ellipse', c: { x: 1, y: 1 }, rx: 0, ry: 2, rot: 0 })[0].k).toBe(
      'point',
    );
    expect(
      primsFromGeometry({
        type: 'polyline',
        pts: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        closed: false,
      }),
    ).toHaveLength(1);
    const mp = primsFromGeometry({
      type: 'multipolygon',
      rings: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
        [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
          { x: 6, y: 6 },
        ],
      ],
    });
    expect(mp).toHaveLength(6);
    expect(primsFromGeometry({ type: 'point', p: { x: 3, y: 4 } })).toEqual([
      { k: 'point', p: { x: 3, y: 4 } },
    ]);
  });
});

describe('primsFromStoreEntity', () => {
  const meta = { type: ET.LINE, layer: 0, color: 0 };
  it('reads every geometry kind with exact numbers', () => {
    const b = new EntityStoreBuilder();
    const line = b.add(meta, GK.LINE, [600000.125, 2500000.25, 600010.5, 2500003.75], B);
    const degenerate = b.add(meta, GK.LINE, [1, 1, 1, 1], B);
    const circle = b.add({ ...meta, type: ET.CIRCLE }, GK.CIRCLE, [5, 6, 7], B);
    const arc = b.add({ ...meta, type: ET.ARC }, GK.ARC, [0, 0, 2, 0, Math.PI / 2], B);
    const ell = b.add({ ...meta, type: ET.ELLIPSE }, GK.ELLIPSE, [0, 0, 3, 0, 0.5, 0, Math.PI], B);
    const poly = b.add(
      { ...meta, type: ET.LWPOLYLINE, flags: FLAG.CLOSED },
      GK.POLY,
      [3, 0, 0, 0, 1, 0, 1, 1, 1, 0],
      B,
    );
    const point = b.add({ ...meta, type: ET.POINT }, GK.POINT, [9, 8], B);
    const text = b.add({ ...meta, type: ET.TEXT }, GK.TEXT, [4, 5, 2.5, 0, 1, 0, 0, 0, 0, 1], B, 'T1');
    const fill = b.add(
      { ...meta, type: ET.HATCH },
      GK.FILL,
      [2, 3, 0, 0, 0, 4, 0, 0, 4, 4, 0, 2, 10, 10, 1, 12, 10, 1],
      B,
    );
    const other = b.add(meta, 99 as never, [1], B);
    const s = b.finish();

    expect(primsFromStoreEntity(s, line)).toEqual([
      { k: 'seg', a: { x: 600000.125, y: 2500000.25 }, b: { x: 600010.5, y: 2500003.75 } },
    ]);
    expect(primsFromStoreEntity(s, degenerate)).toEqual([{ k: 'point', p: { x: 1, y: 1 } }]);
    expect(primsFromStoreEntity(s, circle)).toEqual([{ k: 'circle', c: { x: 5, y: 6 }, r: 7 }]);
    expect(primsFromStoreEntity(s, arc)).toEqual([
      { k: 'arc', c: { x: 0, y: 0 }, r: 2, a0: 0, a1: Math.PI / 2 },
    ]);
    expect(primsFromStoreEntity(s, ell)[0]).toMatchObject({ k: 'ellipse', ratio: 0.5, t1: Math.PI });
    const pp = primsFromStoreEntity(s, poly);
    expect(pp.map((p) => p.k)).toEqual(['seg', 'arc', 'seg']);
    expect(primsFromStoreEntity(s, point)).toEqual([{ k: 'point', p: { x: 9, y: 8 } }]);
    expect(primsFromStoreEntity(s, text)).toEqual([{ k: 'point', p: { x: 4, y: 5 } }]);
    const fp = primsFromStoreEntity(s, fill);
    expect(fp.map((p) => p.k)).toEqual(['seg', 'seg', 'seg', 'arc', 'arc']);
    expect(primsFromStoreEntity(s, other)).toEqual([]);
  });
});

describe('bounds, length, points, endpoints', () => {
  it('segment', () => {
    const s: Prim = { k: 'seg', a: { x: 3, y: 4 }, b: { x: 0, y: 0 } };
    expect(primBounds(s)).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 4 });
    expect(primLength(s)).toBe(5);
    expect(primPointAt(s, 0)).toEqual({ x: 3, y: 4 });
    expect(primPointAt(s, 1)).toEqual({ x: 0, y: 0 });
    expect(primPointAt(s, 0.5)).toEqual({ x: 1.5, y: 2 });
    expect(primEndpoints(s)).toEqual([
      { x: 3, y: 4 },
      { x: 0, y: 0 },
    ]);
    expect(primTangentAt(s, 0.3)).toEqual({ x: -0.6, y: -0.8 });
    expect(primIsClosed(s)).toBe(false);
  });

  it('arc bounds include quadrant extremes inside the span', () => {
    const arc: Prim = { k: 'arc', c: { x: 0, y: 0 }, r: 2, a0: -Math.PI / 4, a1: Math.PI / 4 };
    const b = primBounds(arc);
    expect(b.maxX).toBeCloseTo(2, 12);
    expect(b.minX).toBeCloseTo(Math.SQRT2, 12);
    expect(b.maxY).toBeCloseTo(Math.SQRT2, 12);
    expect(primLength(arc)).toBeCloseTo(Math.PI, 12);
    expect(primEndpoints(arc)[0].x).toBeCloseTo(Math.SQRT2, 12);
    const t = primTangentAt(arc, 0.5);
    expect(t.x).toBeCloseTo(0, 12);
    expect(t.y).toBeCloseTo(1, 12);
  });

  it('circle', () => {
    const c: Prim = { k: 'circle', c: { x: 1, y: 1 }, r: 1 };
    expect(primBounds(c)).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 2 });
    expect(primLength(c)).toBeCloseTo(2 * Math.PI, 12);
    expect(primEndpoints(c)).toEqual([]);
    expect(primPointAt(c, 0.25).y).toBeCloseTo(2, 12);
    expect(primTangentAt(c, 0).y).toBeCloseTo(1, 12);
    expect(primIsClosed(c)).toBe(true);
  });

  it('ellipse: length, bounds, sweep, endpoints', () => {
    const full: Prim = {
      k: 'ellipse',
      c: { x: 0, y: 0 },
      major: { x: 2, y: 0 },
      ratio: 0.5,
      t0: 0,
      t1: 2 * Math.PI,
    };
    expect(isFullEllipse(full)).toBe(true);
    expect(primIsClosed(full)).toBe(true);
    expect(primEndpoints(full)).toEqual([]);
    // Ramanujan II for a = 2, b = 1.
    const a = 2;
    const bb = 1;
    const h = ((a - bb) / (a + bb)) ** 2;
    const ram = Math.PI * (a + bb) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    expect(primLength(full)).toBeCloseTo(ram, 6);
    const bd = primBounds(full);
    expect(bd.maxX).toBeCloseTo(2, 12);
    expect(bd.maxY).toBeCloseTo(1, 12);
    const rotated: Prim = {
      k: 'ellipse',
      c: { x: 0, y: 0 },
      major: { x: 0, y: 3 },
      ratio: 1 / 3,
      t0: 0,
      t1: Math.PI,
    };
    expect(ellipseSweep(rotated)).toBeCloseTo(Math.PI, 12);
    const rb = primBounds(rotated);
    expect(rb.maxY).toBeCloseTo(3, 12);
    expect(rb.minY).toBeCloseTo(-3, 12);
    expect(rb.minX).toBeCloseTo(-1, 12);
    expect(rb.maxX).toBeCloseTo(0, 12);
    const ends = primEndpoints(rotated);
    expect(ends[0].y).toBeCloseTo(3, 12);
    expect(ends[1].y).toBeCloseTo(-3, 12);
    expect(primPointAt(rotated, 0.5).x).toBeCloseTo(-1, 12);
    expect(primTangentAt(rotated, 0).x).toBeCloseTo(-1, 12);
    expect(ellipseArcLength(rotated as Extract<Prim, { k: 'ellipse' }>, 1, 1)).toBe(0);
    // Same start and end parameter means a full ellipse (DXF convention).
    expect(isFullEllipse({ ...(full as Extract<Prim, { k: 'ellipse' }>), t0: 1, t1: 1 })).toBe(true);
  });

  it('point', () => {
    const p: Prim = { k: 'point', p: { x: 7, y: 8 } };
    expect(primBounds(p)).toEqual({ minX: 7, minY: 8, maxX: 7, maxY: 8 });
    expect(primLength(p)).toBe(0);
    expect(primPointAt(p, 0.4)).toEqual({ x: 7, y: 8 });
    expect(primEndpoints(p)).toEqual([{ x: 7, y: 8 }]);
    expect(primTangentAt(p, 0)).toEqual({ x: 0, y: 0 });
  });

  it('span helpers', () => {
    expect(inSpan(0.5, 0, 1)).toBe(true);
    expect(inSpan(1.5, 0, 1)).toBe(false);
    expect(inSpan(-0.1, 0, 2 * Math.PI)).toBe(true);
    expect(spanParam(0.5, 0, 1)).toBe(0.5);
    expect(spanParam(1.2, 0, 1)).toBe(1);
    expect(spanParam(-0.2, 0, 1)).toBe(0);
    expect(spanParam(0, 0, 0)).toBe(0);
    expect(
      unionBounds({ minX: 0, minY: 1, maxX: 2, maxY: 3 }, { minX: -1, minY: 2, maxX: 1, maxY: 5 }),
    ).toEqual({
      minX: -1,
      minY: 1,
      maxX: 2,
      maxY: 5,
    });
  });
});
