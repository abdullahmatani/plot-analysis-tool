import { describe, expect, it } from 'vitest';
import { ACI_RGB, aciToRgb } from '@/underlay/aci';
import {
  ET,
  EntityStoreBuilder,
  FLAG,
  GK,
  emptyReport,
  type DrawingParseResult,
  type EntityStore,
} from '@/underlay/entity-store';
import { buildDocument } from './document';
import { Emitter } from './emit';
import { codepageToLabel, decodeText } from './encoding';
import { generatePattern } from './hatch';
import { mtextToPlain } from './mtext';
import { interpolateFitPoints, tessellateNurbs } from './spline';
import { tokenizeAscii } from './tokenizer';
import { ocsXform } from './xform';
import { DxfAbortError, DxfParseError, isBinaryDxf, parseDxf, sniffDxf } from './index';

// ---------------------------------------------------------------------------------------------
// Helpers to write small DXF documents inline.

type Val = string | number;
const pairs = (...items: Val[]): string => {
  let s = '';
  for (let i = 0; i < items.length; i += 2) s += `${items[i]}\n${items[i + 1]}\n`;
  return s;
};
const section = (name: string, body: string) => pairs(0, 'SECTION', 2, name) + body + pairs(0, 'ENDSEC');

interface DocParts {
  version?: string;
  header?: string;
  tables?: string;
  blocks?: string;
  entities?: string;
  objects?: string;
}
function dxfText(p: DocParts): string {
  return (
    section('HEADER', pairs(9, '$ACADVER', 1, p.version ?? 'AC1015') + (p.header ?? '')) +
    (p.tables ? section('TABLES', p.tables) : '') +
    (p.blocks ? section('BLOCKS', p.blocks) : '') +
    section('ENTITIES', p.entities ?? '') +
    (p.objects ? section('OBJECTS', p.objects) : '') +
    pairs(0, 'EOF')
  );
}
const enc = (s: string) => new TextEncoder().encode(s);
const parse = (p: DocParts, opts?: Parameters<typeof parseDxf>[1]) => parseDxf(enc(dxfText(p)), opts);

const geomOf = (s: EntityStore, i: number) =>
  Array.from(s.geom.subarray(s.geomStart[i], s.geomStart[i] + s.geomLen[i]));
const textOf = (s: EntityStore, i: number) => s.texts[s.textIndex[i]];
const byKind = (r: DrawingParseResult, kind: number) => {
  const out: number[] = [];
  for (let i = 0; i < r.store.count; i++) if (r.store.geomKind[i] === kind) out.push(i);
  return out;
};

const line = (x1: Val, y1: Val, x2: Val, y2: Val, extra = '', layer = '0') =>
  pairs(0, 'LINE', 8, layer) + extra + pairs(10, x1, 20, y1, 11, x2, 21, y2);
const block = (name: string, body: string, base: [number, number] = [0, 0]) =>
  pairs(0, 'BLOCK', 8, '0', 2, name, 70, 0, 10, base[0], 20, base[1], 30, 0, 3, name) +
  body +
  pairs(0, 'ENDBLK', 8, '0');
const insert = (name: string, x: number, y: number, extra = '') =>
  pairs(0, 'INSERT', 8, '0', 2, name, 10, x, 20, y) + extra;

// ---------------------------------------------------------------------------------------------

describe('signature detection', () => {
  it('detects ASCII and binary DXF and rejects other files', () => {
    expect(sniffDxf(enc(dxfText({})))).toBe(true);
    expect(sniffDxf(enc('999\nwritten by a tool\n  0\r\nSECTION\r\n  2\r\nHEADER\r\n'))).toBe(true);
    expect(sniffDxf(enc('\ufeff0\nSECTION\n'))).toBe(true);
    const bin = new Uint8Array([...enc('AutoCAD Binary DXF\r\n\x1a'), 0, 0, 0]);
    expect(isBinaryDxf(bin)).toBe(true);
    expect(sniffDxf(bin)).toBe(true);
    expect(sniffDxf(enc('%PDF-1.7\n%âãÏÓ\n'))).toBe(false);
    expect(sniffDxf(new Uint8Array([0x41, 0x43, 0x31, 0x30, 0x33, 0x32, 0, 0]))).toBe(false); // DWG
    expect(sniffDxf(enc('hello world'))).toBe(false);
    expect(isBinaryDxf(enc('  0\nSECTION\n'))).toBe(false);
  });
});

