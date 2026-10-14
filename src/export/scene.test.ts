import { describe, expect, it } from 'vitest';

import type { Pt } from '@/core/types';
import { arcToBulge } from '@/geometry/bulge';

import {
  SceneBuilder,
  arcPath,
  arcSweepToCubics,
  arcToCubics,
  bulgePolylineToPath,
  circlePath,
  ellipsePath,
  ellipseToCubics,
  flattenPath,
  pathBounds,
  rectPath,
  transformPath,
  walkScene,
} from './scene';
import type { PathCmd } from './scene';

type C = Extract<PathCmd, { op: 'C' }>;

function bez(p0: Pt, c: C, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
    y: u * u * u * p0.y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
  };
}

/** Max |dist(curve, centre) − r| / r over dense samples of every cubic. */
function maxRadialError(start: Pt, cubics: PathCmd[], cx: number, cy: number, r: number): number {
  let p0 = start;
  let err = 0;
  for (const c of cubics) {
    if (c.op !== 'C') throw new Error('expected cubic');
    for (let i = 0; i <= 200; i++) {
      const p = bez(p0, c, i / 200);
      err = Math.max(err, Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) / r);
    }
    p0 = { x: c.x, y: c.y };
  }
  return err;
}

describe('arcToCubics', () => {
  it.each([
    [0, Math.PI / 2, true],
    [0.3, 2.9, true],
    [1, -2, false],
    [0, 2 * Math.PI, true],
    [5, 5, false],
    [-1, 4, true],
  ])('a0=%s a1=%s ccw=%s stays within 1e-6·r and ≤ 90° per segment', (a0, a1, ccw) => {
    const cx = 123456.789;
    const cy = -9876.5;
    const r = 250.25;
    const cubics = arcToCubics(cx, cy, r, a0, a1, ccw);
    const start = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
    expect(maxRadialError(start, cubics, cx, cy, r)).toBeLessThan(1e-6);
    // end point exact (to fp), segment sweep ≤ 90°
    const last = cubics[cubics.length - 1] as C;
    expect(last.x).toBeCloseTo(cx + r * Math.cos(a1), 6);
    expect(last.y).toBeCloseTo(cy + r * Math.sin(a1), 6);
    let prev = Math.atan2(start.y - cy, start.x - cx);
    for (const c of cubics as C[]) {
      const a = Math.atan2(c.y - cy, c.x - cx);
      let d = Math.abs(a - prev);
      if (d > Math.PI) d = 2 * Math.PI - d;
      expect(d).toBeLessThanOrEqual(Math.PI / 2 + 1e-12);
      prev = a;
    }
  });

  it('runs in the requested direction', () => {
    const ccw = arcToCubics(0, 0, 1, 0, Math.PI / 2, true);
    const cw = arcToCubics(0, 0, 1, 0, Math.PI / 2, false);
    // CCW quarter: first control point heads towards +y; CW three-quarter heads towards -y.
    expect((ccw[0] as C).y1).toBeGreaterThan(0);
    expect((cw[0] as C).y1).toBeLessThan(0);
    expect(ccw.length).toBe(3);
    expect(cw.length).toBe(9);
  });

  it('honours a custom maximum segment angle (90° = 4 cubics per circle)', () => {
    expect(arcSweepToCubics(0, 0, 1, 0, 2 * Math.PI, Math.PI / 2)).toHaveLength(4);
    expect(arcSweepToCubics(0, 0, 0, 0, 1)).toHaveLength(0);
  });

  it('arcPath starts with a move to the start point', () => {
    const p = arcPath(10, 10, 5, 0, Math.PI, true);
    expect(p[0]).toEqual({ op: 'M', x: 15, y: 10 });
  });
});

describe('ellipse', () => {
  it('ellipse cubics stay on the ellipse', () => {
    const rx = 40;
    const ry = 10;
    const rot = 0.7;
    const cubics = ellipseToCubics(5, 6, rx, ry, rot, 0.2, 2.5, true);
    let p0: Pt = {
      x: 5 + rx * Math.cos(0.2) * Math.cos(rot) - ry * Math.sin(0.2) * Math.sin(rot),
      y: 6 + rx * Math.cos(0.2) * Math.sin(rot) + ry * Math.sin(0.2) * Math.cos(rot),
    };
    let worst = 0;
    for (const c of cubics as C[]) {
      for (let i = 0; i <= 50; i++) {
        const p = bez(p0, c, i / 50);
        // back to ellipse frame
        const dx = p.x - 5;
        const dy = p.y - 6;
        const u = dx * Math.cos(rot) + dy * Math.sin(rot);
        const v = -dx * Math.sin(rot) + dy * Math.cos(rot);
        worst = Math.max(worst, Math.abs(Math.hypot(u / rx, v / ry) - 1));
      }
      p0 = { x: c.x, y: c.y };
    }
    expect(worst).toBeLessThan(1e-6);
    const full = ellipsePath(0, 0, 2, 1);
    expect(full[0].op).toBe('M');
    expect(full[full.length - 1].op).toBe('Z');
  });
});

