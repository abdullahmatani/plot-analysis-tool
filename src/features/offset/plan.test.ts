import { describe, expect, it } from 'vitest';

import { createProject } from '@/core/project';
import type { AnalysisObject, Geometry, Project } from '@/core/types';
import { parseLength } from '@/core/units';
import { unionArea } from '@/geometry/boolean';
import { area, distanceToRing } from '@/geometry/measure';
import { OFFSET_MESSAGES } from '@/geometry/offset';

import {
  DEFAULT_OFFSET_PARAMS,
  formatOffset,
  parseDistanceList,
  planOffsets,
  planRings,
  type OffsetParams,
} from './plan';

/** Offset planning (rows 55–61): analytic results, corner styles, rings, batch merge. */

let seq = 0;
function obj(geometry: Geometry, name = `S${++seq}`): AnalysisObject {
  return {
    id: `s${++seq}`,
    layerId: 'L',
    name,
    kind: 'shape',
    geometry,
    style: {},
    attributes: {},
    createdAt: '2026-01-01T00:00:00Z',
  };
}

const project = (): Project => createProject('Offsets');
const params = (p: Partial<OffsetParams>): OffsetParams => ({ ...DEFAULT_OFFSET_PARAMS, ...p });

describe('circle and arc offsets (row 55)', () => {
  it('are exact and concentric; arcs keep their span; live link kept', () => {
    const c = obj({ type: 'circle', c: { x: 612345.125, y: 2534210.004 }, r: 12.5 });
    const a = obj({ type: 'arc', c: { x: 5, y: 6 }, r: 10, a0: 0.25, a1: 2.5 });
    const plan = planOffsets(project(), [c, a], params({ distance: 7.5 }));
    expect(plan.warnings).toEqual([]);
    expect(plan.inputs[0].geometry).toEqual({ type: 'circle', c: { x: 612345.125, y: 2534210.004 }, r: 20 });
    expect(plan.inputs[1].geometry).toEqual({ type: 'arc', c: { x: 5, y: 6 }, r: 17.5, a0: 0.25, a1: 2.5 });
    expect(plan.inputs[0].derived).toMatchObject({
      kind: 'offset',
      sourceId: c.id,
      distance: 7.5,
      join: 'round',
    });
    expect(plan.inputs[0].kind).toBe('offset');
    expect(plan.inputs[0].attributes).toMatchObject({ offset: '+7.5 m' });
  });

  it('contraction to r ≤ 0 is rejected with a message', () => {
    const c = obj({ type: 'circle', c: { x: 0, y: 0 }, r: 5 }, 'Tank');
    const plan = planOffsets(project(), [c], params({ distance: -5 }));
    expect(plan.inputs).toEqual([]);
    expect(plan.warnings).toEqual([`Tank: ${OFFSET_MESSAGES.circleCollapse}`]);
    const ok = planOffsets(project(), [c], params({ distance: -4.999 }));
    expect((ok.inputs[0].geometry as { r: number }).r).toBeCloseTo(0.001, 12);
  });
});

