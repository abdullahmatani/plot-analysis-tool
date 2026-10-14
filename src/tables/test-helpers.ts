import type { CellValue, ContourDataset, Pt } from '@/core/types';

import { normaliseAnchorName } from './access';

/**
 * Test-only helpers for the table modules: fixture loading (Node, via `process.getBuiltinModule`
 * so app type-checking needs no Node types) and a deterministic large-table generator for the
 * NFR-5 performance tests. Not imported by app code.
 */

interface NodeFs {
  readFileSync(path: URL): Uint8Array;
}

/** Reads `tests/fixtures/tables/<name>` as bytes. */
export function readFixture(name: string): Uint8Array {
  const proc = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }).process;
  const fs = proc.getBuiltinModule('node:fs') as NodeFs;
  const url = new URL(`../../tests/fixtures/tables/${name}`, import.meta.url);
  const buf = fs.readFileSync(url);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Small seeded PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const LARGE_COLUMNS = [
  'Tag',
  'Scenario',
  'Category',
  'X',
  'Y',
  'Radiation 4 kW/m2 (m)',
  'Radiation 12.5 kW/m2 (m)',
  'Radiation 37.5 kW/m2 (m)',
  'الوصف',
];

const CATS: [string, string][] = [
  ['Jet fire', 'حريق نفاث'],
  ['Pool fire', 'حريق بركة'],
  ['Flash fire', 'حريق وميضي'],
  ['Fireball', 'كرة نارية'],
  ['Explosion', 'انفجار'],
];

/** A consequence-results table with `n` rows (default 5 000) and three size columns. */
export function makeLargeTable(n = 5000, seed = 42): { columns: string[]; rows: CellValue[][] } {
  const rnd = prng(seed);
  const rows: CellValue[][] = [];
  for (let i = 0; i < n; i++) {
    const tag = `EQ-${String(1000 + (i % 1200)).padStart(4, '0')}`;
    const [cat, ar] = CATS[i % CATS.length];
    const r4 = Math.round((15 + rnd() * 120) * 10) / 10;
    rows.push([
      tag,
      `${tag} case ${i + 1}`,
      cat,
      Math.round(rnd() * 200000) / 100,
      Math.round(rnd() * 150000) / 100,
      r4,
      Math.round(r4 * 0.6 * 10) / 10,
      Math.round(r4 * 0.3 * 10) / 10,
      `${ar} ${i + 1}`,
    ]);
  }
  return { columns: [...LARGE_COLUMNS], rows };
}

/** Anchors for the tags used by `makeLargeTable`. */
export function makeAnchors(count = 1200): Map<string, Pt> {
  const m = new Map<string, Pt>();
  for (let i = 0; i < count; i++) m.set(normaliseAnchorName(`EQ-${1000 + i}`), { x: i * 3, y: i * 2 });
  return m;
}

/** A contour dataset over `table` with sensible defaults (XY positions, three radiation size columns). */
export function makeDataset(
  table: { columns: string[]; rows: CellValue[][] },
  overrides: Partial<ContourDataset> = {},
): ContourDataset {
  const sizeColumns = table.columns.filter((c) => /radiation/i.test(c));
  const colors = ['#2563eb', '#d97706', '#e11d48'];
  return {
    id: 'ds_test',
    name: 'Test dataset',
    visible: true,
    table,
    mapping: {
      position: { mode: 'xy', x: 'X', y: 'Y' },
      sizeColumns,
      sizeMode: 'radius',
      sizeUnit: 'm',
      label: 'Scenario',
      group: 'Category',
    },
    sizeStyles: sizeColumns.map((column, i) => ({
      column,
      visible: true,
      color: colors[i % colors.length],
      dash: 'solid',
      fillOpacity: 0.1,
      strokeWidth: 0.35,
    })),
    styleRules: [],
    labelTemplate: '',
    labelPlacement: 'top',
    envelope: false,
    order: 0,
    ...overrides,
  };
}
