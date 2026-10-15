import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DwgInsertEntity } from '@mlightcad/libredwg-web';
import { describe, expect, it } from 'vitest';

import { ET_NAME, FLAG, GK, readPoly, type DrawingParseResult } from '@/underlay/entity-store';

import { DwgReadError } from './errors';
import { createLibreDwg, discardLibreDwg, loadLibreDwg } from './libredwg';
import { applyRawSupplement, scanRawObjects } from './raw';
import { readDwg } from './read';

/**
 * DWG fixture tests with the real LibreDWG WebAssembly reader (runs in Node). Fixtures and
 * expectations: tests/fixtures/dwg (README there). Per-entity expectations come from AutoCAD's own
 * DXF export of the same drawings, so they are independent of this importer. Tests skip fixtures
 * that are absent (fetch them with `node scripts/fixtures/dwg-fetch.mjs`).
 */

const DIR = fileURLToPath(new URL('../../../tests/fixtures/dwg/', import.meta.url));
const has = (f: string) => existsSync(DIR + f);
const load = (f: string) => new Uint8Array(readFileSync(DIR + f));

interface Occurrence {
  kind: number;
  geom: number[];
  color: number;
  layer: string;
  lineweight: number;
  linetype: string;
  ltscale: number;
  flags: number;
  text?: string;
}
interface FileExp {
  file: string;
  note: string;
  version?: string;
  error?: string;
  insunits?: number;
  layouts?: string[];
  layers?: { name: string; color: number; linetype: string; off: boolean; frozen: boolean; plot: boolean }[];
  linetypes?: { name: string; pattern: number[] }[];
  counts?: Record<string, number>;
  skipped?: Record<string, number>;
  storeCount?: number;
  storeTypes?: Record<string, number>;
  inBlock?: number;
  derived?: number;
  inserts?: number;
  extents?: number[];
  readerErrors?: boolean;
  entities?: { handle: string; type: string; total: number; occurrences: Occurrence[] }[];
  splines?: { handle: string; points: [number, number][] }[];
  patternSegments?: Record<string, number>;
  layoutChecks?: Record<string, { storeCount: number; skipped: Record<string, number> }>;
}

const EXPECTATIONS: { files: FileExp[] } = has('expectations.json')
  ? JSON.parse(readFileSync(DIR + 'expectations.json', 'utf8'))
  : { files: [] };

const relClose = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

function storeIndices(r: DrawingParseResult, handle: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < r.store.count; i++)
    if (r.store.handles[i] === handle && !(r.store.flags[i] & FLAG.DERIVED)) out.push(i);
  return out;
}

function distToPolyline(p: [number, number], poly: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const ax = poly[i].x;
    const ay = poly[i].y;
    const dx = poly[i + 1].x - ax;
    const dy = poly[i + 1].y - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return best;
}

/** Flips `flips` bytes after the header (deterministic). */
function corrupt(src: Uint8Array, seed: number, flips = 200): Uint8Array {
  const out = Uint8Array.from(src);
  let s = seed;
  for (let i = 0; i < flips; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[128 + (s % (out.length - 128))] ^= 0xff;
  }
  return out;
}

async function rejection(p: Promise<unknown>): Promise<DwgReadError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DwgReadError);
    return e as DwgReadError;
  }
  throw new Error('expected the read to fail');
}

