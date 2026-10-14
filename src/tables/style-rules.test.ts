import { describe, expect, it } from 'vitest';

import { PALETTE } from '@/core/project';
import type { StyleRule } from '@/core/types';

import {
  assignCategoryColors,
  classify,
  colorForRow,
  compileStyleRules,
  equalIntervalBreaks,
  jenksBreaks,
  legendEntriesForRule,
  makeGraduatedBreaks,
  parseColor,
  quantileBreaks,
  rampColor,
  rampColors,
} from './style-rules';
import { prng } from './test-helpers';

describe('categorical colours (row 67)', () => {
  it('assigns palette colours in order of first appearance, skipping blanks and duplicates', () => {
    const cats = assignCategoryColors(['Jet fire', null, 'Pool fire', 'jet fire ', '', 'Flash fire']);
    expect(cats).toEqual([
      { value: 'Jet fire', color: PALETTE[0] },
      { value: 'Pool fire', color: PALETTE[1] },
      { value: 'Flash fire', color: PALETTE[2] },
    ]);
  });

  it('keeps existing colours stable and gives a new value the next free colour and a legend entry', () => {
    const existing = [
      { value: 'Pool fire', color: PALETTE[0], label: 'Pool fires' },
      { value: 'Jet fire', color: '#123456', hidden: true },
    ];
    const cats = assignCategoryColors(['Jet fire', 'Pool fire', 'Fireball'], existing);
    expect(cats.slice(0, 2)).toEqual(existing);
    expect(cats[2]).toEqual({ value: 'Fireball', color: PALETTE[1] });
    const rule: StyleRule = { id: 'r1', kind: 'categorical', column: 'Category', categories: cats };
    expect(legendEntriesForRule(rule).map((e) => e.label)).toEqual(['Pool fires', 'Fireball']);
  });

  it('generates distinct colours beyond the palette', () => {
    const values = Array.from({ length: PALETTE.length + 10 }, (_, i) => `v${i}`);
    const cats = assignCategoryColors(values);
    expect(new Set(cats.map((c) => c.color)).size).toBe(values.length);
  });
});

describe('ramps', () => {
  it('interpolates between stops', () => {
    expect(rampColor('viridis', 0)).toBe('#440154');
    expect(rampColor('viridis', 1)).toBe('#fde725');
    expect(rampColor('red-blue', 0.5)).toBe('#f7f7f7');
    expect(rampColor('unknown', 0)).toBe('#440154');
    expect(rampColors('reds', 3)).toEqual(['#fcbba1', rampColor('reds', 0.5), '#67000d']);
  });
});

describe('class breaks', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('equal interval', () => {
    expect(equalIntervalBreaks(values, 3)).toEqual([4, 7, 10]);
    expect(equalIntervalBreaks([5, 5], 3)).toEqual([5]);
  });

  it('quantile', () => {
    expect(quantileBreaks(values, 2)).toEqual([5, 10]);
    expect(quantileBreaks([1, 1, 1, 2], 4)).toEqual([1, 2]);
  });

  it('natural breaks find obvious clusters', () => {
    expect(jenksBreaks([1, 2, 3, 10, 11, 12, 30, 31, 32], 3)).toEqual([3, 12, 32]);
    expect(jenksBreaks([4, 4, 4], 3)).toEqual([4]);
    expect(jenksBreaks(['1', '2', '20', null, 'x', '21'], 2)).toEqual([2, 21]);
  });

  it('natural breaks match brute force on random data', () => {
    const rnd = prng(7);
    const data = Array.from({ length: 40 }, () => Math.round(rnd() * 1000) / 10).sort((a, b) => a - b);
    const sse = (cls: number[]) => {
      const m = cls.reduce((a, b) => a + b, 0) / cls.length;
      return cls.reduce((a, b) => a + (b - m) ** 2, 0);
    };
    // Brute force over all 3-class splits of the sorted data.
    let best = Infinity;
    for (let i = 1; i < data.length - 1; i++) {
      for (let j = i + 1; j < data.length; j++) {
        best = Math.min(best, sse(data.slice(0, i)) + sse(data.slice(i, j)) + sse(data.slice(j)));
      }
    }
    const b = jenksBreaks(data, 3);
    const classes: number[][] = [[], [], []];
    for (const v of data) classes[classify(v, b)].push(v);
    expect(classes.reduce((a, c) => a + sse(c), 0)).toBeCloseTo(best, 9);
  });

  it('natural breaks on 5 000 values are fast', () => {
    const rnd = prng(3);
    const data = Array.from({ length: 5000 }, () => rnd() * 500);
    // Best of 3 after a warm-up, so a GC pause or a busy CI runner does not decide the result.
    let b = jenksBreaks(data, 7);
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      b = jenksBreaks(data, 7);
      runs.push(performance.now() - t0);
    }
    expect(b).toHaveLength(7);
    expect(Math.min(...runs)).toBeLessThan(200);
  });

  it('classify uses upper bounds and clamps above the last', () => {
    const breaks = [10, 20, 30];
    expect(classify(5, breaks)).toBe(0);
    expect(classify(10, breaks)).toBe(0);
    expect(classify(10.01, breaks)).toBe(1);
    expect(classify(30, breaks)).toBe(2);
    expect(classify(99, breaks)).toBe(2);
    expect(classify(null, breaks)).toBe(-1);
    expect(classify(NaN, breaks)).toBe(-1);
    expect(classify(15, [{ upTo: 10 }, { upTo: 20 }])).toBe(1);
  });

  it('makes graduated classes with ramp colours and labels', () => {
    const b = makeGraduatedBreaks(values, 3, 'equal', 'blues');
    expect(b.map((x) => x.upTo)).toEqual([4, 7, 10]);
    expect(b.map((x) => x.label)).toEqual(['1 – 4', '4 – 7', '7 – 10']);
    expect(b[0].color).toBe('#c6dbef');
  });
});

