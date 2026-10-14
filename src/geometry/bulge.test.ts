import { describe, expect, it } from 'vitest';

import { arcToBulge, bulgeToArc, segmentLength, tessellatePolyline } from './bulge';

describe('bulge', () => {
  it('semicircle bulge gives the right centre and radius', () => {
    const arc = bulgeToArc({ x: 0, y: 0 }, { x: 2, y: 0 }, 1)!;
    expect(arc.c.x).toBeCloseTo(1, 12);
    expect(arc.c.y).toBeCloseTo(0, 12);
    expect(arc.r).toBeCloseTo(1, 12);
    expect(segmentLength({ x: 0, y: 0 }, { x: 2, y: 0 }, 1)).toBeCloseTo(Math.PI, 12);
  });

  it('round-trips arc ↔ bulge', () => {
    const c = { x: 5, y: -3 };
    const p0 = { x: c.x + 10, y: c.y };
    const p1 = { x: c.x, y: c.y + 10 };
    const b = arcToBulge(c, p0, p1, true);
    expect(b).toBeCloseTo(Math.tan(Math.PI / 8), 12);
    const arc = bulgeToArc(p0, p1, b)!;
    expect(arc.c.x).toBeCloseTo(c.x, 9);
    expect(arc.c.y).toBeCloseTo(c.y, 9);
    expect(arc.r).toBeCloseTo(10, 9);
  });

  it('tessellation stays within chord tolerance', () => {
    const pts = tessellatePolyline(
      [
        { x: 0, y: 0, bulge: 1 },
        { x: 100, y: 0, bulge: 1 },
      ],
      true,
      0.005,
    );
    for (const p of pts) expect(Math.abs(Math.hypot(p.x - 50, p.y) - 50)).toBeLessThan(1e-9);
    // Max sagitta between consecutive points is ≤ tolerance.
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      expect(50 - Math.hypot(m.x - 50, m.y)).toBeLessThanOrEqual(0.005 + 1e-9);
    }
  });
});
