import { describe, expect, it } from 'vitest';

import { layoutLabels, type Box, type LabelInput } from './labels';

const measure = (t: string, h: number) => t.length * h * 0.6;
const overlap = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

describe('contour label layout (row 70)', () => {
  it('places a top label above the ring', () => {
    const [l] = layoutLabels(
      [{ id: 0, text: 'P-101', centre: { x: 100, y: 100 }, r: 40, placement: 'top' }],
      measure,
      {
        height: 10,
      },
    );
    expect(l).toMatchObject({ align: 'center', baseline: 'bottom', x: 100 });
    expect(l.y).toBeLessThan(60);
  });

  it('avoids collisions between neighbouring labels by trying alternative positions', () => {
    const inputs: LabelInput[] = Array.from({ length: 6 }, (_, i) => ({
      id: i,
      text: `Scenario ${i}`,
      centre: { x: 100 + i * 4, y: 100 },
      r: 30,
      placement: 'top',
    }));
    const placed = layoutLabels(inputs, measure, { height: 10 });
    expect(placed.length).toBeGreaterThan(1);
    expect(placed.length).toBeLessThan(6); // some cannot fit anywhere and are dropped
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i].box, placed[j].box)).toBe(false);
  });

  it('draws leaders from the ring to the label and keeps labels inside the viewport', () => {
    const placed = layoutLabels(
      [
        { id: 0, text: 'A', centre: { x: 50, y: 50 }, r: 20, placement: 'leader' },
        { id: 1, text: 'B', centre: { x: 50, y: 50 }, r: 20, placement: 'leader' },
      ],
      measure,
      { height: 10, viewport: { x0: 0, y0: 0, x1: 200, y1: 200 } },
    );
    expect(placed).toHaveLength(2);
    for (const p of placed) {
      expect(p.leader).toBeDefined();
      const d = Math.hypot(p.leader!.a.x - 50, p.leader!.a.y - 50);
      expect(d).toBeCloseTo(20, 9);
      expect(p.box.x0).toBeGreaterThanOrEqual(0);
    }
    expect(overlap(placed[0].box, placed[1].box)).toBe(false);
  });

  it('places identical labels at the same ring once and respects the label budget', () => {
    const same: LabelInput = { id: 0, text: 'X', centre: { x: 0, y: 0 }, r: 10, placement: 'centre' };
    expect(layoutLabels([same, { ...same, id: 1 }], measure, { height: 10 })).toHaveLength(1);
    const many = Array.from({ length: 50 }, (_, i) => ({ ...same, id: i, centre: { x: i * 100, y: 0 } }));
    expect(layoutLabels(many, measure, { height: 10, maxLabels: 7 })).toHaveLength(7);
  });
});
