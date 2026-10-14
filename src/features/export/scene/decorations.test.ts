import { describe, expect, it } from 'vitest';

import { similarity } from '@/core/affine';
import type { Drawing } from '@/core/types';
import { walkScene, type TextItem } from '@/export/scene';

import { testProject } from '../test-helpers';
import { calibrationStatement, drawingCalibrationInfo, overallCalibrationState } from './calibration';
import { northAngle, scaleBar } from './decorations';
import { paperFromWorld } from './sheet';
import { linetypeDash, paperColor } from './underlay';

function drawing(patch: Partial<Drawing> = {}): Drawing {
  return {
    id: 'd',
    name: 'Plot plan',
    source: { kind: 'dxf', fileName: 'plan.dxf', sha256: 'x', blobKey: 'x', size: 1 },
    nativeUnits: 'mm',
    opacity: 1,
    ghost: false,
    visible: true,
    hiddenSourceLayers: [],
    order: 0,
    ...patch,
  };
}

describe('calibration statement (row 32)', () => {
  it('states uncalibrated, calibrated (method, RMS) and verified drawings', () => {
    const p = testProject();
    const unc = drawing();
    const cal = drawing({
      id: 'c',
      name: 'Area layout',
      calibration: {
        method: 'multi-point',
        transform: similarity(0.001, 0, 0, 0),
        references: [],
        residualRms: 0.0123,
        at: '2026-10-14T00:00:00Z',
      },
    });
    const ver = drawing({
      id: 'v',
      name: 'Key plan',
      calibration: {
        method: 'two-point',
        transform: similarity(0.001, 0, 0, 0),
        references: [],
        at: '2026-10-14',
      },
      verified: { at: '2026-10-14', expected: 100, measured: 100.004 },
    });
    expect(drawingCalibrationInfo(p, unc).text).toBe(
      '“Plot plan”: Uncalibrated — drawing units read as mm; distances are not verified',
    );
    expect(drawingCalibrationInfo(p, cal).text).toBe(
      '“Area layout”: Calibrated (multi-reference fit, RMS 0.012 m)',
    );
    expect(drawingCalibrationInfo(p, ver).text).toBe(
      '“Key plan”: Verified (two-point distance) — check distance 100.004 m measured vs 100.000 m expected',
    );
    expect(overallCalibrationState([cal, ver])).toBe('calibrated');
    expect(overallCalibrationState([ver])).toBe('verified');
    p.drawings.push(unc, cal, ver);
    expect(calibrationStatement(p)[0]).toBe('Calibration: Uncalibrated');
    expect(calibrationStatement(p)).toHaveLength(4);
    // Hidden drawings are left out of the statement while visible ones exist.
    p.drawings[0].visible = false;
    expect(calibrationStatement(p)[0]).toBe('Calibration: Calibrated');
  });
});

describe('scale bar and north arrow (row 36)', () => {
  it('scale bar length is exact at the print scale with nice divisions', () => {
    const r = scaleBar(0, 0, 80, 1000, 1);
    expect(r.lengthM).toBe(50); // ≤ 80 mm at 1:1000 = 80 m → 50 m
    expect(r.lengthMm).toBeCloseTo(50, 12);
    const texts: string[] = [];
    walkScene(r.items, (it) => it.kind === 'text' && texts.push((it as TextItem).text));
    expect(texts).toEqual(['0', '10', '20', '30', '40', '50 m']);
    const ft = scaleBar(0, 0, 80, 1000, 1, 'ft');
    expect(ft.lengthM).toBeCloseTo(250 * 0.3048, 9); // 80 m = 262 ft → 250 ft
  });

  it('north arrow follows the view rotation and plant/true north', () => {
    const M = paperFromWorld({ x: 0, y: 0 }, { x: 0, y: 0 }, 500, 0);
    expect(northAngle(M, { arrow: 'plant', trueNorthAngle: 0.3 })).toBeCloseTo(0, 12);
    expect(northAngle(M, { arrow: 'true', trueNorthAngle: 0.3 })).toBeCloseTo(0.3, 12);
    const R = paperFromWorld({ x: 0, y: 0 }, { x: 0, y: 0 }, 500, 0.5);
    expect(northAngle(R, { arrow: 'plant', trueNorthAngle: 0 })).toBeCloseTo(0.5, 12);
    expect(northAngle(R, { arrow: 'true', trueNorthAngle: -0.2 })).toBeCloseTo(0.3, 12);
  });
});

describe('underlay styling', () => {
  it('prints ACI 7 / white as black and greys ghosted drawings', () => {
    expect(paperColor(0xffffff, false)).toBe('#000000');
    expect(paperColor(0xff0000, false)).toBe('#ff0000');
    const g = paperColor(0x000000, true);
    expect(g).toBe('#8c8c8c');
  });

  it('converts CAD linetypes to paper dash arrays (dots, leading gaps, too-fine patterns)', () => {
    // CENTER-like: 31.75 dash, -6.35 gap, 6.35 dash, -6.35 gap (drawing units) at 0.1 mm/unit.
    const center = linetypeDash([31.75, -6.35, 6.35, -6.35], 0.1, 0.18)!;
    [3.175, 0.635, 0.635, 0.635].forEach((v, i) => expect(center[i]).toBeCloseTo(v, 12));
    // A dot becomes a short dash; a leading gap gets a zero-length dash first.
    expect(linetypeDash([0, -2], 1, 0.25)).toEqual([0.25, 2]);
    expect(linetypeDash([-1, 2], 1, 0.25)).toEqual([0, 1, 2, 0]);
    // Too fine to see on paper: continuous.
    expect(linetypeDash([0.5, -0.25], 0.1, 0.18)).toBeUndefined();
    expect(linetypeDash([], 1, 0.18)).toBeUndefined();
  });
});
