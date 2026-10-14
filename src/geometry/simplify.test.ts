import { describe, expect, it } from 'vitest';

import type { Vertex } from '@/core/types';
import { distToSegment, removeDuplicateVertices, simplifyPolyline } from './simplify';

/** Deterministic PRNG (mulberry32). */
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

/** Maps output vertices back to input indices (must be an increasing subsequence with equal numbers). */
function indicesOf(input: Vertex[], output: Vertex[]): number[] {
  const idx: number[] = [];
  let k = 0;
  for (const v of output) {
    while (k < input.length && (input[k].x !== v.x || input[k].y !== v.y)) k++;
    expect(k).toBeLessThan(input.length);
    idx.push(k);
    k++;
  }
  return idx;
}

function checkGuarantee(input: Vertex[], output: Vertex[], closed: boolean, tol: number) {
  const idx = indicesOf(input, output);
  const n = input.length;
  if (!closed) {
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(n - 1);
  } else {
    expect(output.length).toBeGreaterThanOrEqual(Math.min(3, n));
  }
  const spans = closed ? idx.length : idx.length - 1;
  for (let s = 0; s < spans; s++) {
    const i = idx[s];
    const j = s + 1 < idx.length ? idx[s + 1] : idx[0] + n;
    const a = input[i % n];
    const b = input[j % n];
    // Every removed vertex lies within tol of the segment that replaced it.
    for (let k = i + 1; k < j; k++) expect(distToSegment(input[k % n], a, b)).toBeLessThanOrEqual(tol);
    // Arc segments survive unchanged.
    if (input[i % n].bulge) {
      expect(j).toBe(i + 1);
      expect(output[s].bulge).toBe(input[i % n].bulge);
    } else if (j > i + 1) {
      expect(output[s].bulge ?? 0).toBe(0);
    }
  }
}

function randomWalk(r: () => number, n: number, ox = 0, oy = 0, arcs = false): Vertex[] {
  const pts: Vertex[] = [];
  let x = ox;
  let y = oy;
  let heading = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    heading += (r() - 0.5) * 0.8;
    const step = 0.05 + r() * 2;
    x += Math.cos(heading) * step;
    y += Math.sin(heading) * step;
    const v: Vertex = { x, y };
    if (arcs && r() < 0.1) v.bulge = (r() - 0.5) * 1.5;
    pts.push(v);
  }
  return pts;
}

