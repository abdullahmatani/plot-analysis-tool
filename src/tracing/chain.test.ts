import { describe, expect, it } from 'vitest';

import type { Pt, Vertex } from '@/core/types';
import { polylineSignedArea } from '@/geometry/polyline-edit';
import { primsFromPolyline, type Prim } from '@/geometry/prims';
import { ChainTracer } from './chain';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seg = (a: Pt, b: Pt): Prim => ({ k: 'seg', a, b });
const P = (x: number, y: number): Pt => ({ x, y });

function shuffle<T>(arr: T[], r: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Same cyclic sequence of points (any start), compared exactly. */
function expectSameRing(pts: Vertex[], corners: Pt[]) {
  expect(pts).toHaveLength(corners.length);
  const start = corners.findIndex((c) => c.x === pts[0].x && c.y === pts[0].y);
  expect(start).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < corners.length; i++) {
    const c = corners[(start + i) % corners.length];
    expect({ x: pts[i].x, y: pts[i].y }).toEqual(c);
  }
}

/**
 * Lines along the sides of a polygon: each side cut into `pieces` lines separated by gaps; at each
 * corner one of the two lines reaches the corner exactly and the other stops `cornerGap` short.
 */
function brokenOutline(
  corners: Pt[],
  pieces: number,
  gap: number,
  cornerGap: number,
  r: () => number,
): Prim[] {
  const out: Prim[] = [];
  const n = corners.length;
  for (let s = 0; s < n; s++) {
    const a = corners[s];
    const b = corners[(s + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    for (let k = 0; k < pieces; k++) {
      const t0 = (k / pieces) * len + (k > 0 ? gap / 2 : cornerGap);
      const t1 = ((k + 1) / pieces) * len - (k < pieces - 1 ? gap / 2 : 0);
      const p0 = k === 0 && cornerGap === 0 ? a : { x: a.x + ux * t0, y: a.y + uy * t0 };
      const p1 = k === pieces - 1 ? b : { x: a.x + ux * t1, y: a.y + uy * t1 };
      out.push(r() < 0.5 ? seg(p0, p1) : seg(p1, p0));
    }
  }
  return shuffle(out, r);
}

describe('ChainTracer: building outlines', () => {
  const ox = 612000.25;
  const oy = 2534000.5;
  const rect = [P(ox, oy), P(ox + 30, oy), P(ox + 30, oy + 20), P(ox, oy + 20)];

  it('4 exact lines → closed CCW polygon with the exact corners', () => {
    const prims = [
      seg(rect[2], rect[3]),
      seg(rect[0], rect[1]),
      seg(rect[3], rect[0]),
      seg(rect[2], rect[1]),
    ];
    const t = new ChainTracer(prims, { gapTol: 0.05 });
    const s = t.start(1, P(ox + 10, oy));
    expect(s.status).toBe('closed');
    expect(s.closed).toBe(true);
    expect(s.junction).toBeNull();
    expectSameRing(s.pts, rect);
    expect(polylineSignedArea(s.pts)).toBeCloseTo(600, 6);
    expect([...s.primIndices].sort()).toEqual([0, 1, 2, 3]);
  });

  it('4–12 separate lines with gaps up to gapTol → one closed polygon with exact corners', () => {
    const r = rng(42);
    for (const pieces of [1, 2, 3]) {
      for (let trial = 0; trial < 10; trial++) {
        const prims = brokenOutline(rect, pieces, 0.02 + r() * 0.03, 0.01 + r() * 0.03, r);
        const t = new ChainTracer(prims, { gapTol: 0.05 });
        const startIdx = Math.floor(r() * prims.length);
        const s = t.start(startIdx, P(ox + 1, oy + 1));
        expect(s.status).toBe('closed');
        expect(s.primIndices).toHaveLength(prims.length);
        expectSameRing(s.pts, rect);
        expect(polylineSignedArea(s.pts)).toBeGreaterThan(0);
      }
    }
  });

  it('rotated outline: corners reached by one line stay exact', () => {
    const r = rng(7);
    const c = P(600123.456, 2500789.012);
    const ang = 0.4636;
    const corners = [P(-15, -10), P(15, -10), P(15, 10), P(-15, 10)].map((p) => ({
      x: c.x + p.x * Math.cos(ang) - p.y * Math.sin(ang),
      y: c.y + p.x * Math.sin(ang) + p.y * Math.cos(ang),
    }));
    const prims = brokenOutline(corners, 3, 0.03, 0.04, r);
    const s = new ChainTracer(prims, { gapTol: 0.05 }).start(0, c);
    expect(s.status).toBe('closed');
    expectSameRing(s.pts, corners);
  });

  it('both lines short of an axis-aligned corner: the corner is rebuilt exactly', () => {
    const prims = [
      seg(P(ox + 0.02, oy), P(ox + 29.98, oy)),
      seg(P(ox + 30, oy + 0.03), P(ox + 30, oy + 19.97)),
      seg(P(ox + 29.96, oy + 20), P(ox + 0.04, oy + 20)),
      seg(P(ox, oy + 19.99), P(ox, oy + 0.01)),
    ];
    const s = new ChainTracer(prims, { gapTol: 0.05 }).start(0, P(ox + 5, oy));
    expect(s.status).toBe('closed');
    expectSameRing(s.pts, rect);
  });

  it('result() is consistent with the state and clockwise inputs are normalised to CCW', () => {
    const prims = [
      seg(rect[0], rect[3]),
      seg(rect[3], rect[2]),
      seg(rect[2], rect[1]),
      seg(rect[1], rect[0]),
    ];
    const t = new ChainTracer(prims, { gapTol: 0 });
    const s = t.start(0, P(ox, oy + 5));
    const res = t.result();
    expect(res.pts).toEqual(s.pts);
    expect(res.closed).toBe(true);
    expect(polylineSignedArea(res.pts)).toBeGreaterThan(0);
  });
});

describe('ChainTracer: junctions', () => {
  // A T: a–b–c along y = 0, with a branch b–d upwards; d continues to e.
  const a = P(0, 0);
  const b = P(10, 0);
  const c = P(20, 0);
  const d = P(10, 10);
  const e = P(15, 15);
  const prims: Prim[] = [seg(a, b), seg(b, c), seg(b, d), seg(d, e)];

  it('stops at a T-junction and offers alternatives (straightest first)', () => {
    const t = new ChainTracer(prims, { gapTol: 0.01 });
    const s = t.start(0, P(8, 0));
    expect(s.status).toBe('junction');
    expect(s.closed).toBe(false);
    expect(s.pts).toEqual([a, b]);
    expect(s.junction!.side).toBe('end');
    expect(s.junction!.at).toEqual(b);
    expect(s.junction!.alternatives.map((x) => x.primIndex)).toEqual([1, 2]);
    expect(s.junction!.current).toBe(0);
    // Previews show where auto-follow would go.
    expect(s.junction!.alternatives[0].preview).toEqual([b, c]);
    expect(s.junction!.alternatives[1].preview).toEqual([b, d, e]);
    // Tab cycles.
    const s2 = t.cycle();
    expect(s2.junction!.current).toBe(1);
    expect(t.cycle().junction!.current).toBe(0);
    t.cycle();
    const s3 = t.accept();
    expect(s3.status).toBe('open');
    expect(s3.pts).toEqual([a, b, d, e]);
    expect(s3.primIndices).toEqual([0, 2, 3]);
    // Nothing to cycle or accept any more.
    expect(t.cycle().status).toBe('open');
    expect(t.accept().status).toBe('open');
  });

  it('accepting the straight alternative merges the collinear joint', () => {
    const t = new ChainTracer(prims, { gapTol: 0.01 });
    t.start(0, P(8, 0));
    const s = t.accept();
    expect(s.pts).toEqual([a, c]);
    expect(s.primIndices).toEqual([0, 1]);
    const raw = new ChainTracer(prims, { gapTol: 0.01, mergeCollinear: false });
    raw.start(0, P(8, 0));
    expect(raw.accept().pts).toEqual([a, b, c]);
  });

  it('junction on the start side; skip() stops there', () => {
    const t = new ChainTracer(prims, { gapTol: 0.01 });
    // Start on b–d, picked near d: walks to e (dead end), then the start side hits the junction at b.
    const s = t.start(2, P(10, 9));
    expect(s.status).toBe('junction');
    expect(s.junction!.side).toBe('start');
    expect(s.junction!.at).toEqual(b);
    expect(s.pts[s.pts.length - 1]).toEqual(e);
    const s2 = t.skip();
    expect(s2.status).toBe('open');
    expect(s2.junction).toBeNull();
    expect(s2.pts).toEqual([b, d, e]);
  });

  it('accepting continues until closure (house outline with an internal wall)', () => {
    // Square with a wall from the middle of the bottom side to the middle of the top side.
    const q = [P(0, 0), P(5, 0), P(10, 0), P(10, 10), P(5, 10), P(0, 10)];
    const ps: Prim[] = [
      seg(q[0], q[1]),
      seg(q[1], q[2]),
      seg(q[2], q[3]),
      seg(q[3], q[4]),
      seg(q[4], q[5]),
      seg(q[5], q[0]),
      seg(q[1], q[4]),
    ];
    const t = new ChainTracer(ps, { gapTol: 0 });
    let s = t.start(2, P(10, 5));
    expect(s.status).toBe('junction');
    // Choose the outer wall at each junction (the straight alternative comes first).
    let guard = 0;
    while (s.status === 'junction' && guard++ < 5) s = t.accept();
    expect(s.status).toBe('closed');
    expect(s.pts).toHaveLength(4);
    expect(polylineSignedArea(s.pts)).toBeCloseTo(100, 9);
  });
});

describe('ChainTracer: arcs, circles, ellipses, points', () => {
  it('arcs become exact bulge vertices (rounded rectangle from LINE + ARC prims)', () => {
    const r = 2;
    const prims: Prim[] = [
      seg(P(2, 0), P(8, 0)),
      { k: 'arc', c: P(8, 2), r, a0: -Math.PI / 2, a1: 0 },
      seg(P(10, 2), P(10, 8)),
      { k: 'arc', c: P(8, 8), r, a0: 0, a1: Math.PI / 2 },
      seg(P(8, 10), P(2, 10)),
      { k: 'arc', c: P(2, 8), r, a0: Math.PI / 2, a1: Math.PI },
      seg(P(0, 8), P(0, 2)),
      { k: 'arc', c: P(2, 2), r, a0: Math.PI, a1: (3 * Math.PI) / 2 },
    ];
    const s = new ChainTracer(prims, { gapTol: 1e-6 }).start(0, P(5, 0));
    expect(s.status).toBe('closed');
    expect(s.pts).toHaveLength(8);
    const bulges = s.pts.filter((v) => v.bulge).map((v) => v.bulge!);
    expect(bulges).toHaveLength(4);
    for (const bl of bulges) expect(bl).toBeCloseTo(Math.tan(Math.PI / 8), 12);
    expect(polylineSignedArea(s.pts)).toBeCloseTo(100 - (4 - Math.PI) * r * r, 9);
  });

  it('polyline prims with clockwise arcs keep their direction when traced', () => {
    const pts: Vertex[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0, bulge: -0.4 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const prims = primsFromPolyline(pts, true);
    const t = new ChainTracer(prims, { gapTol: 0 });
    const s = t.start(0, P(5, 0));
    expect(s.status).toBe('closed');
    expect(polylineSignedArea(s.pts)).toBeCloseTo(polylineSignedArea(pts), 9);
    const arcV = s.pts.find((v) => v.bulge)!;
    expect(Math.abs(arcV.bulge!)).toBeCloseTo(0.4, 12);
  });

  it('a circle traces to a closed two-vertex bulge polyline with the exact radius', () => {
    const c = P(612345.678, 2534210.125);
    const t = new ChainTracer([{ k: 'circle', c, r: 7.5 }], { gapTol: 0.05 });
    const s = t.start(0, P(c.x + 7.5, c.y));
    expect(s.status).toBe('closed');
    expect(s.pts).toEqual([
      { x: c.x + 7.5, y: c.y, bulge: 1 },
      { x: c.x - 7.5, y: c.y, bulge: 1 },
    ]);
  });

  it('a nearly closed arc closes on itself; a full ellipse is tessellated', () => {
    const arc: Prim = { k: 'arc', c: P(0, 0), r: 5, a0: 0.001, a1: 2 * Math.PI - 0.001 };
    const s = new ChainTracer([arc], { gapTol: 0.05 }).start(0, P(5, 0));
    expect(s.status).toBe('closed');
    expect(s.pts).toHaveLength(2);
    expect(Math.abs(polylineSignedArea(s.pts) - Math.PI * 25)).toBeLessThan(0.1);
    const e: Prim = { k: 'ellipse', c: P(0, 0), major: P(4, 0), ratio: 0.5, t0: 0, t1: 2 * Math.PI };
    const se = new ChainTracer([e], { gapTol: 0, chordTol: 1e-4 }).start(0, P(4, 0));
    expect(se.status).toBe('closed');
    expect(se.pts.length).toBeGreaterThan(50);
    expect(polylineSignedArea(se.pts)).toBeCloseTo(Math.PI * 8, 2);
  });

  it('ellipse arcs inside a chain are tessellated between exact neighbours', () => {
    const e: Prim = { k: 'ellipse', c: P(0, 0), major: P(4, 0), ratio: 0.5, t0: 0, t1: Math.PI };
    const prims: Prim[] = [e, seg(P(-4, 0), P(4, 0))];
    const s = new ChainTracer(prims, { gapTol: 1e-9 }).start(1, P(0, 0));
    expect(s.status).toBe('closed');
    expect(s.pts.length).toBeGreaterThan(10);
    expect(polylineSignedArea(s.pts)).toBeCloseTo(Math.PI * 4, 2);
    // Walking the ellipse backwards (start on it from the other side).
    const s2 = new ChainTracer(prims, { gapTol: 1e-9 }).start(0, P(-3.9, 0.3));
    expect(polylineSignedArea(s2.pts)).toBeCloseTo(Math.PI * 4, 2);
  });

  it('points and open dead ends', () => {
    const t = new ChainTracer([{ k: 'point', p: P(1, 2) }, seg(P(0, 0), P(1, 0)), seg(P(1, 0), P(1, 1))], {
      gapTol: 0,
    });
    const s = t.start(0, P(1, 2));
    expect(s.status).toBe('open');
    expect(s.pts).toEqual([P(1, 2)]);
    const s2 = t.start(1, P(0.1, 0));
    expect(s2.status).toBe('open');
    expect(s2.pts).toEqual([P(1, 1), P(1, 0), P(0, 0)]);
    expect(() => t.start(9, P(0, 0))).toThrow(RangeError);
  });

  it('a tiny segment whose ends collapse into one node traces alone', () => {
    const t = new ChainTracer([seg(P(0, 0), P(0.001, 0)), seg(P(0.001, 0), P(5, 0))], { gapTol: 0.01 });
    const s = t.start(0, P(0, 0));
    expect(s.primIndices).toEqual([0]);
    expect(s.status).toBe('open');
    expect(s.pts).toEqual([P(0, 0), P(0.001, 0)]);
  });
});

describe('ChainTracer: stepwise walking (cancellable auto-follow)', () => {
  // A long open line drawn as 2000 pieces, with a T branch half-way.
  const N = 2000;
  const prims: Prim[] = [];
  for (let i = 0; i < N; i++) prims.push(seg(P(i, Math.sin(i)), P(i + 1, Math.sin(i + 1))));
  prims.push(seg(P(1000, Math.sin(1000)), P(1000, 50)));

  it('advance() in small budgets gives the same chain as start()', () => {
    const ref = new ChainTracer(prims, { gapTol: 1e-6 }).start(10, P(10.5, 0));
    const t = new ChainTracer(prims, { gapTol: 1e-6 });
    t.begin(10, P(10.5, 0));
    let calls = 1;
    while (!t.advance(64)) calls++;
    expect(calls).toBeGreaterThan(10);
    expect(t.current()).toEqual(ref);
    expect(t.current().status).toBe('junction');
  });

  it('auto mode takes the straightest way at junctions', () => {
    const t = new ChainTracer(prims, { gapTol: 1e-6 });
    t.begin(10, P(10.5, 0), true);
    while (!t.advance(100));
    const s = t.current();
    expect(s.status).toBe('open');
    expect(s.primIndices).toHaveLength(N);
  });

  it('a very long straight line in 100 000 collinear pieces, picked in the middle, traces in linear time', () => {
    const M = 100_000;
    const pieces = Array.from({ length: M }, (_, i) => seg(P(i, 0), P(i + 1, 0)));
    const t0 = performance.now();
    const s = new ChainTracer(pieces, { gapTol: 1e-6 }).start(M / 2, P(M / 2 + 0.5, 0));
    expect(s.pts).toEqual([P(0, 0), P(M, 0)]);
    expect(s.primIndices).toHaveLength(M);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('abort() during a fresh walk leaves an empty chain; during accept it restores the junction', () => {
    const t = new ChainTracer(prims, { gapTol: 1e-6 });
    t.begin(10, P(10.5, 0));
    expect(t.advance(50)).toBe(false);
    t.abort();
    expect(t.current().pts).toEqual([]);

    const atJunction = t.start(10, P(10.5, 0));
    t.beginAccept(); // the straight way: ~1000 more pieces
    expect(t.advance(5)).toBe(false);
    t.abort();
    expect(t.current()).toEqual(atJunction);
    // The restored tracer still works.
    expect(t.accept().status).toBe('open');
  });
});
