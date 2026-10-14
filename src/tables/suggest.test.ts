import { describe, expect, it } from 'vitest';

import type { CellValue } from '@/core/types';

import { mappingErrors, parseUnitSuffix, suggestMapping } from './suggest';
import { importTable } from './table';
import { readFixture } from './test-helpers';

describe('parseUnitSuffix', () => {
  it('reads units from header suffixes', () => {
    expect(parseUnitSuffix('Radius (m)')).toBe('m');
    expect(parseUnitSuffix('Radius [ft]')).toBe('ft');
    expect(parseUnitSuffix('radius_mm')).toBe('mm');
    expect(parseUnitSuffix('Radius, km')).toBe('km');
    expect(parseUnitSuffix('Radius in metres')).toBe('m');
    expect(parseUnitSuffix('Radius (in)')).toBe('in');
    expect(parseUnitSuffix('Distance to 4 kW/m2')).toBeUndefined();
    expect(parseUnitSuffix('12.5 kW/m²')).toBeUndefined();
    expect(parseUnitSuffix('Distance in')).toBeUndefined();
    expect(parseUnitSuffix('Tag')).toBeUndefined();
  });
});

describe('suggestMapping', () => {
  it('maps the consequence fixture', () => {
    const { table } = importTable({ kind: 'csv', bytes: readFixture('consequences.csv') });
    expect(suggestMapping(table.columns, table.rows)).toEqual({
      position: { mode: 'xy', x: 'X', y: 'Y', anchor: 'Tag' },
      sizeColumns: ['Radiation 4 kW/m2 (m)', 'Radiation 12.5 kW/m2 (m)', 'Radiation 37.5 kW/m2 (m)'],
      sizeMode: 'radius',
      sizeUnit: 'm',
      label: 'Scenario',
      group: 'Category',
    });
  });

  it('suggests anchor mode, hazard endpoint columns, diameter mode and geometry roles', () => {
    const columns = [
      'Equipment',
      'Name',
      'Type',
      'Distance to 4 kW/m2',
      '12.5 kW/m²',
      'LFL',
      'IDLH',
      'Overpressure 0.1 bar',
      'Frequency',
      'Width',
      'Height',
      'Rotation',
      'Shape',
      'Colour',
    ];
    const rows: CellValue[][] = [
      ['P-101', 'Seal leak', 'Jet fire', 40, 25, 'N/R', 300, 80, 1e-4, 5, 3, 30, 'rect', '#ff0000'],
      ['V-201', 'Flange', 'Toxic', 30, 20, 12, 250, 60, 2e-5, 4, 2, 0, 'circle', '#00ff00'],
    ];
    expect(suggestMapping(columns, rows)).toEqual({
      position: { mode: 'anchor', anchor: 'Equipment' },
      width: 'Width',
      height: 'Height',
      rotation: 'Rotation',
      sizeColumns: ['Distance to 4 kW/m2', '12.5 kW/m²', 'LFL', 'IDLH', 'Overpressure 0.1 bar'],
      sizeMode: 'radius',
      sizeUnit: 'm',
      label: 'Name',
      group: 'Type',
      color: 'Colour',
      shape: 'Shape',
    });
  });

  it('detects plant coordinates, units and diameter mode', () => {
    const columns = ['Easting (ft)', 'Northing (ft)', 'Diameter [ft]', 'Scenario'];
    const rows: CellValue[][] = [[1000, 2000, 50, 'A']];
    expect(suggestMapping(columns, rows)).toEqual({
      position: { mode: 'plant', x: 'Easting (ft)', y: 'Northing (ft)', coordUnit: 'ft' },
      sizeColumns: ['Diameter [ft]'],
      sizeMode: 'diameter',
      sizeUnit: 'ft',
      label: 'Scenario',
    });
  });

  it('ignores text columns with size-like names', () => {
    const m = suggestMapping(['Tag', 'Radius'], [['P-1', 'big']]);
    expect(m.sizeColumns).toBeUndefined();
  });
});

describe('mappingErrors (row 63: required roles)', () => {
  const columns = ['Tag', 'X', 'Y', 'R'];
  it('flags unmapped required roles and unknown columns', () => {
    expect(mappingErrors({}, columns)).toEqual([
      'Choose how rows are positioned.',
      'Map at least one size column.',
    ]);
    expect(mappingErrors({ position: { mode: 'xy', x: 'X' }, sizeColumns: ['R'] }, columns)).toEqual([
      'Map the Y column.',
    ]);
    expect(mappingErrors({ position: { mode: 'anchor' }, sizeColumns: ['Q'] }, columns)).toEqual([
      'Map the anchor name column.',
      'Size column "Q" is not in the table.',
    ]);
    expect(
      mappingErrors({ position: { mode: 'xy', x: 'X', y: 'Y' }, sizeColumns: ['R'], label: 'Tag' }, columns),
    ).toEqual([]);
  });
});