describe('bulgePolylineToPath', () => {
  it('converts a semicircle bulge exactly and maps vertices exactly', () => {
    const scale = 1 / 0.5; // 1 world unit → 2 mm, y flipped
    const toPaper = (p: Pt): [number, number] => [100 + p.x * scale, 50 - p.y * scale];
    const path = bulgePolylineToPath(
      [
        { x: 0, y: 0, bulge: 1 },
        { x: 10, y: 0 },
      ],
      false,
      toPaper,
    );
    expect(path[0]).toEqual({ op: 'M', x: 100, y: 50 });
    const last = path[path.length - 1] as C;
    expect([last.x, last.y]).toEqual([120, 50]);
    // On paper the arc has centre (110, 50), radius 10, and (bulge > 0 = CCW in world, y flipped)
    // it passes through the world point (5, -5) → paper (110, 60).
    const err = maxRadialError({ x: 100, y: 50 }, path.slice(1), 110, 50, 10);
    expect(err).toBeLessThan(1e-6);
    const ys = (path.slice(1) as C[]).map((c) => c.y);
    expect(Math.max(...ys)).toBeCloseTo(60, 9);
  });

  it('handles closed polylines with mixed straight and arc segments', () => {
    const id = (p: Pt): [number, number] => [p.x, p.y];
    const b = arcToBulge({ x: 5, y: 5 }, { x: 10, y: 5 }, { x: 5, y: 10 }, true);
    const path = bulgePolylineToPath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5, bulge: b },
        { x: 5, y: 10 },
        { x: 0, y: 10 },
      ],
      true,
      id,
    );
    expect(path[0].op).toBe('M');
    expect(path[path.length - 1].op).toBe('Z');
    expect(path.filter((c) => c.op === 'C')).toHaveLength(3); // 90° → 3 × 30°
    // closing straight edge back to the start is implied by Z
    expect(path.filter((c) => c.op === 'L')).toHaveLength(3);
    expect(bulgePolylineToPath([], true, id)).toEqual([]);
  });
});

describe('path helpers', () => {
  it('rect / circle / bounds / transform', () => {
    expect(rectPath(1, 2, 3, 4)).toHaveLength(5);
    expect(pathBounds(rectPath(1, 2, 3, 4))).toEqual({ minX: 1, minY: 2, maxX: 4, maxY: 6 });
    const rounded = rectPath(0, 0, 10, 6, 2);
    expect(rounded.filter((c) => c.op === 'C').length).toBe(12);
    const b = pathBounds(rounded)!;
    expect(b.minX).toBeCloseTo(0, 12);
    expect(b.maxY).toBeCloseTo(6, 12);
    const circle = circlePath(0, 0, 10);
    expect(circle.filter((c) => c.op === 'C')).toHaveLength(12);
    const t = transformPath([{ op: 'M', x: 1, y: 1 }], [2, 0, 0, 3, 10, 20]);
    expect(t[0]).toEqual({ op: 'M', x: 12, y: 23 });
    expect(pathBounds([])).toBeNull();
  });

  it('flattenPath respects the tolerance', () => {
    const r = 50;
    const flat = flattenPath(circlePath(0, 0, r), 0.01);
    expect(flat).toHaveLength(1);
    expect(flat[0].closed).toBe(true);
    for (let i = 0; i < flat[0].points.length; i++) {
      const a = flat[0].points[i];
      const b = flat[0].points[(i + 1) % flat[0].points.length];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      expect(r - Math.hypot(m.x, m.y)).toBeLessThan(0.0101);
    }
  });
});

describe('SceneBuilder', () => {
  it('builds nested groups and validates balance', () => {
    const s = new SceneBuilder(420, 297, { background: '#ffffff', meta: { title: 'T' } })
      .rect(0, 0, 10, 10, { color: '#000000', width: 0.25 })
      .layer('Analysis', (b) => {
        b.circle(50, 50, 10, undefined, { color: '#ff0000', opacity: 0.3 });
        b.group('labels', {}, (g) => g.text('A', 50, 50, { anchor: 'middle' }));
      })
      .build();
    expect(s.items).toHaveLength(2);
    const names: string[] = [];
    walkScene(s.items, (it, parents) => {
      if (it.kind === 'text') names.push(parents.map((p) => p.name).join('/'));
    });
    expect(names).toEqual(['Analysis/labels']);
    expect(s.background).toBe('#ffffff');
    expect(() => new SceneBuilder(1, 1).beginGroup('x').build()).toThrow();
    expect(() => new SceneBuilder(1, 1).endGroup()).toThrow();
  });
});