describe('errors and recovery', () => {
  it('rejects non-DXF input with DxfParseError', () => {
    expect(() => parseDxf(enc('%PDF-1.7\n1 0 obj\n'))).toThrow(DxfParseError);
    expect(() => parseDxf(new Uint8Array(0))).toThrow(/empty/);
    expect(() => parseDxf(new ArrayBuffer(16))).toThrow(DxfParseError);
  });

  it('reports the line of an invalid group code', () => {
    const text = dxfText({ entities: line(0, 0, 1, 1) + pairs('X1', 5) });
    const lineNo = text.split('\n').indexOf('X1') + 1;
    try {
      parseDxf(enc(text));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DxfParseError);
      expect((e as DxfParseError).line).toBe(lineNo);
      expect((e as Error).message).toMatch(/Invalid group code "X1".*line \d+/);
    }
  });

  it('skips invalid entities with a warning and keeps going', () => {
    const r = parse({
      entities:
        line(0, 0, 'abc', 1) +
        pairs(0, 'CIRCLE', 8, '0', 10, 1, 20, 1, 40, -5) +
        line(1, 1, 2, 2) +
        pairs(0, 'ARC', 8, '0', 10, 0, 20, 0, 40, 1, 50, 0, 51, 90),
    });
    expect(r.store.count).toBe(2);
    expect(r.report.counts).toEqual({ LINE: 1, ARC: 1 });
    expect(r.report.skipped).toEqual({ LINE: 1, CIRCLE: 1 });
    expect(r.report.warnings.join('\n')).toMatch(
      /2 invalid entities were skipped \(LINE at line \d+: .*; CIRCLE at line \d+: radius/,
    );
  });

  it('recovers what it can from a truncated file', () => {
    const full = dxfText({ entities: line(0, 0, 1, 1) + line(2, 2, 3, 3) + line(4, 4, 5, 5) });
    const cut = full.slice(0, full.lastIndexOf('LINE') + 20);
    const r = parseDxf(enc(cut));
    expect(r.store.count).toBe(2);
    expect(r.report.errors.join(' ')).toMatch(/not terminated|truncated/);
  });

  it('throws for an unknown layout and lists the available ones', () => {
    expect(() => parse({ entities: line(0, 0, 1, 1) }, { layout: 'Nope' })).toThrow(
      /Layout "Nope" not found.*Model/,
    );
  });

  it('honours an already-aborted signal and aborts mid-way', () => {
    expect(() => parse({ entities: line(0, 0, 1, 1) }, { signal: { aborted: true } })).toThrow(DxfAbortError);
    const big = makeLargeDxf(2 * 1024 * 1024).bytes;
    const signal = { aborted: false };
    expect(() =>
      parseDxf(big, {
        signal,
        onProgress: (f) => {
          if (f > 0.3) signal.aborted = true;
        },
      }),
    ).toThrow(DxfAbortError);
  });

  it('reports monotonic progress ending at 1', () => {
    const seen: number[] = [];
    parseDxf(makeLargeDxf(2 * 1024 * 1024).bytes, { onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(40);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
      expect(seen[i] - seen[i - 1]).toBeLessThanOrEqual(0.05);
    }
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('stops runaway nested arrays with an error instead of hanging', () => {
    const arr = pairs(70, 100, 71, 100, 44, 1, 45, 1);
    let blocks = '';
    for (let k = 0; k < 6; k++) blocks += block(`A${k}`, insert(`A${k + 1}`, 0, 0, arr));
    blocks += block('A6', line(0, 0, 1, 0));
    const t0 = performance.now();
    const r = parse({ blocks, entities: insert('A0', 0, 0) });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.report.errors.join(' ')).toMatch(
      /"A0" \(line \d+\) would expand to about [\d.]+e\+\d+ entities/,
    );
    expect(r.report.skipped).toEqual({ INSERT: 1 });
  });

  it('stops flattening at the entity limit when many top-level references add up', () => {
    // Each reference expands to 10^4 entities (below the per-reference estimate limit); the run-time
    // limit (lowered here through the internal emitter options) stops the import.
    const arr = pairs(70, 100, 71, 100, 44, 1, 45, 1);
    const blocks = block('Q', line(0, 0, 1, 0));
    let entities = '';
    for (let k = 0; k < 12; k++) entities += insert('Q', k, 0, arr);
    const tok = tokenizeAscii(dxfText({ blocks, entities }));
    const doc = buildDocument(tok.tags, tok.recs, tok.truncated);
    const builder = new EntityStoreBuilder();
    const report = emptyReport();
    new Emitter(doc, builder, report, { tick: () => {}, maxEntities: 50_000 }).run(doc.entities);
    expect(report.errors.join(' ')).toMatch(/too many entities.*limit 50,000/);
    expect(builder.count).toBeGreaterThan(50_000);
    expect(builder.count).toBeLessThan(50_000 + 4096 + 1);
  });

  it('does not hang on recursive or very deep block nesting', () => {
    let blocks = block('SELF', line(0, 0, 1, 0) + insert('SELF', 1, 0));
    for (let k = 0; k < 40; k++) blocks += block(`B${k}`, line(0, 0, 1, 0) + insert(`B${k + 1}`, 0, 1));
    blocks += block('B40', line(0, 0, 1, 0));
    const r = parse({
      blocks,
      entities: insert('SELF', 0, 0) + insert('B0', 0, 0) + insert('MISSING', 0, 0),
    });
    const w = r.report.warnings.join('\n');
    expect(w).toMatch(/"SELF" references itself/);
    expect(w).toMatch(/deeper than 32 levels/);
    expect(w).toMatch(/Block "MISSING" is not defined/);
    // SELF: its own line once; B0…B31 each contribute one line (depth 1…32).
    expect(byKind(r, GK.LINE).length).toBe(1 + 32);
    expect(r.report.skipped.INSERT).toBe(3);
  });
});

describe('header, tables and properties', () => {
  const tables =
    pairs(0, 'TABLE', 2, 'LTYPE') +
    pairs(
      0,
      'LTYPE',
      2,
      'DASHED',
      70,
      0,
      3,
      '__ __',
      72,
      65,
      73,
      2,
      40,
      0.75,
      49,
      0.5,
      74,
      0,
      49,
      -0.25,
      74,
      0,
    ) +
    pairs(0, 'ENDTAB') +
    pairs(0, 'TABLE', 2, 'LAYER') +
    pairs(0, 'LAYER', 2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS') +
    pairs(0, 'LAYER', 2, 'Walls', 70, 1, 62, -5, 6, 'DASHED', 370, 50, 290, 0) +
    pairs(0, 'LAYER', 2, 'TC', 70, 0, 62, 3, 420, 0x123456, 6, 'CONTINUOUS') +
    pairs(0, 'ENDTAB');

  it('reads layers (off, frozen, plot, true colour) and linetype patterns', () => {
    const r = parse({
      tables,
      header: pairs(9, '$INSUNITS', 70, 6, 9, '$LTSCALE', 40, 2),
      entities: line(0, 0, 1, 1, pairs(48, 3), 'walls'),
    });
    const s = r.store;
    expect(r.insunits).toBe(6);
    const walls = s.layers.find((l) => l.name === 'Walls')!;
    expect(walls).toEqual({
      name: 'Walls',
      color: 0x0000ff,
      linetype: 'DASHED',
      lineweight: 50,
      off: true,
      frozen: true,
      plot: false,
    });
    expect(s.layers.find((l) => l.name === 'TC')!.color).toBe(0x123456);
    expect(s.linetypes.find((l) => l.name === 'DASHED')!.pattern).toEqual([0.5, -0.25]);
    // Entity on "walls" (case-insensitive) → BYLAYER colour, linetype and lineweight; ltscale = $LTSCALE × 48.
    expect(s.layers[s.layer[0]].name).toBe('Walls');
    expect(s.color[0]).toBe(0x0000ff);
    expect(s.linetypes[s.linetype[0]].name).toBe('DASHED');
    expect(s.lineweight[0]).toBe(50);
    expect(s.ltscale[0]).toBe(6);
  });

  it('marks invisible entities hidden and leaves them out of the extents', () => {
    const r = parse({ entities: line(0, 0, 1, 1) + line(100, 100, 200, 200, pairs(60, 1)) });
    expect(r.store.flags[1] & FLAG.HIDDEN).toBe(FLAG.HIDDEN);
    expect(r.extents).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
  });

  it('keeps plant/UTM coordinates bit-exact', () => {
    const r = parse({
      entities: line('600000.123456789', '2500000.987654321', '612345.6789', '2512345.0001'),
    });
    expect(geomOf(r.store, 0)).toEqual([600000.123456789, 2500000.987654321, 612345.6789, 2512345.0001]);
  });

  it('resolves ACI colours, true colour, BYBLOCK at top level and lineweight codes', () => {
    const r = parse({
      entities:
        line(0, 0, 1, 0, pairs(62, 1)) +
        line(0, 0, 1, 0, pairs(62, 7)) +
        line(0, 0, 1, 0, pairs(62, 250)) +
        line(0, 0, 1, 0, pairs(62, 1, 420, 0xabcdef)) +
        line(0, 0, 1, 0, pairs(62, 0, 370, -2)) +
        line(0, 0, 1, 0, pairs(370, -3)),
    });
    expect(Array.from(r.store.color)).toEqual([0xff0000, 0xffffff, 0x333333, 0xabcdef, 0xffffff, 0xffffff]);
    expect(Array.from(r.store.lineweight)).toEqual([-3, -3, -3, -3, -3, -3]);
  });
});

describe('ACI palette', () => {
  it('has 256 entries with the standard AutoCAD values', () => {
    expect(ACI_RGB.length).toBe(256);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(aciToRgb)).toEqual([
      0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0,
    ]);
    expect(aciToRgb(10)).toBe(0xff0000);
    expect(aciToRgb(11)).toBe(0xff7f7f);
    expect(aciToRgb(30)).toBe(0xff7f00);
    expect(aciToRgb(250)).toBe(0x333333);
    expect(aciToRgb(255)).toBe(0xffffff);
    expect(aciToRgb(-3)).toBe(0x00ff00);
    expect(aciToRgb(256)).toBe(0xffffff);
  });
});

describe('text decoding', () => {
  it('maps code pages to decoder labels', () => {
    expect(codepageToLabel('ANSI_1256')).toBe('windows-1256');
    expect(codepageToLabel('ansi_1252')).toBe('windows-1252');
    expect(codepageToLabel('ANSI_936')).toBe('gbk');
    expect(codepageToLabel('ANSI_932')).toBe('shift_jis');
    expect(codepageToLabel('DOS866')).toBe('ibm866');
    expect(codepageToLabel('nonsense')).toBeNull();
  });

  it('decodes escapes and %% specials', () => {
    expect(decodeText('%%c50 %%d %%p %%%')).toBe('Ø50 ° ± %');
    expect(decodeText('%%uUnder%%u %%176')).toBe('Under °');
    expect(decodeText('\\U+0645\\U+0646')).toBe('من');
    expect(decodeText('\\M+5B0A1')).toBe('啊');
  });

  it('strips MTEXT formatting', () => {
    expect(mtextToPlain('{\\fArial|b1|i0|c0|p34;Title}\\PLine 2')).toBe('Title\nLine 2');
    expect(mtextToPlain('\\H2.5x;\\W0.8;\\Q15;\\T1.1;\\A1;\\C3;\\c255;text')).toBe('text');
    expect(mtextToPlain('\\S1/2; \\S3^4; \\S5#6; \\Sx^;')).toBe('1/2 3/4 5/6 x');
    expect(mtextToPlain('a\\~b \\\\ \\{x\\} \\L\\lu\\O\\o\\K\\k')).toBe('a\u00a0b \\ {x} u');
    expect(mtextToPlain('tab^Inew^Jline ^ caret')).toBe('tab\tnew\nline ^caret');
    expect(mtextToPlain('\\pxqc;Centre %%d')).toBe('Centre °');
  });

  it('decodes $DWGCODEPAGE text (ANSI_1252, ANSI_1251) and UTF-8 for AC1021+', () => {
    const build = (version: string, cp: string, body: number[]) => {
      const head = enc(
        dxfText({
          version,
          header: pairs(9, '$DWGCODEPAGE', 3, cp),
          entities: pairs(0, 'TEXT', 8, '0', 10, 0, 20, 0, 40, 1, 1, '@@'),
        }),
      );
      const at = head.indexOf(64);
      return new Uint8Array([...head.subarray(0, at), ...body, ...head.subarray(at + 2)]);
    };
    const t = (bytes: Uint8Array) => {
      const r = parseDxf(bytes);
      return textOf(r.store, 0);
    };
    expect(t(build('AC1015', 'ANSI_1252', [0xd8, 0x35, 0x30, 0xb0]))).toBe('Ø50°');
    expect(t(build('AC1015', 'ANSI_1251', [0xc4, 0xe0]))).toBe('Да');
    expect(t(build('AC1032', 'ANSI_1252', [...enc('Ø منطقة')]))).toBe('Ø منطقة');
    // Declared ANSI_1252 but actually UTF-8 (exporter bug) → decoded as UTF-8.
    expect(t(build('AC1015', 'ANSI_1252', [...enc('Ø°')]))).toBe('Ø°');
  });

  it('joins MTEXT continuation chunks (code 3 then 1)', () => {
    const r = parse({
      entities: pairs(
        0,
        'MTEXT',
        8,
        '0',
        10,
        1,
        20,
        2,
        40,
        2.5,
        71,
        7,
        3,
        'first \\Pchunk ',
        3,
        'sec',
        1,
        'ond{\\H2;!}',
      ),
    });
    expect(textOf(r.store, 0)).toBe('first \nchunk second!');
    expect(geomOf(r.store, 0).slice(0, 7)).toEqual([1, 2, 2.5, 0, 1, 0, 1]);
  });
});

describe('text placement', () => {
  const text = (extra: string) => pairs(0, 'TEXT', 8, '0', 10, 10, 20, 20, 30, 0, 40, 2, 1, 'Abc') + extra;

  it('uses the second alignment point for justified text', () => {
    const r = parse({
      entities: text(pairs(72, 2, 73, 3, 11, 50, 21, 60)) + text(pairs(72, 4, 11, 30, 21, 40)) + text(''),
    });
    const g = (i: number) => geomOf(r.store, i);
    expect(g(0).slice(0, 2)).toEqual([50, 60]);
    expect([g(0)[5], g(0)[6]]).toEqual([2, 3]);
    expect(g(1).slice(0, 2)).toEqual([30, 40]);
    expect([g(1)[5], g(1)[6]]).toEqual([1, 2]);
    expect(g(2).slice(0, 7)).toEqual([10, 20, 2, 0, 1, 0, 0]);
  });

  it('fit / aligned text spans the baseline between both points', () => {
    const r = parse({ entities: text(pairs(72, 5, 11, 10, 21, 30)) });
    const g = geomOf(r.store, 0);
    expect(g[0]).toBe(10);
    expect(g[1]).toBe(20);
    expect(g[3]).toBeCloseTo(Math.PI / 2, 12);
    expect(g[8]).toBeCloseTo(10, 12);
  });

  it('expresses backward / upside-down / mirrored text with a negative width factor', () => {
    const r = parse({
      entities: text(pairs(71, 2, 51, 15)) + text(pairs(71, 4)) + text(pairs(210, 0, 220, 0, 230, -1)),
    });
    const g = (i: number) => geomOf(r.store, i);
    expect(g(0)[4]).toBe(-1);
    expect(g(0)[3]).toBeCloseTo(0, 12);
    expect(g(0)[7]).toBeCloseTo((-15 * Math.PI) / 180, 12);
    expect(g(1)[4]).toBe(-1);
    expect(g(1)[3]).toBeCloseTo(Math.PI, 12);
    expect(g(2).slice(0, 2)).toEqual([-10, 20]);
    expect(g(2)[4]).toBe(-1);
  });
});

describe('geometry and transforms', () => {
  it('implements the arbitrary axis algorithm', () => {
    expect(ocsXform(0, 0, 1)).toBeNull();
    const m = ocsXform(0, 0, -1)!;
    expect([m.x(3, 4, 0), m.y(3, 4, 0)]).toEqual([-3, 4]);
    const t = ocsXform(0.3, 0.4, 0.866)!;
    const l = Math.hypot(0.3, 0.4, 0.866);
    // |Nx|, |Ny| ≥ 1/64 → Ax = Wz × N, normalised = (-0.8, 0.6, 0)
    expect(t.vx(1, 0, 0)).toBeCloseTo(-0.8, 12);
    expect(t.vy(1, 0, 0)).toBeCloseTo(0.6, 12);
    expect(t.vx(0, 0, 1)).toBeCloseTo(0.3 / l, 12);
  });

  it('mirrors OCS (0,0,-1) circles, arcs and polylines in X', () => {
    const ext = pairs(210, 0, 220, 0, 230, -1);
    const r = parse({
      entities:
        pairs(0, 'CIRCLE', 8, '0', 10, 5, 20, 6, 40, 2) +
        ext +
        pairs(0, 'ARC', 8, '0', 10, 5, 20, 6, 40, 2, 50, 0, 51, 90) +
        ext +
        pairs(0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 0, 20, 0, 42, 0.5, 10, 4, 20, 0) +
        ext,
    });
    const s = r.store;
    expect(geomOf(s, 0)).toEqual([-5, 6, 2]);
    const [cx, cy, rad, a0, a1] = geomOf(s, 1);
    expect([cx, cy, rad]).toEqual([-5, 6, 2]);
    expect(a0).toBeCloseTo(Math.PI / 2, 12);
    expect(a1).toBeCloseTo(Math.PI, 12);
    expect(geomOf(s, 2)).toEqual([2, 0, 0, -0.5, -4, 0, 0]);
  });

  it('flattens INSERT arrays with rotation, scale and base point', () => {
    const r = parse({
      blocks: block('B', line(1, 1, 2, 1), [1, 1]),
      entities: insert('B', 100, 200, pairs(41, 2, 42, 2, 50, 90, 70, 2, 71, 2, 44, 10, 45, 20)),
    });
    const lines = byKind(r, GK.LINE).map((i) => geomOf(r.store, i));
    // Rotation 90°: block +X → world +Y; columns along +Y, rows along -X.
    expect(lines).toEqual([
      [100, 200, 100, 202],
      [100, 210, 100, 212],
      [80, 200, 80, 202],
      [80, 210, 80, 212],
    ]);
    expect(r.store.inserts).toEqual([{ name: 'B', handle: '', type: 'INSERT' }]);
    expect(Array.from(r.store.insertIndex)).toEqual([0, 0, 0, 0]);
    expect(Array.from(r.store.flags).every((f) => f & FLAG.IN_BLOCK)).toBe(true);
  });

  it('turns circles into ellipses under non-uniform scale and keeps bulges under mirroring', () => {
    const r = parse({
      blocks: block(
        'C',
        pairs(0, 'CIRCLE', 8, '0', 10, 0, 20, 0, 40, 1) +
          pairs(0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 0, 20, 0, 42, 1, 10, 2, 20, 0),
      ),
      entities: insert('C', 0, 0, pairs(41, 3, 42, 1)) + insert('C', 10, 0, pairs(41, -1)),
    });
    const s = r.store;
    const [e0, p0, c1, p1] = [0, 1, 2, 3];
    expect(s.geomKind[e0]).toBe(GK.ELLIPSE);
    expect(geomOf(s, e0).slice(0, 5)).toEqual([0, 0, 3, 0, 1 / 3]);
    expect(s.geomKind[p0]).toBe(GK.POLY);
    expect(geomOf(s, p0)[0]).toBeGreaterThan(8); // arc tessellated under non-uniform scale
    expect(geomOf(s, c1)).toEqual([10, 0, 1]);
    expect(geomOf(s, p1)).toEqual([2, 10, 0, -1, 8, 0, 0]);
  });

  it('evaluates rational NURBS exactly and interpolates fit points', () => {
    const w = Math.SQRT1_2;
    const pts = tessellateNurbs(2, [0, 0, 0, 1, 1, 1], [1, 0, 0, 1, 1, 0, 0, 1, 0], [1, w, 1]);
    for (let i = 0; i < pts.length; i += 3) expect(Math.hypot(pts[i], pts[i + 1])).toBeCloseTo(1, 12);
    expect(pts.length / 3).toBeGreaterThan(10);
    const warnings: string[] = [];
    const bad = tessellateNurbs(3, [0, 1], [0, 0, 0, 1, 1, 0, 2, 0, 0, 3, 1, 0], null, (m) =>
      warnings.push(m),
    );
    expect(bad.slice(0, 3)).toEqual([0, 0, 0]);
    expect(warnings[0]).toMatch(/knot/);
    const fit = [0, 0, 0, 1, 2, 0, 3, -1, 0, 4, 0, 0];
    const out = interpolateFitPoints(fit, null, null, false);
    for (let k = 0; k < 4; k++) {
      const found = Array.from({ length: out.length / 3 }, (_, i) =>
        Math.hypot(out[i * 3] - fit[k * 3], out[i * 3 + 1] - fit[k * 3 + 1]),
      ).some((d) => d < 1e-12);
      expect(found).toBe(true);
    }
  });

  it('clips hatch pattern lines to the boundary with the even-odd rule', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    const hole = [3, 3, 7, 3, 7, 7, 3, 7];
    const horiz = [{ angle: 0, bx: 0, by: 0.5, ox: 0, oy: 1, dashes: [] }];
    const a = generatePattern([square], horiz);
    expect(a.segs.length / 4).toBe(10);
    const b = generatePattern([square, hole], horiz);
    // y = 3.5 … 6.5 cross the hole: 4 lines split in two.
    expect(b.segs.length / 4).toBe(14);
    let len = 0;
    for (let i = 0; i < b.segs.length; i += 4) len += Math.abs(b.segs[i + 2] - b.segs[i]);
    expect(len).toBeCloseTo(100 - 16, 9);
    const dashed = generatePattern([square], [{ angle: 0, bx: 0, by: 0.5, ox: 0, oy: 1, dashes: [1, -1] }]);
    expect(dashed.segs.length / 4).toBe(50);
    const capped = generatePattern([square], [{ angle: 0, bx: 0, by: 0, ox: 0, oy: 0.001, dashes: [] }], 500);
    expect(capped.capped).toBe(true);
    expect(capped.segs.length / 4).toBe(500);
  });

  it('caps pattern lines of a dense hatch at 20 000 segments with a warning', () => {
    const r = parse({
      entities: pairs(
        0,
        'HATCH',
        8,
        '0',
        10,
        0,
        20,
        0,
        30,
        0,
        210,
        0,
        220,
        0,
        230,
        1,
        2,
        'USER',
        70,
        0,
        71,
        0,
        91,
        1,
        92,
        3,
        72,
        0,
        73,
        1,
        93,
        4,
        10,
        0,
        20,
        0,
        10,
        1000,
        20,
        0,
        10,
        1000,
        20,
        1000,
        10,
        0,
        20,
        1000,
        97,
        0,
        75,
        0,
        76,
        0,
        52,
        0,
        41,
        1,
        77,
        0,
        78,
        1,
        53,
        45,
        43,
        0,
        44,
        0,
        45,
        -0.02,
        46,
        0.02,
        79,
        0,
        98,
        0,
      ),
    });
    expect(r.report.counts).toEqual({ HATCH: 1 });
    const derived = Array.from(r.store.flags).filter((f) => f & FLAG.DERIVED).length;
    expect(derived).toBe(20000);
    expect(r.report.warnings.join('\n')).toMatch(/more than 20 000 pattern line segments/);
    expect(r.store.flags[0] & FLAG.PATTERN).toBe(FLAG.PATTERN);
    expect(r.store.type[1]).toBe(ET.HATCH);
  });

  it('skips spline-frame vertices of spline-fit POLYLINEs and draws SOLIDs in 1-2-4-3 order', () => {
    const v = (x: number, y: number, f: number) => pairs(0, 'VERTEX', 8, '0', 10, x, 20, y, 70, f);
    const r = parse({
      entities:
        pairs(0, 'POLYLINE', 8, '0', 66, 1, 70, 4) +
        v(0, 0, 16) +
        v(5, 5, 16) +
        v(0, 0, 8) +
        v(1, 1, 8) +
        v(2, 0, 8) +
        pairs(0, 'SEQEND', 8, '0') +
        pairs(0, 'SOLID', 8, '0', 10, 0, 20, 0, 11, 1, 21, 0, 12, 0, 22, 1, 13, 1, 23, 1),
    });
    expect(geomOf(r.store, 0)).toEqual([3, 0, 0, 0, 1, 1, 0, 2, 0, 0]);
    expect(geomOf(r.store, 1)).toEqual([1, 4, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  });
});

describe('layouts', () => {
  it('lists *Paper_SpaceN blocks as layouts when there are no LAYOUT objects', () => {
    const blocks =
      block('*Paper_Space', '') + block('*Paper_Space0', line(1, 2, 3, 4)) + block('*Model_Space', '');
    const r = parse({ blocks, entities: line(0, 0, 1, 1) + line(5, 5, 6, 6, pairs(67, 1)) });
    expect(r.layouts).toEqual(['Model', 'Layout1', 'Layout2']);
    expect(geomOf(parse({ blocks, entities: line(0, 0, 1, 1) }, { layout: 'Layout2' }).store, 0)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('lists Model plus paper layouts and parses the requested one', () => {
    const r = parse({
      version: 'AC1009',
      entities: line(0, 0, 1, 1) + line(5, 5, 6, 6, pairs(67, 1)),
    });
    expect(r.layouts).toEqual(['Model', 'Layout1']);
    expect(r.store.count).toBe(1);
    const p = parse(
      { version: 'AC1009', entities: line(0, 0, 1, 1) + line(5, 5, 6, 6, pairs(67, 1)) },
      { layout: 'layout1' },
    );
    expect(p.layout).toBe('Layout1');
    expect(geomOf(p.store, 0)).toEqual([5, 5, 6, 6]);
  });
});

// ---------------------------------------------------------------------------------------------
// Performance (NFR-2): 20 MB ASCII DXF with ~200 000 LINE / LWPOLYLINE / TEXT entities.

function makeLargeDxf(targetBytes: number): { bytes: Uint8Array; entities: number } {
  const parts: string[] = [];
  let size = 0;
  const p = (c: string, v: string) => {
    parts.push(c, '\n', v, '\n');
    size += c.length + v.length + 2;
  };
  p('  0', 'SECTION');
  p('  2', 'HEADER');
  p('  9', '$ACADVER');
  p('  1', 'AC1015');
  p('  9', '$INSUNITS');
  p(' 70', '6');
  p('  0', 'ENDSEC');
  p('  0', 'SECTION');
  p('  2', 'TABLES');
  p('  0', 'TABLE');
  p('  2', 'LAYER');
  for (let l = 0; l < 20; l++) {
    p('  0', 'LAYER');
    p('  2', `L${l}`);
    p(' 70', '0');
    p(' 62', String(1 + l));
    p('  6', 'CONTINUOUS');
  }
  p('  0', 'ENDTAB');
  p('  0', 'ENDSEC');
  p('  0', 'SECTION');
  p('  2', 'ENTITIES');
  let n = 0;
  while (size < targetBytes) {
    const x = 600000 + (n % 1000) * 0.731;
    const y = 2500000 + Math.floor(n / 1000) * 0.917;
    const xs = x.toFixed(3);
    const ys = y.toFixed(3);
    const layer = `L${n % 20}`;
    const k = n % 20;
    if (k < 12) {
      p('  0', 'LINE');
      p('  8', layer);
      p(' 10', xs);
      p(' 20', ys);
      p(' 11', (x + 1.5).toFixed(3));
      p(' 21', (y + 0.5).toFixed(3));
    } else if (k < 17) {
      p('  0', 'LWPOLYLINE');
      p('  8', layer);
      p(' 90', '4');
      p(' 70', '1');
      p(' 10', xs);
      p(' 20', ys);
      p(' 10', (x + 2).toFixed(3));
      p(' 20', ys);
      p(' 42', '0.5');
      p(' 10', (x + 2).toFixed(3));
      p(' 20', (y + 1).toFixed(3));
      p(' 10', xs);
      p(' 20', (y + 1).toFixed(3));
    } else {
      p('  0', 'TEXT');
      p('  8', layer);
      p(' 10', xs);
      p(' 20', ys);
      p(' 40', '0.25');
      p('  1', `TAG-${n}`);
    }
    n++;
  }
  p('  0', 'ENDSEC');
  p('  0', 'EOF');
  return { bytes: enc(parts.join('')), entities: n };
}

describe('performance', () => {
  it('parses a generated 20 MB ASCII DXF (~200 000 entities) in under 5 s', { timeout: 60000 }, () => {
    const { bytes, entities } = makeLargeDxf(20 * 1024 * 1024);
    expect(bytes.length).toBeGreaterThanOrEqual(20 * 1024 * 1024);
    expect(entities).toBeGreaterThan(190000);
    let calls = 0;
    const t0 = performance.now();
    const r = parseDxf(bytes, { onProgress: () => calls++ });
    const ms = performance.now() - t0;
    console.log(
      `[dxf perf] ${(bytes.length / 1048576).toFixed(1)} MB, ${entities} entities parsed in ${ms.toFixed(0)} ms (${calls} progress callbacks)`,
    );
    expect(r.store.count).toBe(entities);
    expect(r.report.counts.LINE + r.report.counts.LWPOLYLINE + r.report.counts.TEXT).toBe(entities);
    expect(r.extents.minX).toBe(600000);
    expect(ms).toBeLessThan(5000);
  });
});
