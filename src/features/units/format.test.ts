import { describe, expect, it } from 'vitest';

import { createProject } from '@/core/project';
import type { Drawing } from '@/core/types';

import {
  coordinateAxes,
  fmtAngle,
  fmtArea,
  fmtCoord,
  fmtLength,
  hasPlantCoordinates,
  nativeUnitsLabel,
  unitForFactor,
} from './format';

const drawing = (over: Partial<Drawing> = {}): Drawing => ({
  id: 'd',
  name: 'd',
  source: { kind: 'dxf', fileName: 'd.dxf', sha256: 'x', blobKey: 'x', size: 1 },
  nativeUnits: 'm',
  opacity: 1,
  ghost: false,
  visible: true,
  hiddenSourceLayers: [],
  order: 0,
  ...over,
});

describe('display formatting (row 26)', () => {
  it('formats lengths, areas, angles and coordinates in the display units', () => {
    const d = {
      units: 'mm' as const,
      precision: 1,
      areaUnits: 'ha' as const,
      angleUnits: 'deg' as const,
      plantCoords: true,
    };
    expect(fmtLength(1.23456, d)).toBe('1\u202f234.6 mm');
    expect(fmtArea(25000, d)).toBe('2.5 ha');
    expect(fmtAngle(Math.PI / 2, d)).toBe('90.0°');
    expect(fmtAngle(Math.PI / 2, { ...d, angleUnits: 'rad' })).toBe('1.571 rad');
    expect(fmtCoord(600000.5, { ...d, units: 'm', precision: 2 })).toBe('600\u202f000.500');
  });

  it('plant coordinate axes only with a coordinates calibration', () => {
    const p = createProject('t');
    p.drawings = [drawing()];
    expect(hasPlantCoordinates(p)).toBe(false);
    expect(coordinateAxes(p)).toEqual(['X', 'Y']);
    p.drawings = [
      drawing({
        calibration: { method: 'coordinates', transform: [1, 0, 0, 1, 0, 0], references: [], at: '' },
      }),
    ];
    expect(coordinateAxes(p)).toEqual(['E', 'N']);
    p.display = { ...p.display, plantCoords: false };
    expect(coordinateAxes(p)).toEqual(['X', 'Y']);
  });

  it('maps unit factors and describes native units', () => {
    expect(unitForFactor(0.3048)).toBe('ft');
    expect(unitForFactor(0.001)).toBe('mm');
    expect(unitForFactor(1200 / 3937)).toBeNull();
    expect(nativeUnitsLabel(drawing(), 6)).toBe('Metres (m) ($INSUNITS 6)');
    expect(nativeUnitsLabel(drawing({ nativeUnits: 'unitless' }), 0)).toBe('Unitless ($INSUNITS 0)');
    expect(
      nativeUnitsLabel(
        drawing({ source: { kind: 'pdf', fileName: 'a', sha256: 'a', blobKey: 'a', size: 1 } }),
      ),
    ).toMatch(/PDF points/);
  });
});