describe('rectangle offsets incl. rotated (row 56)', () => {
  const w = 30;
  const h = 12;
  const d = 4;
  const rect = (rot: number): Geometry => ({ type: 'rect', c: { x: 600100.5, y: 2500200.25 }, w, h, rot });

  for (const rot of [0, 0.4, -1.1]) {
    it(`round (default) = exact Minkowski sum with a disc; mitre, bevel, square (rot ${rot})`, () => {
      const src = obj(rect(rot));
      const of = (join: OffsetParams['join']) =>
        planOffsets(project(), [src], params({ distance: d, join })).inputs[0].geometry;
      // Round: A + P·d + π·d², and every vertex/arc at exactly d from the rectangle.
      const round = of('round');
      expect(round.type).toBe('polyline');
      expect(area(round)).toBeCloseTo(w * h + 2 * d * (w + h) + Math.PI * d * d, 6);
      const corners = round.type === 'polyline' ? round.pts : [];
      expect(corners.filter((v) => v.bulge).length).toBe(4);
      for (const v of corners)
        expect(Math.abs(v.bulge ?? 0) === 0 || Math.abs(v.bulge! - Math.tan(Math.PI / 8)) < 1e-15).toBe(true);
      // Mitre: the rectangle grown by d on every side.
      const miter = of('miter');
      expect(miter).toMatchObject({ type: 'rect', w: w + 2 * d, h: h + 2 * d, rot });
      // Bevel: corners cut through the ends of the offset edges.
      expect(area(of('bevel'))).toBeCloseTo((w + 2 * d) * (h + 2 * d) - 2 * d * d, 6);
      // Square: corners cut perpendicular to the bisector at distance d from the corner.
      const cut = d * (Math.SQRT2 - 1);
      expect(area(of('square'))).toBeCloseTo((w + 2 * d) * (h + 2 * d) - 4 * cut * cut, 6);
    });
  }

  it('round offset vertices lie exactly d from the source outline at UTM coordinates (NFR-7)', () => {
    const src = obj(rect(0.7));
    const g = planOffsets(project(), [src], params({ distance: d })).inputs[0].geometry;
    const ring = (src.geometry.type === 'rect' ? rect(0.7) : src.geometry) as Extract<
      Geometry,
      { type: 'rect' }
    >;
    const cs = Math.cos(ring.rot);
    const sn = Math.sin(ring.rot);
    const pts = [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ].map(([x, y]) => ({ x: ring.c.x + x * cs - y * sn, y: ring.c.y + x * sn + y * cs }));
    for (const v of (g as Extract<Geometry, { type: 'polyline' }>).pts)
      expect(Math.abs(distanceToRing(v, pts) - d)).toBeLessThan(1e-6);
  });

  it('contraction shrinks every side and rejects w or h ≤ 0', () => {
    const src = obj(rect(0.3), 'Box');
    expect(planOffsets(project(), [src], params({ distance: -2 })).inputs[0].geometry).toMatchObject({
      type: 'rect',
      w: w - 4,
      h: h - 4,
    });
    expect(planOffsets(project(), [src], params({ distance: -6 })).warnings).toEqual([
      `Box: ${OFFSET_MESSAGES.rectCollapse}`,
    ]);
  });
});

describe('polygon / polyline offsets (row 57)', () => {
  it('open polylines give corridors with the chosen cap; contraction of an open line is refused', () => {
    const line = obj({
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      closed: false,
    });
    const butt = planOffsets(project(), [line], params({ distance: 5, cap: 'butt' })).inputs[0];
    expect(area(butt.geometry)).toBeCloseTo(100 * 10, 3);
    expect(butt.derived?.cap).toBe('butt');
    const round = planOffsets(project(), [line], params({ distance: 5 })).inputs[0];
    expect(area(round.geometry)).toBeGreaterThan(1000 + Math.PI * 25 - 0.5);
    expect(planOffsets(project(), [line], params({ distance: -5 })).warnings[0]).toMatch(
      /cannot be contracted/,
    );
  });

  it('collapse on contraction yields a warning', () => {
    const tri = obj({
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
      closed: true,
    });
    const plan = planOffsets(project(), [tri], params({ distance: -5 }));
    expect(plan.inputs).toEqual([]);
    expect(plan.warnings[0]).toMatch(/collapses/);
  });
});

