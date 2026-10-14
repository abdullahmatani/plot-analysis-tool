import { describe, expect, it } from 'vitest';

import { createLayer } from '@/core/project';
import type { ContourDataset } from '@/core/types';
import { computeContours } from '@/tables/contours';

import { addObject, testProject } from '../export/test-helpers';
import { buildLegend, objectLegendKeys, reorderOverrides } from './legend-model';

function dataset(): ContourDataset {
  return {
    id: 'ds1',
    name: 'Fire results',
    visible: true,
    table: {
      columns: ['Tag', 'X', 'Y', 'Scenario', 'R1', 'R2'],
      rows: [
        ['P-101', 0, 0, 'Jet fire', 10, 20],
        ['P-102', 50, 0, 'Pool fire', 15, 25],
        ['P-103', 100, 0, 'Flash fire', 5, null],
      ],
    },
    mapping: {
      position: { mode: 'xy', x: 'X', y: 'Y' },
      sizeColumns: ['R1', 'R2'],
      sizeMode: 'radius',
      sizeUnit: 'm',
      label: 'Tag',
    },
    sizeStyles: [
      { column: 'R1', visible: true, color: '#dc2626', dash: 'solid', fillOpacity: 0.1, strokeWidth: 0.35 },
      {
        column: 'R2',
        visible: true,
        color: '#2563eb',
        dash: 'dash',
        fillOpacity: 0.05,
        strokeWidth: 0.25,
        legendLabel: '4 kW/m²',
      },
    ],
    styleRules: [],
    labelTemplate: '{label}',
    labelPlacement: 'top',
    envelope: false,
    order: 0,
  };
}

describe('legend builder (row 75)', () => {
  it('has an entry for every visible styled item: layers, style variants, offset ring groups', () => {
    const p = testProject();
    const layer2 = createLayer('Laydown', 1);
    p.layers.push(layer2);
    addObject(p, { type: 'circle', c: { x: 0, y: 0 }, r: 5 }, { name: 'A' });
    addObject(
      p,
      { type: 'circle', c: { x: 9, y: 0 }, r: 5 },
      { name: 'B', style: { fill: '#00ff00', stroke: '#00ff00' }, category: 'Exclusion' },
    );
    const src = addObject(
      p,
      { type: 'rect', c: { x: 0, y: 0 }, w: 10, h: 10, rot: 0 },
      { name: 'Tank', layerId: layer2.id },
    );
    for (const d of [10, 25]) {
      addObject(
        p,
        { type: 'circle', c: { x: 0, y: 0 }, r: d },
        {
          name: `Ring ${d}`,
          layerId: layer2.id,
          kind: 'offset',
          derived: { kind: 'offset', sourceId: src.id, distance: d, join: 'round', ringGroup: 'rg1' },
          style: { stroke: d === 10 ? '#ff0000' : '#ff8800' },
        },
      );
    }
    const m = buildLegend(p);
    const keys = m.items.map((i) => i.key);
    // Every object maps to a visible legend entry.
    for (const [, key] of objectLegendKeys(p)) {
      expect(keys).toContain(key);
      expect(m.items.find((i) => i.key === key)!.hidden).toBe(false);
    }
    expect(m.items.find((i) => i.source === 'style')!.title).toBe('Exclusion');
    // Rings form one legend group, sorted by distance.
    const rings = m.groups.find((g) => g.title === 'Offset rings – Tank')!;
    expect(rings.items.map((i) => i.title)).toEqual(['+10.00 m', '+25.00 m']);
    // Top-most layer first.
    expect(m.items[0].key).toBe(`layer:${layer2.id}`);
  });

  it('hidden layers and layers without objects have no entries; legend.show=false hides by default', () => {
    const p = testProject();
    const l2 = createLayer('Empty', 1);
    const l3 = createLayer('Hidden', 2, { visible: false });
    const l4 = createLayer('Not in legend', 3, { legend: { show: false } });
    p.layers.push(l2, l3, l4);
    addObject(p, { type: 'circle', c: { x: 0, y: 0 }, r: 5 }, { layerId: l3.id });
    addObject(p, { type: 'circle', c: { x: 0, y: 0 }, r: 5 }, { layerId: l4.id });
    const m = buildLegend(p);
    expect(m.items.map((i) => i.key)).toEqual([`layer:${l4.id}`]);
    expect(m.items[0].hidden).toBe(true);
    expect(m.groups).toEqual([]);
  });

  it('applies overrides: title, hidden, group and order', () => {
    const p = testProject();
    const l2 = createLayer('Second', 1);
    p.layers.push(l2);
    addObject(p, { type: 'circle', c: { x: 0, y: 0 }, r: 5 });
    addObject(p, { type: 'circle', c: { x: 0, y: 0 }, r: 5 }, { layerId: l2.id });
    const base = buildLegend(p);
    const order = reorderOverrides(base, `layer:${p.layers[0].id}`, -1);
    p.legend.overrides = [
      {
        key: `layer:${p.layers[0].id}`,
        title: 'Renamed',
        group: 'Zones',
        order: order.get(`layer:${p.layers[0].id}`),
      },
      { key: `layer:${l2.id}`, hidden: true, order: order.get(`layer:${l2.id}`) },
    ];
    const m = buildLegend(p);
    expect(m.items[0].title).toBe('Renamed');
    expect(m.items[0].defaultTitle).toBe('Analysis');
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].title).toBe('Zones');
    expect(m.items[1].hidden).toBe(true);
  });

  it('contour datasets: size columns, rule categories actually drawn, envelopes', () => {
    const p = testProject();
    const ds = dataset();
    p.datasets.push(ds);
    let items = computeContours(ds, { anchors: new Map() }).items;
    let m = buildLegend(p, { contours: [{ datasetId: ds.id, items, envelopes: [] }] });
    expect(m.groups[0].title).toBe('Fire results');
    expect(m.groups[0].items.map((i) => i.title)).toEqual(['R1', '4 kW/m²']);
    // Categorical rule: one entry per drawn category; a filter removes unused categories.
    ds.styleRules = [
      {
        id: 'r1',
        kind: 'categorical',
        column: 'Scenario',
        categories: [
          { value: 'Jet fire', color: '#ef4444' },
          { value: 'Pool fire', color: '#f97316' },
          { value: 'Flash fire', color: '#eab308' },
        ],
      },
    ];
    ds.filter = 'Scenario != "Flash fire"';
    items = computeContours(ds, { anchors: new Map() }).items;
    m = buildLegend(p, {
      contours: [
        {
          datasetId: ds.id,
          items,
          envelopes: [
            { sizeColumn: 'R2', label: '4 kW/m²', color: '#000000', dash: 'solid', strokeWidth: 0.5 },
          ],
        },
      ],
    });
    const titles = m.groups[0].items.map((i) => i.title);
    expect(titles).toContain('Jet fire');
    expect(titles).toContain('Pool fire');
    expect(titles).not.toContain('Flash fire');
    expect(titles).toContain('Envelope – 4 kW/m²');
    // Every drawn contour item has a visible entry.
    const keys = new Set(m.items.filter((i) => !i.hidden).map((i) => i.key));
    for (const it of items) expect(keys.has(`ds:${ds.id}:${it.legendKey}`)).toBe(true);
  });
});