describe('colorForRow and legend', () => {
  const columns = ['Tag', 'Category', 'Radius'];
  const rules: StyleRule[] = [
    {
      id: 'cat',
      kind: 'categorical',
      column: 'category',
      categories: [
        { value: 'Jet fire', color: '#ff0000' },
        { value: 'Pool fire', color: '#0000ff', hidden: true },
      ],
      dash: 'dash',
    },
    {
      id: 'grad',
      kind: 'graduated',
      column: 'Radius',
      breaks: [
        { upTo: 20, color: '#111111' },
        { upTo: 10, color: '#000000', label: 'Small' },
      ],
      fillOpacity: 0.3,
    },
  ];
  const fallback = { color: '#999999', dash: 'solid' as const, fillOpacity: 0.1 };

  it('uses the first matching rule, then the fallback', () => {
    expect(colorForRow(rules, ['P-1', 'jet fire', 5], columns, fallback)).toEqual({
      color: '#ff0000',
      dash: 'dash',
      fillOpacity: 0.1,
      legendKey: 'cat:cat:jet fire',
    });
    expect(colorForRow(rules, ['P-2', 'Pool fire', 5], columns, fallback).hidden).toBe(true);
    expect(colorForRow(rules, ['P-3', 'Fireball', 5], columns, fallback)).toEqual({
      color: '#000000',
      dash: 'solid',
      fillOpacity: 0.3,
      legendKey: 'grad:brk:1',
    });
    expect(colorForRow(rules, ['P-4', 'Fireball', 15], columns, fallback).color).toBe('#111111');
    expect(colorForRow(rules, ['P-5', null, null], columns, fallback)).toEqual(fallback);
  });

  it('ignores rules on missing columns', () => {
    const f = compileStyleRules([{ id: 'x', kind: 'categorical', column: 'Nope', categories: [] }], columns);
    expect(f(['a', 'b', 1])).toBeNull();
  });

  it('generates legend entries in class order', () => {
    expect(legendEntriesForRule(rules[1])).toEqual([
      { key: 'grad:brk:1', label: 'Small', color: '#000000' },
      { key: 'grad:brk:0', label: '10 – 20', color: '#111111' },
    ]);
    expect(legendEntriesForRule(rules[0])).toEqual([
      { key: 'cat:cat:jet fire', label: 'Jet fire', color: '#ff0000' },
    ]);
  });

  it('parses colour cells', () => {
    expect(parseColor('#F00')).toBe('#ff0000');
    expect(parseColor('00ff00')).toBe('#00ff00');
    expect(parseColor('rgb(0, 0, 255)')).toBe('#0000ff');
    expect(parseColor('Orange')).toBe('#ffa500');
    expect(parseColor('nope')).toBeNull();
    expect(parseColor(12)).toBeNull();
  });
});