describe('batch offset and merge (row 60)', () => {
  it('merged envelope area equals the boolean union area of the individual results', () => {
    const p = project();
    const a = obj({ type: 'circle', c: { x: 0, y: 0 }, r: 10 });
    const b = obj({ type: 'circle', c: { x: 15, y: 0 }, r: 10 });
    const c = obj({ type: 'rect', c: { x: 50, y: 0 }, w: 10, h: 10, rot: 0.2 });
    const separate = planOffsets(p, [a, b, c], params({ distance: 5 }));
    expect(separate.inputs).toHaveLength(3);
    const merged = planOffsets(p, [a, b, c], params({ distance: 5, merge: true }));
    expect(merged.inputs).toHaveLength(1);
    const env = merged.inputs[0];
    expect(env.derived).toBeUndefined();
    expect(env.attributes).toMatchObject({ sources: 3 });
    const union = unionArea(
      separate.inputs.map((i) => i.geometry),
      p.chordTolerance,
    );
    expect(area(env.geometry)).toBeCloseTo(union, 6);
    // Two overlapping circles r = 15 at 15 m: analytic union area (lens formula), within the chord tolerance.
    const r = 15;
    const dd = 15;
    const lens = 2 * r * r * Math.acos(dd / (2 * r)) - (dd / 2) * Math.sqrt(4 * r * r - dd * dd);
    const twoCircles = 2 * Math.PI * r * r - lens;
    const rectArea = 20 * 20 - 4 * 25 + Math.PI * 25;
    expect(Math.abs(area(env.geometry) - (twoCircles + rectArea))).toBeLessThan(
      p.chordTolerance * (2 * Math.PI * r * 2 + 80),
    );
  });

  it('open results (arcs) are kept separately with a note', () => {
    const p = project();
    const merged = planOffsets(
      p,
      [
        obj({ type: 'circle', c: { x: 0, y: 0 }, r: 10 }),
        obj({ type: 'circle', c: { x: 5, y: 0 }, r: 10 }),
        obj({ type: 'arc', c: { x: 50, y: 0 }, r: 10, a0: 0, a1: 1 }),
      ],
      params({ distance: 2, merge: true }),
    );
    // One envelope of the two circles (a single outline) plus the arc offset on its own.
    expect(merged.inputs.map((i) => i.geometry.type)).toEqual(['polyline', 'arc']);
    expect(merged.warnings[0]).toMatch(/not merged/);
  });
});

describe('multi-ring offsets (row 58)', () => {
  it('one live ring per distance on one layer, sharing a ring group, labelled and ramp-coloured', () => {
    const p = project();
    const tank = obj({ type: 'circle', c: { x: 100, y: 200 }, r: 15 }, 'T-101');
    const plan = planRings(p, tank, {
      distances: [25, 10, 50, 10],
      join: 'round',
      cap: 'round',
      miterLimit: 2,
      ramp: 'yellow-red',
    });
    expect(plan.warnings).toEqual([]);
    // Largest first (drawn underneath), duplicates removed.
    expect(plan.inputs.map((i) => (i.geometry as { r: number }).r)).toEqual([65, 40, 25]);
    expect(plan.inputs.map((i) => i.name)).toEqual(['T-101 +50 m', 'T-101 +25 m', 'T-101 +10 m']);
    for (const i of plan.inputs) {
      expect(i.layerId).toBeUndefined(); // → the active layer
      expect(i.derived?.ringGroup).toBe(plan.group);
      expect(i.derived?.sourceId).toBe(tank.id);
      expect(i.label).toMatchObject({ template: '{offset}', visible: true });
      expect(i.style?.stroke).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(plan.inputs.map((i) => i.attributes?.offset)).toEqual(['+50 m', '+25 m', '+10 m']);
    expect(new Set(plan.inputs.map((i) => i.style?.stroke)).size).toBe(3);
    // Nearest ring gets the strongest ramp colour (the end of yellow–red is dark red).
    expect(plan.inputs[2].style?.stroke).toBe('#800026');
  });

  it('skips distances that collapse and reports them', () => {
    const plan = planRings(project(), obj({ type: 'circle', c: { x: 0, y: 0 }, r: 5 }), {
      distances: [-10, -2, 5],
      join: 'round',
      cap: 'round',
      miterLimit: 2,
      ramp: 'viridis',
    });
    expect(plan.inputs).toHaveLength(2);
    expect(plan.warnings).toEqual([`-10 m: ${OFFSET_MESSAGES.circleCollapse}`]);
  });
});

describe('helpers', () => {
  it('formats signed distances and parses distance lists', () => {
    expect(formatOffset(10, 'm', 2)).toBe('+10 m');
    expect(formatOffset(-2.5, 'm', 2)).toBe('-2.5 m');
    expect(formatOffset(0.25, 'mm', 1)).toBe('+250 mm');
    const parse = (s: string) => parseLength(s, 'm');
    expect(parseDistanceList('10, 25, 50', parse)).toEqual([10, 25, 50]);
    expect(parseDistanceList('10; 25 m; 500 mm', parse)).toEqual([10, 25, 0.5]);
    expect(parseDistanceList('10 25 50', parse)).toEqual([10, 25, 50]);
    expect(parseDistanceList('15 m', parse)).toEqual([15]);
    expect(parseDistanceList('10, x', parse)).toBeNull();
    expect(parseDistanceList('0', parse)).toBeNull();
  });
});