describe('readDwg — reference fixtures', () => {
  for (const exp of EXPECTATIONS.files) {
    it.skipIf(!has(exp.file))(`${exp.file}: ${exp.note}`, { timeout: 60_000 }, async () => {
      const bytes = load(exp.file);
      if (exp.error) {
        const e = await rejection(readDwg(bytes));
        expect(e.code).toBe(exp.error);
        expect(e.version).toBe(exp.version);
        expect(e.message).toMatch(/DXF/);
        return;
      }
      const progress: number[] = [];
      const r = await readDwg(bytes, { onProgress: (f) => progress.push(f) });
      expect(progress[progress.length - 1]).toBe(1);
      expect(progress.every((f, i) => i === 0 || f >= progress[i - 1])).toBe(true);
      expect(r.version).toBe(exp.version);
      expect(r.insunits).toBe(exp.insunits);
      expect(r.layouts).toEqual(exp.layouts);
      expect(r.layout).toBe('Model');
      expect(
        r.store.layers.map((l) => ({
          name: l.name,
          color: l.color,
          linetype: l.linetype,
          off: l.off,
          frozen: l.frozen,
          plot: l.plot,
        })),
      ).toEqual(exp.layers);
      expect(r.store.linetypes.map((l) => ({ name: l.name, pattern: l.pattern }))).toEqual(exp.linetypes);
      expect(r.report.counts).toEqual(exp.counts);
      expect(r.report.skipped).toEqual(exp.skipped);
      expect(r.report.errors.length > 0).toBe(exp.readerErrors);
      expect(r.store.count).toBe(exp.storeCount);
      const types: Record<string, number> = {};
      let inBlock = 0;
      let derived = 0;
      for (let i = 0; i < r.store.count; i++) {
        types[ET_NAME[r.store.type[i]]] = (types[ET_NAME[r.store.type[i]]] ?? 0) + 1;
        if (r.store.flags[i] & FLAG.IN_BLOCK) inBlock++;
        if (r.store.flags[i] & FLAG.DERIVED) derived++;
      }
      expect(types).toEqual(exp.storeTypes);
      expect(inBlock).toBe(exp.inBlock);
      expect(derived).toBe(exp.derived);
      expect(r.store.inserts).toHaveLength(exp.inserts!);
      const ext = [r.extents.minX, r.extents.minY, r.extents.maxX, r.extents.maxY];
      ext.forEach((v, k) => expect(relClose(v, exp.extents![k], 1e-9)).toBe(true));

      for (const e of exp.entities ?? []) {
        const idx = storeIndices(r, e.handle);
        expect(idx.length, `${e.type} ${e.handle}`).toBe(e.total);
        e.occurrences.forEach((o, k) => {
          const i = idx[k];
          const where = `${e.type} ${e.handle} #${k}`;
          expect(r.store.geomKind[i], where).toBe(o.kind);
          const g = r.store.geom.subarray(r.store.geomStart[i], r.store.geomStart[i] + r.store.geomLen[i]);
          // Text entities carry a trailing font index (row 24) not present in the reference data.
          expect(g.length, where).toBe(o.geom.length + (o.kind === GK.TEXT ? 1 : 0));
          o.geom.forEach((v, q) =>
            expect(relClose(g[q], v, 1e-9), `${where} geom[${q}] ${g[q]} vs ${v}`).toBe(true),
          );
          expect(r.store.color[i], where).toBe(o.color);
          expect(r.store.layers[r.store.layer[i]].name, where).toBe(o.layer);
          expect(r.store.lineweight[i], where).toBe(o.lineweight);
          expect(r.store.linetypes[r.store.linetype[i]].name, where).toBe(o.linetype);
          expect(relClose(r.store.ltscale[i], o.ltscale, 1e-6), where).toBe(true);
          expect(r.store.flags[i] & ~FLAG.DERIVED, where).toBe(o.flags);
          if (o.text !== undefined) expect(r.store.texts[r.store.textIndex[i]], where).toBe(o.text);
        });
      }
      for (const s of exp.splines ?? []) {
        const [i] = storeIndices(r, s.handle);
        expect(r.store.geomKind[i]).toBe(GK.POLY);
        const poly = readPoly(r.store, i);
        const xs = s.points.map((p) => p[0]);
        const ys = s.points.map((p) => p[1]);
        const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        // DWG keeps AutoCAD fit splines as fit points only; the interpolation stays within 0.1 %.
        for (const p of s.points) expect(distToPolyline(p, poly)).toBeLessThan(1e-3 * size);
      }
      for (const [handle, n] of Object.entries(exp.patternSegments ?? {})) {
        let segs = 0;
        for (let i = 0; i < r.store.count; i++)
          if (r.store.handles[i] === handle && r.store.flags[i] & FLAG.DERIVED) segs++;
        expect(segs, `pattern of HATCH ${handle}`).toBe(n);
      }
      for (const [layout, c] of Object.entries(exp.layoutChecks ?? {})) {
        const p = await readDwg(bytes, { layout });
        expect(p.layout).toBe(layout);
        expect(p.store.count).toBe(c.storeCount);
        expect(p.report.skipped).toEqual(c.skipped);
      }
    });
  }

  it.skipIf(!has('2004_HatchG.dwg'))(
    'renders gradient hatches as solid fills and keeps true colours',
    async () => {
      const r = await readDwg(load('2004_HatchG.dwg'));
      const fills = [];
      for (let i = 0; i < r.store.count; i++) if (r.store.geomKind[i] === GK.FILL) fills.push(i);
      expect(fills).toHaveLength(2);
      for (const i of fills) expect(r.store.flags[i] & FLAG.PATTERN).toBe(0);
      expect(Array.from(r.store.color)).toContain(0x1ae464);
    },
  );

  it.skipIf(!has('2013_gh109_1.dwg'))(
    'applies $LTSCALE, dashed linetypes and names custom objects',
    async () => {
      const r = await readDwg(load('2013_gh109_1.dwg'));
      expect(r.store.linetypes.find((l) => l.name === 'DOTE')?.pattern).toEqual([2, -0.2, 0.02, -0.2]);
      const dote = r.store.linetypes.findIndex((l) => l.name === 'DOTE');
      const onDote = Array.from(r.store.linetype).filter((lt) => lt === dote).length;
      expect(onDote).toBeGreaterThan(0);
      // $LTSCALE 1000 on top-level entities (block content is further scaled by its reference).
      const top = Array.from({ length: r.store.count }, (_, i) => i).find(
        (i) => !(r.store.flags[i] & FLAG.IN_BLOCK),
      );
      expect(r.store.ltscale[top!]).toBe(1000);
      expect(r.layouts).toEqual(['Model', 'layout1', '布局2']);
      expect(r.store.layers.some((l) => l.name === '洁具')).toBe(true);
      expect(
        r.report.warnings.some((w) => w.startsWith('Custom objects of other applications (TCH_WALL ×9')),
      ).toBe(true);
    },
  );

  it.skipIf(!has('r11_entities-2d.dwg'))('flags pre-R13 formats as limited', async () => {
    const r = await readDwg(load('r11_entities-2d.dwg'));
    expect(r.version).toBe('AC1009');
    expect(r.report.warnings[0]).toMatch(/^AutoCAD R11\/R12 \(AC1009\) is an old or pre-release DWG format/);
    expect(r.store.count).toBeGreaterThan(0);
  });
});

