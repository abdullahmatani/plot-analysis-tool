import { describe, expect, it } from 'vitest';

import { formatArea, formatNumber, fromMetres } from '@/core/units';
import { measures } from '@/features/objects/labels';
import { parseDelimited } from '@/tables/csv';
import { computeContours } from '@/tables/contours';
import { readXlsx } from '@/tables/xlsx';

import { exportCsv, exportXlsx, objectsTable } from './tabular';
import { addObject, settingsFor, testProject } from './test-helpers';

function project() {
  const p = testProject();
  p.display.units = 'm';
  p.display.areaUnits = 'm2';
  p.display.precision = 2;
  addObject(
    p,
    { type: 'circle', c: { x: 600000, y: 2500000 }, r: 15 },
    { name: 'T-101', attributes: { Owner: 'Ops', Capacity: 5000 } },
  );
  addObject(
    p,
    { type: 'rect', c: { x: 0, y: 0 }, w: 40, h: 25, rot: 0.3 },
    { name: 'Laydown', category: 'Area', attributes: { Owner: 'Civil' } },
  );
  addObject(
    p,
    {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 30, y: 40 },
      ],
      closed: false,
    },
    { name: 'Pipe run' },
  );
  addObject(
    p,
    {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 10, y: 0, bulge: 1 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      closed: true,
    },
    { name: 'منطقة' },
  );
  p.drawings.push({
    id: 'd1',
    name: 'Plot plan',
    source: { kind: 'pdf', fileName: 'plan.pdf', sha256: 'x', blobKey: 'x', size: 1 },
    page: 1,
    opacity: 1,
    ghost: false,
    visible: true,
    hiddenSourceLayers: [],
    order: 0,
    calibration: {
      method: 'multi-point',
      transform: [1, 0, 0, 1, 0, 0],
      references: [],
      residualRms: 0.012,
      at: '2026-10-14T00:00:00Z',
    },
    verified: { at: '2026-10-14T01:00:00Z', expected: 100, measured: 100.01 },
  });
  return p;
}

describe('tabular export (row 80)', () => {
  it('objects table: measures, centroid, radii and attribute columns; totals match on-screen values', () => {
    const p = project();
    const t = objectsTable(p);
    expect(t.columns).toEqual(
      expect.arrayContaining([
        'Name',
        'Layer',
        'Area (m²)',
        'Perimeter (m)',
        'Centroid X (m)',
        'Radius (m)',
        'Owner',
        'Capacity',
      ]),
    );
    const row = (name: string) => t.rows.find((r) => r[0] === name)!;
    const col = (c: string) => t.columns.indexOf(c);
    expect(row('T-101')[col('Radius (m)')]).toBe(15);
    expect(row('T-101')[col('Diameter (m)')]).toBe(30);
    expect(row('T-101')[col('Centroid X (m)')]).toBe(600000);
    expect(row('T-101')[col('Owner')]).toBe('Ops');
    expect(row('T-101')[col('Capacity')]).toBe(5000);
    expect(row('Laydown')[col('Area (m²)')]).toBe(1000);
    expect(row('Pipe run')[col('Length (m)')]).toBe(50);
    expect(row('Pipe run')[col('Area (m²)')]).toBe(null);
    // Totals equal the sum of the on-screen measures, formatted the same way.
    const onScreen = p.objects.reduce((s, o) => s + (measures(o.geometry).area ?? 0), 0);
    expect(formatArea(t.totals.area, 'm2', 2)).toBe(formatArea(onScreen, 'm2', 2));
    const perim = p.objects.reduce((s, o) => s + (measures(o.geometry).perimeter ?? 0), 0);
    expect(formatNumber(t.totals.perimeter, 2)).toBe(formatNumber(fromMetres(perim, 'm'), 2));
  });

  it('display units: feet and hectares', () => {
    const p = project();
    p.display.units = 'ft';
    p.display.areaUnits = 'ha';
    const t = objectsTable(p);
    expect(t.columns).toContain('Area (ha)');
    expect(t.columns).toContain('Radius (ft)');
    const r = t.rows.find((x) => x[0] === 'T-101')!;
    expect(r[t.columns.indexOf('Radius (ft)')]).toBeCloseTo(15 / 0.3048, 4);
  });

  it('CSV: calibration header lines, then the table with a totals row', () => {
    const p = project();
    const csv = exportCsv(p, settingsFor(p, { format: 'csv' }), []);
    expect(csv.startsWith('﻿# Exported by: Plot Analysis Tool')).toBe(true);
    expect(csv).toContain('# Calibration: Verified');
    expect(csv).toContain('“Plot plan”: Verified (multi-reference fit, RMS 0.012 m)');
    const table = csv.slice(csv.indexOf('\r\n\r\n') + 4);
    const rows = parseDelimited(table);
    expect(rows[0][0]).toBe('Name');
    expect(rows[rows.length - 1][0]).toBe('Total');
    expect(rows.map((r) => r[0])).toContain('منطقة');
  });

  it('XLSX: header sheet with calibration details, objects, datasets with computed fields', () => {
    const p = project();
    p.datasets.push({
      id: 'ds',
      name: 'Fires',
      visible: true,
      table: {
        columns: ['Tag', 'X', 'Y', 'R'],
        rows: [
          ['A', 0, 0, 10],
          ['B', 5, 5, 20],
        ],
      },
      mapping: {
        position: { mode: 'xy', x: 'X', y: 'Y' },
        sizeColumns: ['R'],
        sizeMode: 'radius',
        sizeUnit: 'm',
        label: 'Tag',
      },
      sizeStyles: [],
      styleRules: [],
      labelTemplate: '{label} – {radius} m',
      labelPlacement: 'top',
      envelope: false,
      order: 0,
    });
    const items = computeContours(p.datasets[0], { anchors: new Map() }).items;
    const bytes = exportXlsx(p, settingsFor(p, { format: 'xlsx' }), [
      { datasetId: 'ds', items, envelopes: [] },
    ]);
    const wb = readXlsx(bytes);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Export info', 'Objects', 'Contours – Fires']);
    const info = wb.sheets[0].rows;
    expect(info.some((r) => r[0] === 'Calibration' && String(r[1]).includes('Verified'))).toBe(true);
    expect(info.some((r) => r[0] === 'Plot plan' && r[2] === 'verified' && r[4] === 0.012)).toBe(true);
    const ds = wb.sheets[2].rows;
    expect(ds[0]).toEqual(
      expect.arrayContaining(['Row', 'Size column', 'Radius (m)', 'Area (m²)', 'Label', 'Tag', 'R']),
    );
    expect(ds[1][ds[0].indexOf('Label')]).toBe('A – 10 m');
    expect(ds[2][ds[0].indexOf('Area (m²)')]).toBeCloseTo(Math.PI * 400, 2);
    // Deterministic (dates come from the title block).
    const again = exportXlsx(p, settingsFor(p, { format: 'xlsx' }), [
      { datasetId: 'ds', items, envelopes: [] },
    ]);
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
  });
});
