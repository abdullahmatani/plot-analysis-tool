import { describe, expect, it } from 'vitest';

import type { CellValue, Pt, StyleRule } from '@/core/types';

import { compileDatasetFilter } from './access';
import { computeContours, envelopeInputs, normaliseAnchorName } from './contours';
import { compileFilter } from './filter';
import { assignCategoryColors } from './style-rules';
import { importTable } from './table';
import { makeAnchors, makeDataset, makeLargeTable, readFixture } from './test-helpers';
import { validateDataset } from './validate';

function small(rows: CellValue[][], columns = ['Tag', 'Scenario', 'Category', 'X', 'Y', 'R1', 'R2']) {
  return { columns, rows };
}

const anchors = new Map<string, Pt>([
  [normaliseAnchorName('P-101'), { x: 500, y: 600 }],
  [normaliseAnchorName('V-201'), { x: -10, y: 20 }],
]);

describe('computeContours', () => {
  const table = small([
    ['P-101', 'Seal leak', 'Jet fire', 10, 20, 30, 12],
    ['V-201', 'Flange', 'Pool fire', 15, 25, 'N/R', 8],
    ['X-999', 'Unknown', 'Jet fire', 0, 0, 5, 2],
  ]);

  it('makes one concentric item per visible size column, styled per column (row 65)', () => {
    const ds = makeDataset(table, {
      mapping: {
        position: { mode: 'xy', x: 'X', y: 'Y' },
        sizeColumns: ['R1', 'R2'],
        sizeMode: 'radius',
        sizeUnit: 'm',
        label: 'Scenario',
        group: 'Category',
      },
      sizeStyles: [
        { column: 'R1', visible: true, color: '#ff0000', dash: 'solid', fillOpacity: 0.2, strokeWidth: 0.5 },
        { column: 'R2', visible: true, color: '#0000ff', dash: 'dash', fillOpacity: 0, strokeWidth: 0.25 },
      ],
    });
    const { items, skipped } = computeContours(ds, { anchors });
    expect(items.map((i) => [i.row, i.sizeColumn, i.r, i.color, i.dash, i.label])).toEqual([
      [0, 'R1', 30, '#ff0000', 'solid', 'Seal leak'],
      [0, 'R2', 12, '#0000ff', 'dash', 'Seal leak'],
      [1, 'R2', 8, '#0000ff', 'dash', 'Flange'], // R1 "N/R" → no ring
      [2, 'R1', 5, '#ff0000', 'solid', 'Unknown'],
      [2, 'R2', 2, '#0000ff', 'dash', 'Unknown'],
    ]);
    expect(items[0].centre).toEqual({ x: 10, y: 20 });
    expect(items[0].shape).toBe('circle');
    expect(items[0].group).toBe('Jet fire');
    expect(skipped).toBe(0);

    // Toggling a size column hides only that ring set.
    const hidden = computeContours(
      { ...ds, sizeStyles: [{ ...ds.sizeStyles[0], visible: false }, ds.sizeStyles[1]] },
      { anchors },
    );
    expect(hidden.items.map((i) => i.sizeColumn)).toEqual(['R2', 'R2', 'R2']);
  });

  it('positions rows on anchors and lists unmatched anchors (row 64)', () => {
    const ds = makeDataset(table, {
      mapping: {
        position: { mode: 'anchor', anchor: 'Tag' },
        sizeColumns: ['R1'],
        sizeMode: 'radius',
        sizeUnit: 'm',
      },
    });
    const r = computeContours(ds, { anchors });
    expect(r.items.map((i) => [i.row, i.centre])).toEqual([[0, { x: 500, y: 600 }]]);
    expect(r.unmatchedAnchors).toEqual(['X-999']);
    expect(r.skipped).toBe(2); // V-201 has no R1; X-999 is unmatched
    const lower = computeContours({ ...ds, table: small([[' p-101 ', '', '', 0, 0, 1, 1]]) }, { anchors });
    expect(lower.items[0].centre).toEqual({ x: 500, y: 600 });
  });

  it('converts diameter mode and units to metres', () => {
    const ds = makeDataset(table, {
      mapping: {
        position: { mode: 'xy', x: 'X', y: 'Y', coordUnit: 'km' },
        sizeColumns: ['R1'],
        sizeMode: 'diameter',
        sizeUnit: 'ft',
      },
    });
    const { items } = computeContours(ds, { anchors });
    expect(items[0].centre).toEqual({ x: 10000, y: 20000 });
    expect(items[0].r).toBeCloseTo(30 * 0.3048 * 0.5, 12);
  });

  it('builds squares, rectangles and rotations from shape columns', () => {
    const t = small(
      [
        [0, 0, 10, 'square', null, null, 45],
        [0, 0, 10, 'Rect', 8, 4, 90],
        [0, 0, 10, 'rect', null, 4, null], // missing width → square
        [0, 0, 10, 'blob', null, null, 30], // unknown → circle, rotation ignored
      ],
      ['X', 'Y', 'R', 'Shape', 'W', 'H', 'Rot'],
    );
    const ds = makeDataset(t, {
      mapping: {
        position: { mode: 'xy', x: 'X', y: 'Y' },
        sizeColumns: ['R'],
        sizeMode: 'radius',
        sizeUnit: 'm',
        shape: 'Shape',
        width: 'W',
        height: 'H',
        rotation: 'Rot',
      },
    });
    const { items } = computeContours(ds, { anchors });
    expect(items.map((i) => [i.shape, i.r, i.w, i.h, i.rot])).toEqual([
      ['square', 10, undefined, undefined, Math.PI / 4],
      ['rect', 10, 8, 4, Math.PI / 2],
      ['square', 10, undefined, undefined, undefined],
      ['circle', 10, undefined, undefined, undefined],
    ]);
  });

  it('applies style rules, colour columns and hidden categories (row 67)', () => {
    const categories = assignCategoryColors(table.rows.map((r) => r[2]));
    const rule: StyleRule = { id: 'cat', kind: 'categorical', column: 'Category', categories, dash: 'dot' };
    const ds = makeDataset(table, {
      mapping: {
        position: { mode: 'xy', x: 'X', y: 'Y' },
        sizeColumns: ['R1'],
        sizeMode: 'radius',
        sizeUnit: 'm',
        color: 'Tag',
      },
      styleRules: [rule],
    });
    const { items } = computeContours(ds, { anchors });
    expect(items.map((i) => [i.color, i.dash, i.legendKey])).toEqual([
      [categories[0].color, 'dot', 'cat:cat:jet fire'],
      [categories[0].color, 'dot', 'cat:cat:jet fire'],
    ]);
    const hidden = { ...rule, categories: categories.map((c) => ({ ...c, hidden: c.value === 'Jet fire' })) };
    const r2 = computeContours({ ...ds, styleRules: [hidden] }, { anchors });
    expect(r2.items).toHaveLength(0);
    expect(r2.skipped).toBe(3);
    // Colour column used when no rule matches.
    const coloured = { ...ds, table: small([['#00ff00', '', '', 0, 0, 1, 1]]), styleRules: [] };
    expect(computeContours(coloured, { anchors }).items[0].color).toBe('#00ff00');
  });

  it('renders label templates with virtual fields (row 70)', () => {
    const ds = makeDataset(table, {
      mapping: {
        position: { mode: 'xy', x: 'X', y: 'Y' },
        sizeColumns: ['R1'],
        sizeMode: 'diameter',
        sizeUnit: 'm',
        label: 'Scenario',
      },
      labelTemplate: '{label} – {radius:0.0} m (Ø{diameter}) {sizeColumn} #{row} {category} {missing}{TAG}',
    });
    const { items } = computeContours(ds, { anchors });
    expect(items[0].label).toBe('Seal leak – 15.0 m (Ø30) R1 #1 Jet fire P-101');
  });

  it('filters rows: compiled filter, dataset filter and validRows (rows 66, 71)', () => {
    const ds = makeDataset(table, {
      mapping: {
        position: { mode: 'xy', x: 'X', y: 'Y' },
        sizeColumns: ['R1'],
        sizeMode: 'radius',
        sizeUnit: 'm',
        group: 'Category',
      },
      filter: 'category = "jet fire" AND radius > 10',
    });
    expect(computeContours(ds, { anchors }).items.map((i) => i.row)).toEqual([0]);
    expect(computeContours(ds, { anchors, filter: null }).items.map((i) => i.row)).toEqual([0, 2]);
    const f = compileFilter('Tag STARTSWITH "X"', ds.table.columns);
    if (!f.ok) throw new Error(f.error);
    expect(computeContours(ds, { anchors, filter: f }).items.map((i) => i.row)).toEqual([2]);
    expect(
      computeContours(ds, { anchors, filter: null, validRows: new Uint8Array([0, 1, 1]) }).items.map(
        (i) => i.row,
      ),
    ).toEqual([2]);
    expect(compileDatasetFilter({ ...ds, filter: 'nope > 1' }).ok).toBe(false);
    expect(computeContours({ ...ds, filter: 'nope > 1' }, { anchors }).items).toHaveLength(2);
  });

  it('groups items per size column for the envelope option (row 74)', () => {
    const ds = makeDataset(table, {
      mapping: {
        position: { mode: 'xy', x: 'X', y: 'Y' },
        sizeColumns: ['R1', 'R2'],
        sizeMode: 'radius',
        sizeUnit: 'm',
      },
    });
    const groups = envelopeInputs(computeContours(ds, { anchors }).items);
    expect(groups.map((g) => [g.sizeColumn, g.items.length, g.circles.map((c) => c.r)])).toEqual([
      ['R1', 2, [30, 5]],
      ['R2', 3, [12, 8, 2]],
    ]);
  });

  it('works end-to-end on the imported fixture', () => {
    const { table: t } = importTable({ kind: 'xlsx', bytes: readFixture('consequences.xlsx') });
    const ds = makeDataset(t, { labelTemplate: '{Tag} {الوصف}' });
    const v = validateDataset(ds, { anchors: new Map() });
    const r = computeContours(ds, { anchors: new Map(), validRows: v.validRows });
    expect(r.items).toHaveLength(30 * 3 - 3); // three "N/R" cells at 37.5 kW/m²
    expect(r.items[0].label).toBe('P-101 حريق نفاث عند P-101');
  });
});