describe('distToSegment', () => {
  it('handles projections and degenerate segments', () => {
    expect(distToSegment({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(1);
    expect(distToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(5);
    expect(distToSegment({ x: 5, y: 4 }, { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(5);
    expect(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('removeDuplicateVertices', () => {
  it('removes consecutive duplicates and closing duplicates, keeping bulges sensible', () => {
    const pts: Vertex[] = [
      { x: 0, y: 0 },
      { x: 0, y: 0, bulge: 0.5 },
      { x: 10, y: 0 },
      { x: 10.0005, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 0.0001 },
    ];
    expect(removeDuplicateVertices(pts, false)).toEqual([
      { x: 0, y: 0, bulge: 0.5 },
      { x: 10, y: 0 },
      { x: 10.0005, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 0.0001 },
    ]);
    expect(removeDuplicateVertices(pts, true, 0.001)).toEqual([
      { x: 0, y: 0, bulge: 0.5 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(removeDuplicateVertices([], true)).toEqual([]);
    expect(
      removeDuplicateVertices(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        true,
      ),
    ).toEqual([{ x: 1, y: 1 }]);
  });

  it('does not mutate the input', () => {
    const pts: Vertex[] = [
      { x: 0, y: 0, bulge: 1 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    const copy = JSON.parse(JSON.stringify(pts));
    removeDuplicateVertices(pts, false);
    expect(pts).toEqual(copy);
  });
});

describe('simplifyPolyline', () => {
  it('removes collinear and near-collinear vertices only within tolerance', () => {
    const pts: Vertex[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0.001 },
      { x: 2, y: 0 },
      { x: 3, y: 0.5 },
      { x: 4, y: 0 },
    ];
    const out = simplifyPolyline(pts, false, 0.01);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0.5 },
      { x: 4, y: 0 },
    ]);
    expect(simplifyPolyline(pts, false, 0)).toHaveLength(5);
    expect(simplifyPolyline(pts, false, 1)).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]);
  });

  it('measures distance to the segment, not the infinite line (spikes survive)', () => {
    const pts: Vertex[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 10, y: 0 },
      { x: 2, y: 0 },
    ];
    const out = simplifyPolyline(pts, false, 0.1);
    expect(out.some((v) => v.x === 10)).toBe(true);
  });

  it('keeps arc segments and their endpoints', () => {
    const pts: Vertex[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0, bulge: 0.4 },
      { x: 4, y: 0 },
      { x: 5, y: 0 },
      { x: 6, y: 0 },
    ];
    const out = simplifyPolyline(pts, false, 0.5);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0, bulge: 0.4 },
      { x: 4, y: 0 },
      { x: 6, y: 0 },
    ]);
  });

  it('closed rings choose anchors and keep at least three vertices', () => {
    const square: Vertex[] = [];
    for (let i = 0; i < 10; i++) square.push({ x: i, y: 0 });
    for (let i = 0; i < 10; i++) square.push({ x: 10, y: i });
    for (let i = 0; i < 10; i++) square.push({ x: 10 - i, y: 10 });
    for (let i = 0; i < 10; i++) square.push({ x: 0, y: 10 - i });
    const out = simplifyPolyline(square, true, 1e-9);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    // A very flat ring: tolerance would allow two vertices, but three are kept.
    const flat: Vertex[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0.01 },
      { x: 10, y: 0 },
      { x: 5, y: -0.01 },
    ];
    const f = simplifyPolyline(flat, true, 1);
    expect(f.length).toBe(3);
    checkGuarantee(flat, f, true, 1);
    // Small inputs and degenerate rings are returned unchanged.
    expect(simplifyPolyline(flat.slice(0, 3), true, 1)).toHaveLength(3);
    const same = [
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
    ];
    expect(simplifyPolyline(same, true, 1)).toHaveLength(4);
    expect(simplifyPolyline(flat, false, Number.NaN)).toHaveLength(4);
  });

  it('closed rings with arcs use arc-adjacent vertices as anchors', () => {
    const pts: Vertex[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0.001 },
      { x: 10, y: 0, bulge: 1 },
      { x: 10, y: 10 },
      { x: 5, y: 10.001 },
      { x: 0, y: 10 },
    ];
    const out = simplifyPolyline(pts, true, 0.01);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0, bulge: 1 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    checkGuarantee(pts, out, true, 0.01);
  });

  it('property: random open/closed polylines never exceed the tolerance (incl. UTM coordinates and arcs)', () => {
    const r = rng(20261014);
    for (let iter = 0; iter < 300; iter++) {
      const n = 3 + Math.floor(r() * 200);
      const utm = iter % 3 === 0;
      const pts = randomWalk(r, n, utm ? 612345.678 : 0, utm ? 2534210.123 : 0, iter % 4 === 1);
      const tol = r() < 0.1 ? 0 : 10 ** (-3 + r() * 3.5);
      for (const closed of [false, true]) {
        const out = simplifyPolyline(pts, closed, tol);
        checkGuarantee(pts, out, closed, tol);
        expect(out.length).toBeLessThanOrEqual(pts.length);
      }
    }
  });

  it('property: noisy circles reduce strongly and stay within tolerance', () => {
    const r = rng(7);
    for (let iter = 0; iter < 50; iter++) {
      const n = 500;
      const R = 10 + r() * 100;
      const pts: Vertex[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = R + (r() - 0.5) * 0.01;
        pts.push({ x: 600000 + rr * Math.cos(a), y: 2500000 + rr * Math.sin(a) });
      }
      const tol = 0.05;
      const out = simplifyPolyline(pts, true, tol);
      checkGuarantee(pts, out, true, tol);
      expect(out.length).toBeLessThan(n / 2);
    }
  });

  it('handles 100 000 vertices without recursion limits', () => {
    const r = rng(1);
    const pts = randomWalk(r, 100000);
    const out = simplifyPolyline(pts, false, 0.5);
    expect(out.length).toBeGreaterThan(2);
    expect(out[0]).toEqual(pts[0]);
  });
});