describe('readDwg — failures are readable and never hang', () => {
  it.skipIf(!has('sample_2000.dwg'))('refuses formats newer than AC1032 with a clear message', async () => {
    for (const code of ['AC1033', 'AC1040', 'AC103-']) {
      const bytes = load('sample_2000.dwg');
      bytes.set(
        Array.from(code, (c) => c.charCodeAt(0)),
        0,
      );
      const e = await rejection(readDwg(bytes));
      expect(e.code).toBe('unsupported-version');
      expect(e.version).toBe(code);
      expect(e.message).toBe(
        `DWG format newer than AutoCAD 2018 (${code}) is not supported — save as DWG 2018 or export DXF/PDF.`,
      );
    }
    const odd = load('sample_2000.dwg');
    odd.set([65, 67, 57, 57, 57, 57], 0); // "AC9999"
    const e = await rejection(readDwg(odd));
    expect(e.code).toBe('unsupported-version');
    expect(e.message).toBe('Unrecognised DWG format code "AC9999" — save as DWG 2018 or export DXF/PDF.');
  });

  it('rejects data that is not a DWG', async () => {
    const dxf = new TextEncoder().encode('  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n');
    expect((await rejection(readDwg(dxf))).code).toBe('not-dwg');
    expect((await rejection(readDwg(new Uint8Array(0)))).message).toBe('The file is empty.');
    expect(
      (await rejection(readDwg(Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251)))).code,
    ).toBe('not-dwg');
  });

  it.skipIf(!has('sample_2000.dwg'))('enforces the size limit before starting the reader', async () => {
    const e = await rejection(readDwg(load('sample_2000.dwg'), { maxBytes: 10_000 }));
    expect(e.code).toBe('too-large');
    expect(e.message).toMatch(
      /^This DWG is 0\.0 MB, more than the 0\.0 MB the in-browser DWG reader can handle\. Export/,
    );
  });

  it.skipIf(!has('example_2018.dwg'))('explains truncated files', { timeout: 30_000 }, async () => {
    const t0 = Date.now();
    const e = await rejection(readDwg(load('example_2018.dwg').subarray(0, 60_000)));
    expect(e.code).toBe('read-failed');
    expect(e.message).toBe(
      'No drawing content could be read from this AutoCAD 2018 DWG: the reader reported a missing section (the file may be truncated or damaged). Export the drawing from your CAD application as DXF (any version) or plot it to PDF, and import that instead.',
    );
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it.skipIf(!has('example_2018.dwg'))(
    'returns partial results with report.errors for damaged files',
    { timeout: 60_000 },
    async () => {
      const src = load('example_2018.dwg');
      let partial = 0;
      for (const seed of [1, 4, 5, 8, 10, 11]) {
        const lib = await createLibreDwg();
        try {
          const r = await readDwg(corrupt(src, seed), { libredwg: lib });
          expect(r.report.errors.length).toBeGreaterThan(0);
          expect(r.report.errors[0]).toMatch(/^The DWG reader reported .*export the drawing as DXF or PDF/);
          if (r.store.count > 0) partial++;
        } catch (e) {
          expect(e).toBeInstanceOf(DwgReadError);
          expect((e as Error).message).toMatch(/DXF/);
        }
      }
      expect(partial).toBeGreaterThan(0);
    },
  );

  it.skipIf(!has('2004_HatchG.dwg') || !has('sample_2000.dwg'))(
    'turns a LibreDWG crash into a readable error and recovers for the next file',
    { timeout: 60_000 },
    async () => {
      // A damaged copy on which LibreDWG traps (WebAssembly "memory access out of bounds").
      const e = await rejection(readDwg(corrupt(load('2004_HatchG.dwg'), 49, 20)));
      expect(e.code).toBe('reader-crashed');
      expect(e.message).toMatch(
        /^The DWG reader stopped while (reading|converting) this AutoCAD 2004 file \(memory access out of bounds\)\. The file may be damaged/,
      );
      const r = await readDwg(load('sample_2000.dwg'));
      expect(r.store.count).toBe(6);
    },
  );

  it.skipIf(!has('example_2018.dwg'))('reports unknown layouts', async () => {
    const e = await rejection(readDwg(load('example_2018.dwg'), { layout: 'Sheet 9' }));
    expect(e.code).toBe('layout-not-found');
    expect(e.message).toBe('Layout "Sheet 9" not found. Available layouts: Model, Layout1, Layout2');
  });
});

describe('LibreDWG integration details', () => {
  it.skipIf(!has('example_2018.dwg'))(
    'starts and reads a DWG without generating code at run time (CSP without unsafe-eval; U-1, row 88)',
    async () => {
      // What a Content-Security-Policy without 'unsafe-eval' forbids: the Function constructor and eval.
      const g = globalThis as unknown as { Function: FunctionConstructor; eval: (code: string) => unknown };
      const realFunction = g.Function;
      const realEval = g.eval;
      const blocked = () => {
        throw new EvalError('code generation blocked by the test (as by the CSP)');
      };
      g.Function = new Proxy(realFunction, { apply: blocked, construct: blocked });
      g.eval = blocked;
      try {
        const lib = await createLibreDwg();
        const r = await readDwg(load('example_2018.dwg'), { libredwg: lib });
        const exp = EXPECTATIONS.files.find((f) => f.file === 'example_2018.dwg');
        expect(r.store.count).toBe(exp?.storeCount);
      } finally {
        g.Function = realFunction;
        g.eval = realEval;
      }
    },
  );

  it('caches one LibreDWG instance per worker and replaces it after a discard', async () => {
    const a = await loadLibreDwg();
    expect(await loadLibreDwg()).toBe(a);
    discardLibreDwg();
    const b = await loadLibreDwg();
    expect(b).not.toBe(a);
  });

  it.skipIf(!has('example_2018.dwg'))(
    'restores BYBLOCK/CONTINUOUS linetypes and lists dropped entity types',
    async () => {
      const lib = await createLibreDwg();
      lib.FS.writeFile('/raw.dwg', load('example_2018.dwg'));
      const res = lib.dwg_read_file('/raw.dwg') as { error: number; data: number };
      lib.FS.unlink('/raw.dwg');
      const db = lib.convert(res.data);
      const sup = scanRawObjects(lib, res.data, db);
      lib.dwg_free(res.data);
      expect(sup.ltypeFlags.get('3AF')).toBe(2);
      expect(sup.ltypeFlags.get('4F4')).toBe(1);
      expect(sup.extras.map((x) => `${x.entity.type}@${x.owner}`).sort()).toEqual([
        'ARC_DIMENSION@1F',
        'LIGHT@1F',
        'POLYLINE (polyface mesh)@1F',
        'REGION@1F',
        'REGION@1F',
      ]);
      applyRawSupplement(db, sup);
      const table = db.tables.BLOCK_RECORD.entries.find((b) => b.name === '*T13');
      expect(table?.entities.find((e) => e.handle === '4F4')?.lineType).toBe('ByBlock');
      const model = db.tables.BLOCK_RECORD.entries.find((b) => b.name === '*Model_Space');
      expect(model?.entities.filter((e) => e.type === 'REGION')).toHaveLength(2);
    },
  );

  it('places rebuilt block arrays in their owner block', () => {
    const db = {
      tables: { BLOCK_RECORD: { entries: [{ name: '*Model_Space', handle: '1F', entities: [] }] } },
    } as unknown as Parameters<typeof applyRawSupplement>[0];
    const minsert = {
      type: 'INSERT',
      handle: 'A1',
      name: 'B',
      columnCount: 3,
      rowCount: 2,
    } as unknown as DwgInsertEntity;
    applyRawSupplement(db, {
      ltypeFlags: new Map(),
      extras: [{ owner: '1F', entity: minsert }],
      minsertFailures: 0,
      customClasses: new Map(),
    });
    expect(db.tables.BLOCK_RECORD.entries[0].entities).toEqual([
      { ...minsert, ownerBlockRecordSoftId: '1F' },
    ]);
  });
});