describe('computeContours performance (NFR-5)', () => {
  it('5 000 rows × 3 size columns with a label template and a categorical rule', () => {
    const table = makeLargeTable(5000);
    const categories = assignCategoryColors(table.rows.map((r) => r[2]));
    const ds = makeDataset(table, {
      styleRules: [{ id: 'cat', kind: 'categorical', column: 'Category', categories }],
      labelTemplate: '{label} – {radius:0.0} m',
    });
    const ctx = { anchors: makeAnchors() };
    computeContours(ds, ctx); // warm-up (JIT)

    const time = (fn: () => void) => {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        fn();
        runs.push(performance.now() - t0);
      }
      return Math.min(...runs);
    };

    let count = 0;
    const base = time(() => {
      count = computeContours(ds, ctx).items.length;
    });
    expect(count).toBe(15000);

    // Re-binding: a different label column, a size column change and a diameter/unit change.
    const relabel = { ...ds, mapping: { ...ds.mapping, label: 'الوصف' } };
    let label = '';
    const rebind = time(() => {
      label = computeContours(relabel, ctx).items[0].label;
    });
    expect(label).toMatch(/^حريق نفاث 1 – \d+\.\d m$/);
    const twoColumns = {
      ...ds,
      mapping: {
        ...ds.mapping,
        sizeColumns: ds.mapping.sizeColumns.slice(1),
        sizeMode: 'diameter' as const,
        sizeUnit: 'ft' as const,
      },
    };
    const resize = time(() => {
      count = computeContours(twoColumns, ctx).items.length;
    });
    expect(count).toBe(10000);
    const filtered = { ...ds, filter: 'category IN ("Jet fire", "Fireball") AND radius > 40' };
    const filter = time(() => {
      count = computeContours(filtered, ctx).items.length;
    });
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(15000);

    console.log(
      `computeContours 5000×3: ${base.toFixed(1)} ms; relabel ${rebind.toFixed(1)} ms; ` +
        `size/mode/unit change ${resize.toFixed(1)} ms; with filter ${filter.toFixed(1)} ms`,
    );
    // NFR-5 target is 100 ms, enforced on the reference machine (PAT_PERF_STRICT=1); elsewhere 250 ms
    // leaves headroom for slow CI machines.
    const budget = process.env.PAT_PERF_STRICT ? 100 : 250;
    expect(base).toBeLessThan(budget);
    expect(rebind).toBeLessThan(budget);
    expect(resize).toBeLessThan(budget);
    expect(filter).toBeLessThan(budget);
  });

  it('validation of 5 000 rows is fast too', () => {
    const ds = makeDataset(makeLargeTable(5000), {
      mapping: { ...makeDataset(makeLargeTable(1)).mapping, position: { mode: 'anchor', anchor: 'Tag' } },
    });
    const t0 = performance.now();
    const v = validateDataset(ds, { anchors: makeAnchors() });
    const ms = performance.now() - t0;
    expect(v.counts.valid).toBe(5000);
    console.log(`validateDataset 5000 rows: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(250);
  });
});
