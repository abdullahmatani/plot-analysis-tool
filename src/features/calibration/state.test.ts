import { describe, expect, it } from 'vitest';

import { createProject } from '@/core/project';
import type { Drawing } from '@/core/types';
import { METRES_PER_PT } from '@/core/units';

import { ratioCalibration, twoPointCalibration } from './compute';
import { calibrationStatement, drawingCalibrationLine, projectCalibrationState } from './state';

const AT = '2026-10-14T00:00:00.000Z';
const pdf = (over: Partial<Drawing> = {}): Drawing => ({
  id: 'p',
  name: 'Plot plan',
  source: { kind: 'pdf', fileName: 'p.pdf', sha256: 'p', blobKey: 'p', size: 1 },
  nativeUnits: 'pt',
  opacity: 1,
  ghost: false,
  visible: true,
  hiddenSourceLayers: [],
  order: 0,
  ...over,
});

describe('calibration statement for outputs (row 32)', () => {
  it('states the worst calibration state of the visible drawings', () => {
    const p = createProject('t');
    expect(projectCalibrationState(p)).toBeNull();
    expect(calibrationStatement(p)).toMatch(/no drawing/);
    p.drawings = [pdf()];
    expect(projectCalibrationState(p)).toBe('uncalibrated');
    expect(calibrationStatement(p)).toContain('UNCALIBRATED');
    expect(calibrationStatement(p)).toContain('Plot plan: UNCALIBRATED (paper size 1:1, not to scale)');
  });

  it('describes the method, ratio and verification', () => {
    const d = pdf({
      calibration: ratioCalibration(1000, METRES_PER_PT, AT),
      verified: { at: AT, expected: 300, measured: 300.0004 },
    });
    expect(drawingCalibrationLine(d)).toBe(
      'Plot plan: VERIFIED — stated scale, 1:1000 (checked against 300.000 m)',
    );
    const MM = 72 / 25.4;
    const two = pdf({ calibration: twoPointCalibration({ x: 0, y: 0 }, { x: 200 * MM, y: 0 }, 100, AT) });
    expect(drawingCalibrationLine(two)).toBe('Plot plan: CALIBRATED — two-point scale, ≈ 1:500');
  });
});
