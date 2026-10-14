import { describe, expect, it } from 'vitest';

import { createProject } from '@/core/project';
import type { AnalysisObject, Geometry, ProjectDisplay } from '@/core/types';

import {
  angleAt,
  annotationLines,
  measureGeometry,
  measureText,
  modeForGeometry,
  resultClipboardText,
} from './compute';
import { northArrowAngle, scaleBarLayout } from './scalebar';

const M: ProjectDisplay = { units: 'm', precision: 3, areaUnits: 'm2', angleUnits: 'deg', plantCoords: true };

// Tank outline of tests/fixtures/dxf/r2018_plotplan.dxf (handle B9): 45 × 50 m with two r = 5 m rounded corners.
const tankOutline: Geometry = {
  type: 'polyline',
  closed: true,
  pts: [
    { x: 600180, y: 2500125 },
    { x: 600220, y: 2500125, bulge: 0.41421356237 },
    { x: 600225, y: 2500130 },
    { x: 600225, y: 2500170, bulge: 0.41421356237 },
    { x: 600220, y: 2500175 },
    { x: 600180, y: 2500175 },
  ],
};

describe('measurement values (row 35) match CAD within NFR-7', () => {
  it('distance between plant-coordinate points', () => {
    const v = measureGeometry('distance', {
      type: 'polyline',
      pts: [
        { x: 600000, y: 2500000 },
        { x: 600150, y: 2500100 },
      ],
      closed: false,
    });
    expect(v.distance).toBeCloseTo(Math.hypot(150, 100), 9);
    expect(v.dx).toBe(150);
    expect(v.dy).toBe(100);
    expect(measureText(v, M, ['E', 'N']).primary).toBe('180.278 m');
  });

  it('chained distance and polyline length include arc segments exactly', () => {
    const v = measureGeometry('chain', {
      type: 'polyline',
      closed: false,
      pts: [
        { x: 0, y: 0 },
        { x: 10, y: 0, bulge: 1 }, // semicircle of radius 5
        { x: 20, y: 0 },
      ],
    });
    expect(v.segments).toHaveLength(2);
    expect(v.total).toBeCloseTo(10 + 5 * Math.PI, 12);
  });

  it('area and perimeter of a closed outline with bulges', () => {
    expect(modeForGeometry(tankOutline)).toBe('area');
    const v = measureGeometry('area', tankOutline);
    const corner = 25 - (25 * Math.PI) / 4;
    expect(v.area).toBeCloseTo(45 * 50 - 2 * corner, 6);
    expect(v.perimeter).toBeCloseTo(40 + 40 + 40 + 50 + 2 * ((5 * Math.PI) / 2), 6);
    expect(measureText(v, { ...M, areaUnits: 'ha' }).primary).toBe('0.224 ha');
  });

  it('radius and diameter of circles and arcs', () => {
    const c: Geometry = { type: 'circle', c: { x: 600200, y: 2500150 }, r: 15 };
    expect(modeForGeometry(c)).toBe('radius');
    const v = measureGeometry('radius', c);
    expect(v.radius).toBe(15);
    expect(v.diameter).toBe(30);
    expect(v.area).toBeCloseTo(Math.PI * 225, 9);
    const a = measureGeometry('radius', { type: 'arc', c: { x: 0, y: 0 }, r: 2, a0: 0, a1: Math.PI / 2 });
    expect(a.arcLength).toBeCloseTo(Math.PI, 12);
    expect(measureText(measureGeometry('radius', tankOutline), M).primary).toBe('Not circular');
  });

  it('angle between two arms', () => {
    expect(angleAt({ x: 50, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 50 })).toBeCloseTo(Math.PI / 4, 14);
    const v = measureGeometry('angle', {
      type: 'polyline',
      closed: false,
      pts: [
        { x: 600050, y: 2500000 },
        { x: 600000, y: 2500000 },
        { x: 600050, y: 2500050 },
      ],
    });
    expect(measureText(v, M).primary).toBe('45.000°');
    expect(measureText(v, { ...M, angleUnits: 'rad' }).primary).toBe('0.78540 rad');
  });

  it('point coordinates use E/N labels with plant coordinates', () => {
    const v = measureGeometry('point', { type: 'point', p: { x: 600250, y: 2500150 } });
    expect(measureText(v, M, ['E', 'N']).primary).toBe('E 600\u202f250.0000 m\nN 2\u202f500\u202f150.0000 m');
  });

  it('switching display units changes every text (row 26)', () => {
    const v = measureGeometry('distance', {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 3.048, y: 0 },
      ],
      closed: false,
    });
    expect(measureText(v, { ...M, units: 'mm', precision: 0 }).primary).toBe('3\u202f048 mm');
    expect(measureText(v, { ...M, units: 'ft', precision: 2 }).primary).toBe('10.00 ft');
    expect(resultClipboardText(measureText(v, M))).toContain('Distance: 3.048 m');
  });

  it('annotation text follows the project display settings', () => {
    const p = createProject('t');
    const o: AnalysisObject = {
      id: 'o',
      layerId: p.activeLayerId,
      name: 'Distance 1',
      kind: 'measurement',
      geometry: {
        type: 'polyline',
        pts: [
          { x: 0, y: 0 },
          { x: 0, y: 1234.5 },
        ],
        closed: false,
      },
      style: {},
      attributes: {},
      measurement: { mode: 'distance' },
      createdAt: '',
    };
    expect(annotationLines(p, o)).toEqual(['1\u202f234.50 m']);
    p.display = { ...p.display, units: 'km', precision: 4 };
    expect(annotationLines(p, o)).toEqual(['1.2345 km']);
    const area = { ...o, measurement: { mode: 'area' as const }, geometry: tankOutline };
    expect(annotationLines(p, area)[1]).toMatch(/^P 0.1857 km$/);
  });
});

describe('scale bar and north arrow (row 36)', () => {
  it('nice lengths no longer than the available width', () => {
    // 2 px per metre, 160 px available → 80 m → 50 m bar of 100 px.
    const l = scaleBarLayout(2, 160, 'm')!;
    expect(l.metres).toBe(50);
    expect(l.px).toBe(100);
    expect(l.label).toBe('50 m');
    expect(l.ticks.map((t) => t.label)).toEqual(['0', '25 m', '50 m']);
    expect(scaleBarLayout(0.01, 160, 'm')!.label).toBe('10 km');
    expect(scaleBarLayout(0, 160, 'm')).toBeNull();
  });

  it('imperial display units use feet', () => {
    const l = scaleBarLayout(1 / 0.3048, 160, 'ft')!; // 1 px per foot
    expect(l.label).toBe('100 ft');
    expect(l.metres).toBeCloseTo(30.48, 12);
    expect(l.px).toBeCloseTo(100, 9);
  });

  it('north arrow follows the view rotation and the true-north setting', () => {
    expect(northArrowAngle(0.5, { arrow: 'plant', trueNorthAngle: 0.2 })).toBe(0.5);
    expect(northArrowAngle(0.5, { arrow: 'true', trueNorthAngle: 0.2 })).toBeCloseTo(0.7, 15);
  });
});
