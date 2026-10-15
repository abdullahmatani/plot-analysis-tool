import { describe, expect, it } from 'vitest';

import { parseTableInWorker } from '@/features/contours/table-client';
import { ParseCancelled } from '@/import/parse-client';

import { HEADER_CHOICES, forImportDialog, parseSource, type TableSource } from './source';

const csv = (rows: number): TableSource => ({
  kind: 'csv',
  name: 'results.csv',
  text: [
    'Tag,X,Y,R',
    ...Array.from({ length: rows }, (_, i) => `P-${i},${600_000 + i},2500000,${10 + i}`),
  ].join('\n'),
});

describe('table parsing for the import dialog (rows 21, 62)', () => {
  it('keeps the whole table but only the raw rows offered as header choices', () => {
    const full = parseSource(csv(500));
    const r = forImportDialog(full);
    expect(full.raw.length).toBe(501);
    expect(r.raw).toEqual(full.raw.slice(0, HEADER_CHOICES));
    expect(r.table).toBe(full.table);
    expect(r.table.rows).toHaveLength(500);
    expect(r.preview).toEqual(full.preview);
    expect(r.headerRow).toBe(0);
  });

  it('honours the parse options (header row, delimiter)', () => {
    const src: TableSource = { kind: 'csv', name: 't.csv', text: 'title\nA;B\n1;2' };
    const r = parseSource(src, { headerRow: 1, delimiter: ';' });
    expect(r.table.columns).toEqual(['A', 'B']);
    expect(r.table.rows).toEqual([[1, 2]]);
  });

  it('parses in place where Web Workers are unavailable, and can be cancelled', async () => {
    const job = parseTableInWorker(csv(3), {});
    expect((await job.promise).table.rows).toHaveLength(3);
    const cancelled = parseTableInWorker(csv(3), {});
    cancelled.cancel();
    await expect(cancelled.promise).rejects.toBeInstanceOf(ParseCancelled);
  });

  it('reports unreadable input as an error, not as a cancellation', async () => {
    const job = parseTableInWorker({ kind: 'xlsx', name: 'bad.xlsx', bytes: new Uint8Array([1, 2, 3]) }, {});
    await expect(job.promise).rejects.toThrow();
    await expect(job.promise).rejects.not.toBeInstanceOf(ParseCancelled);
  });
});
