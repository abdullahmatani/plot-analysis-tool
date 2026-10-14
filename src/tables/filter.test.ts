import { describe, expect, it } from 'vitest';

import type { CellValue } from '@/core/types';

import { compileFilter } from './filter';

const columns = ['Tag', 'Category', 'Radius', 'Radiation 4 kW/m2 (m)', 'Visible', 'Note', 'الوصف'];
const rows: CellValue[][] = [
  ['P-101', 'Jet fire', 25, 40, 'TRUE', null, 'حريق نفاث'],
  ['P-102', 'Pool fire', 15, '30', 'FALSE', 'leak', 'حريق بركة'],
  ['V-201', 'jet fire', 30.5, 55, 'yes', 'Big leak', null],
  ['T-301', 'Flash fire', null, 'n/a', null, '', 'كرة نارية'],
];

function run(expr: string, opts?: Parameters<typeof compileFilter>[2]): string[] {
  const f = compileFilter(expr, columns, opts);
  if (!f.ok) throw new Error(`${f.error} @${f.position}`);
  return rows.filter((r) => f.test(r)).map((r) => r[0] as string);
}

describe('compileFilter', () => {
  it('handles the spec example (case-insensitive strings)', () => {
    expect(run('category = "Jet fire" AND radius > 20')).toEqual(['P-101', 'V-201']);
  });

  it('supports all comparison operators', () => {
    expect(run('radius == 25')).toEqual(['P-101']);
    expect(run('radius != 25')).toEqual(['P-102', 'V-201', 'T-301']);
    expect(run('radius <> 25')).toEqual(['P-102', 'V-201', 'T-301']);
    expect(run('radius < 25')).toEqual(['P-102']);
    expect(run('radius <= 25')).toEqual(['P-101', 'P-102']);
    expect(run('radius >= 25')).toEqual(['P-101', 'V-201']);
    expect(run("tag > 'p-2'")).toEqual(['V-201', 'T-301']);
  });

  it('supports AND/OR/NOT, && || !, and parentheses with correct precedence', () => {
    expect(run('radius > 20 or category = "pool fire" and tag = "P-102"')).toEqual([
      'P-101',
      'P-102',
      'V-201',
    ]);
    expect(run('(radius > 20 || category = "pool fire") && !(tag = "V-201")')).toEqual(['P-101', 'P-102']);
    expect(run('NOT radius > 20')).toEqual(['P-102', 'T-301']);
  });

  it('resolves [bracketed], `backticked` and case-insensitive column names, plus aliases', () => {
    expect(run('[Radiation 4 kW/m2 (m)] >= 40')).toEqual(['P-101', 'V-201']);
    expect(run('`radiation 4 kw/m2 (m)` < 35')).toEqual(['P-102']);
    expect(run('radiation_4_kW_m2 > 50')).toEqual(['V-201']);
    expect(run('size > 50', { aliases: { size: 'Radiation 4 kW/m2 (m)' } })).toEqual(['V-201']);
    expect(run('الوصف CONTAINS "حريق"')).toEqual(['P-101', 'P-102']);
  });

  it('coerces numbers and numeric strings', () => {
    expect(run('[Radiation 4 kW/m2 (m)] = 30')).toEqual(['P-102']);
    expect(run('radius = "25"')).toEqual(['P-101']);
  });

  it('supports IN, CONTAINS, STARTSWITH, ENDSWITH, LIKE and their negations', () => {
    expect(run('category IN ("jet fire", "Flash fire")')).toEqual(['P-101', 'V-201', 'T-301']);
    expect(run('radius NOT IN (25, 15)')).toEqual(['V-201', 'T-301']);
    expect(run('note CONTAINS "LEAK"')).toEqual(['P-102', 'V-201']);
    expect(run('note NOT CONTAINS "big"')).toEqual(['P-101', 'P-102', 'T-301']);
    expect(run('tag STARTSWITH "p-"')).toEqual(['P-101', 'P-102']);
    expect(run('tag ENDSWITH "01"')).toEqual(['P-101', 'V-201', 'T-301']);
    expect(run('tag LIKE "P-10_"')).toEqual(['P-101', 'P-102']);
    expect(run('category LIKE "%fire"')).toEqual(['P-101', 'P-102', 'V-201', 'T-301']);
    expect(run('category NOT LIKE "%jet%"')).toEqual(['P-102', 'T-301']);
    expect(run('tag LIKE "p.1%"')).toEqual([]); // regex characters are literal
  });

  it('supports IS NULL / IS NOT NULL and NULL equality', () => {
    expect(run('note IS NULL')).toEqual(['P-101', 'T-301']);
    expect(run('note is not null')).toEqual(['P-102', 'V-201']);
    expect(run('radius = null')).toEqual(['T-301']);
  });

  it('supports arithmetic, unary minus and Unicode operators', () => {
    expect(run('radius * 2 > 55')).toEqual(['V-201']);
    expect(run('radius × 2 − 10 >= 40')).toEqual(['P-101', 'V-201']);
    expect(run('[Radiation 4 kW/m2 (m)] / radius > 1.7')).toEqual(['P-102', 'V-201']);
    expect(run('-radius < -26')).toEqual(['V-201']);
    expect(run('radius + 1 = 26 OR radius % 2 = 1')).toEqual(['P-101', 'P-102']);
  });

  it('supports booleans and bare truthy columns', () => {
    expect(run('visible = true')).toEqual(['P-101', 'V-201']);
    expect(run('visible')).toEqual(['P-101', 'V-201']);
    expect(run('NOT visible')).toEqual(['P-102', 'T-301']);
  });

  it('reports columns used and accepts an empty expression', () => {
    const f = compileFilter('Radius > 1 and [Category] = "x" or radius < 0', columns);
    expect(f.ok && f.columnsUsed).toEqual(['Radius', 'Category']);
    const empty = compileFilter('   ', columns);
    expect(empty.ok && empty.test(rows[0])).toBe(true);
  });

  it('reports errors with positions', () => {
    const cases: [string, RegExp, number][] = [
      ['radius > ', /end of expression/, 9],
      ['foo = 1', /Unknown column 'foo'/, 0],
      ['category = "jet', /Unterminated string/, 11],
      ['(radius > 1', /Expected '\)'/, 11],
      ['radius > 1 radius', /Unexpected 'radius'/, 11],
      ['radius @ 2', /Unexpected character '@'/, 7],
      ['[Nope] = 1', /Unknown column 'Nope'/, 0],
      ['radius IS 3', /Expected 'NULL'/, 10],
      ['radius > 20m', /Unexpected character 'm'/, 11],
    ];
    for (const [expr, re, pos] of cases) {
      const f = compileFilter(expr, columns);
      expect(f.ok, expr).toBe(false);
      if (!f.ok) {
        expect(f.error, expr).toMatch(re);
        expect(f.position, expr).toBe(pos);
      }
    }
  });

  it('never evaluates code', () => {
    const f = compileFilter('constructor = "x" OR __proto__ = 1', ['constructor', '__proto__']);
    expect(f.ok).toBe(true);
    const bad = compileFilter('alert(1)', columns);
    expect(bad.ok).toBe(false);
  });

  it('filters 5 000 rows quickly', () => {
    const big: CellValue[][] = Array.from({ length: 5000 }, (_, i) => [
      `T-${i}`,
      i % 2 ? 'Jet fire' : 'Pool fire',
      i % 50,
      i,
      null,
      null,
      null,
    ]);
    const f = compileFilter('category = "Jet fire" AND radius > 20 AND tag LIKE "T-1%"', columns);
    if (!f.ok) throw new Error(f.error);
    let n = 0;
    // Best of 5 after a warm-up, so a GC pause or a busy CI runner does not decide the result.
    const runs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      n = 0;
      for (const r of big) if (f.test(r)) n++;
      if (i > 0) runs.push(performance.now() - t0);
    }
    expect(n).toBeGreaterThan(0);
    expect(Math.min(...runs)).toBeLessThan(50);
  });
});
