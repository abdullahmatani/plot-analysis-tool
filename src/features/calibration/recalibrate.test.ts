import { beforeEach, describe, expect, it } from 'vitest';

import { apply, scale as scaleM } from '@/core/affine';
import { createProject } from '@/core/project';
import type { AnalysisObject, Drawing, Project } from '@/core/types';
import { METRES_PER_PT } from '@/core/units';
import { getProject, useProjectStore } from '@/store/project';
import { placementOf } from '@/underlay/models';

import { ratioCalibration } from './compute';
import { commitPlan, deltaTransform, itemsOnDrawing, movedObject, planPlacementChange } from './recalibrate';

const AT = '2026-10-14T00:00:00.000Z';

function pdf(id: string, over: Partial<Drawing> = {}): Drawing {
  return {
    id,
    name: id,
    source: { kind: 'pdf', fileName: `${id}.pdf`, sha256: id, blobKey: id, size: 1 },
    page: 1,
    nativeUnits: 'pt',
    opacity: 1,
    ghost: false,
    visible: true,
    hiddenSourceLayers: [],
    order: 0,
    ...over,
  };
}

function obj(
  id: string,
  geometry: AnalysisObject['geometry'],
  over: Partial<AnalysisObject> = {},
): AnalysisObject {
  return {
    id,
    layerId: 'l',
    name: id,
    kind: 'shape',
    geometry,
    style: {},
    attributes: {},
    createdAt: AT,
    ...over,
  };
}

/** Project with a 1:1000 PDF and a circle drawn on tank T-101 (x 60, y 140, r 15 at 1:500). */
function setup(): Project {
  const p = createProject('t');
  const k1000 = METRES_PER_PT * 1000;
  p.drawings = [
    pdf('d1', {
      calibration: ratioCalibration(1000, METRES_PER_PT, AT),
      verified: { at: AT, expected: 1, measured: 1 },
    }),
  ];
  const MM = 72 / 25.4;
  const tankPt = { x: (100 + 120) * MM, y: (100 + 280) * MM };
  p.objects = [
    obj(
      'c',
      { type: 'circle', c: apply(scaleM(k1000), tankPt), r: 30 * MM * k1000 },
      { label: { template: '{name}', placement: 'leader', offset: { x: 10, y: 0 }, visible: true } },
    ),
    obj('poly', {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 100, y: 0, bulge: 0.5 },
        { x: 100, y: 50 },
      ],
      closed: false,
    }),
  ];
  p.anchors = [{ id: 'a', name: 'P-101', p: { x: 10, y: 20 } }];
  useProjectStore.getState().load({ project: p, undo: [], redo: [] });
  return p;
}

describe('recalibration (row 33)', () => {
  beforeEach(() => {
    useProjectStore.getState().unload();
  });

  it('delta = new ∘ old⁻¹ moves a point on the drawing to its new world position', () => {
    const oldP = scaleM(2);
    const newP: [number, number, number, number, number, number] = [0, 3, -3, 0, 10, 20];
    const d = deltaTransform(oldP, newP);
    const drawingPt = { x: 7, y: -4 };
    const w = apply(d, apply(oldP, drawingPt));
    const e = apply(newP, drawingPt);
    expect(w.x).toBeCloseTo(e.x, 12);
    expect(w.y).toBeCloseTo(e.y, 12);
  });

  it('"move with drawing" applies the delta exactly (circles stay circles) in one undo step', () => {
    const p0 = setup();
    const mutate = (d: Drawing) => void (d.calibration = ratioCalibration(500, METRES_PER_PT, AT));
    const plan = planPlacementChange(p0, 'd1', mutate, -1, { minX: 0, minY: 0, maxX: 2384, maxY: 1684 })!;
    expect(plan.changed).toBe(true);
    expect(plan.objects).toEqual(['c', 'poly']);
    expect(plan.anchors).toEqual(['a']);
    expect(commitPlan(p0, plan, 'Calibrate', mutate, true)).toBe(true);
    const p1 = getProject()!;
    const c = p1.objects[0].geometry;
    expect(c.type).toBe('circle');
    if (c.type === 'circle') {
      // T-101 at 1:500: centre (60, 140) + sheet origin offset (100 mm·0.5) = world (110, 190); r = 15.
      expect(c.r).toBeCloseTo(15, 9);
      expect(c.c.x).toBeCloseTo(110, 9);
      expect(c.c.y).toBeCloseTo(190, 9);
    }
    expect(p1.objects[0].label?.offset?.x).toBeCloseTo(5, 12);
    expect(p1.objects[1].geometry).toMatchObject({
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 50, y: 0, bulge: 0.5 },
        { x: 50, y: 25 },
      ],
    });
    expect(p1.anchors[0].p).toEqual({ x: 5, y: 10 });
    expect(p1.drawings[0].calibration?.ratio).toBe(500);
    expect(p1.drawings[0].verified).toBeUndefined();
    // One undo step restores drawing, objects and anchors.
    expect(useProjectStore.getState().history?.undo).toHaveLength(1);
    useProjectStore.getState().undo();
    expect(getProject()).toEqual(p0);
  });

  it('"keep in place" changes only the drawing', () => {
    const p0 = setup();
    const mutate = (d: Drawing) => void (d.calibration = ratioCalibration(500, METRES_PER_PT, AT));
    const plan = planPlacementChange(p0, 'd1', mutate, -1, null)!;
    commitPlan(p0, plan, 'Calibrate', mutate, false);
    const p1 = getProject()!;
    expect(p1.objects).toEqual(p0.objects);
    expect(p1.anchors).toEqual(p0.anchors);
    expect(placementOf(p1.drawings[0])[0]).toBeCloseTo(METRES_PER_PT * 500, 15);
  });

  it('non-uniform changes turn moved circles into exact ellipses', () => {
    const c = obj('c', { type: 'circle', c: { x: 1, y: 1 }, r: 2 });
    const m = movedObject(c, [2, 0, 0, 1, 0, 0], 0.001).geometry;
    expect(m).toMatchObject({ type: 'ellipse', c: { x: 2, y: 1 }, rx: 4, ry: 2 });
  });

  it('with several drawings only items over the drawing are moved', () => {
    const p = createProject('x');
    p.drawings = [pdf('d1'), pdf('d2', { order: 1 })];
    p.objects = [
      obj('in', { type: 'circle', c: { x: 5, y: 5 }, r: 1 }),
      obj('out', { type: 'circle', c: { x: 500, y: 500 }, r: 1 }),
    ];
    p.anchors = [
      { id: 'ai', name: 'in', p: { x: 1, y: 1 } },
      { id: 'ao', name: 'out', p: { x: 900, y: 1 } },
    ];
    expect(itemsOnDrawing(p, 'd1', { minX: 0, minY: 0, maxX: 10, maxY: 10 })).toEqual({
      objects: ['in'],
      anchors: ['ai'],
    });
  });

  it('an unchanged placement asks nothing and moves nothing', () => {
    const p0 = setup();
    const plan = planPlacementChange(p0, 'd1', (d) => void (d.name = 'renamed'), -1, null)!;
    expect(plan.changed).toBe(false);
    expect(plan.objects).toEqual([]);
  });
});
