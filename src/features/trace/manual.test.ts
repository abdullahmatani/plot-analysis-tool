import { describe, expect, it } from 'vitest';

import type { Pt, Vertex } from '@/core/types';
import { bulgeToArc } from '@/geometry/bulge';

import { endTangent, lastTangent, tangentBulge, threePointBulge } from './arcs';
import { applyBackspace, applyClick, segmentBulge, type ManualTraceState } from './manual-tool';

/** Manual trace (row 49): exact vertices, 3-point and tangent arcs, close, Backspace. */

const state = (
  points: Vertex[],
  mode: ManualTraceState['mode'] = 'line',
  mid: Pt | null = null,
): ManualTraceState => ({
  points,
  mode,
  mid,
});

describe('arc helpers', () => {
  it('end tangent of lines and arcs', () => {
    expect(endTangent({ x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({ x: 1, y: 0 });
    // Half circle from (0,0) to (10,0) bulging below (CCW): arrives heading up.
    const t = endTangent({ x: 0, y: 0 }, { x: 10, y: 0 }, 1)!;
    expect(t.x).toBeCloseTo(0, 15);
    expect(t.y).toBeCloseTo(1, 15);
    expect(lastTangent([{ x: 0, y: 0 }])).toBeNull();
  });

  it('a tangent arc continues the previous segment smoothly and ends at the click', () => {
    const p = { x: 612000.5, y: 2534000.25 };
    for (const [dir, q] of [
      [
        { x: 1, y: 0 },
        { x: p.x + 10, y: p.y + 10 },
      ],
      [
        { x: 0, y: 1 },
        { x: p.x - 3, y: p.y + 1 },
      ],
      [
        { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
        { x: p.x - 5, y: p.y - 20 },
      ],
    ] as [Pt, Pt][]) {
      const b = tangentBulge(p, dir, q)!;
      const arc = bulgeToArc(p, q, b)!;
      // The tangent at the arc start is perpendicular to the radius and points along `dir`.
      const rx = p.x - arc.c.x;
      const ry = p.y - arc.c.y;
      expect((rx * dir.x + ry * dir.y) / Math.hypot(rx, ry)).toBeCloseTo(0, 9);
      const startTangent = endTangent(q, p, -b)!; // reversed segment arrives at p against `dir`
      expect(-startTangent.x).toBeCloseTo(dir.x, 9);
      expect(-startTangent.y).toBeCloseTo(dir.y, 9);
    }
    expect(tangentBulge(p, { x: 1, y: 0 }, { x: p.x + 5, y: p.y })).toBe(0);
    expect(tangentBulge(p, { x: 1, y: 0 }, p)).toBeNull();
  });

  it('a three-point arc passes through the middle point', () => {
    const b = threePointBulge({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 })!;
    expect(b).toBeCloseTo(-1, 12);
    expect(threePointBulge({ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 0 })).toBeNull();
  });
});

describe('manual trace state', () => {
  it('traced vertices are exactly the clicked (snapped) points', () => {
    const snapped = [
      { x: 600070.05, y: 2500010 },
      { x: 600099.95, y: 2500010 },
      { x: 600100, y: 2500029.95 },
    ];
    let s = state([]);
    for (const p of snapped) s = applyClick(s, p, false).state;
    expect(s.points).toEqual(snapped);
    // A repeated click at the last point (double-click) adds nothing.
    expect(applyClick(s, snapped[2], false).state.points).toHaveLength(3);
    // Closing on the first vertex.
    const closed = applyClick(s, snapped[0], true);
    expect(closed.closed).toBe(true);
    expect(closed.state.points).toEqual(snapped);
  });

  it('tangent and three-point arc segments set the bulge on the segment start', () => {
    let s = state([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    s = { ...s, mode: 'tangent' };
    // Quarter circle: the chord is 45° off the tangent, so the included angle is 90°.
    expect(segmentBulge(s, { x: 20, y: 10 })).toBeCloseTo(Math.tan(Math.PI / 8), 12);
    s = applyClick(s, { x: 20, y: 10 }, false).state;
    expect(s.points[1].bulge).toBeCloseTo(Math.tan(Math.PI / 8), 12);
    expect(s.points[2]).toEqual({ x: 20, y: 10 });
    // Three-point arc: first click is the point on the arc, second the end.
    s = { ...s, mode: 'arc3' };
    s = applyClick(s, { x: 25, y: 15 }, false).state;
    expect(s.mid).toEqual({ x: 25, y: 15 });
    expect(s.points).toHaveLength(3);
    s = applyClick(s, { x: 20, y: 20 }, false).state;
    expect(s.points).toHaveLength(4);
    const arc = bulgeToArc(s.points[2], s.points[3], s.points[2].bulge!)!;
    expect(Math.hypot(25 - arc.c.x, 15 - arc.c.y)).toBeCloseTo(arc.r, 9);
  });

  it('Backspace removes the pending arc point, then the last vertex and its incoming arc', () => {
    let s = state(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0, bulge: 0.5 },
        { x: 20, y: 0 },
      ],
      'arc3',
      { x: 25, y: 5 },
    );
    s = applyBackspace(s);
    expect(s.mid).toBeNull();
    expect(s.points).toHaveLength(3);
    s = applyBackspace(s);
    expect(s.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });
});
