import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACI_RGB,
  DASH_TO_LINETYPE,
  DxfWriter,
  dxfFloat,
  escapeMText,
  nearestAci,
  sanitizeName,
  splitChunks,
  textToOutlines,
} from './dxf-writer';
import { testFontSet } from './test-fonts';

type Pair = [number, string];

/** Splits DXF text into (group code, value) pairs, checking the basic line structure. */
function pairs(dxf: string): Pair[] {
  const lines = dxf.split(/\r\n|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  expect(lines.length % 2).toBe(0);
  const out: Pair[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    expect(Number.isInteger(code)).toBe(true);
    out.push([code, lines[i + 1]]);
  }
  return out;
}

interface Obj {
  type: string;
  section: string;
  tags: Pair[];
}

/** Groups pairs into sections and objects (each starting with group 0). */
function structure(dxf: string) {
  const ps = pairs(dxf);
  const sections: string[] = [];
  const objects: Obj[] = [];
  let section = '';
  let cur: Obj | null = null;
  for (let i = 0; i < ps.length; i++) {
    const [code, value] = ps[i];
    if (code === 0 && value === 'SECTION') {
      section = ps[i + 1][1];
      sections.push(section);
      i++;
      cur = null;
      continue;
    }
    if (code === 0) {
      cur = { type: value, section, tags: [] };
      objects.push(cur);
      continue;
    }
    cur?.tags.push([code, value]);
  }
  return { ps, sections, objects };
}

const get = (o: Obj, code: number) => o.tags.find(([c]) => c === code)?.[1];
const getAll = (o: Obj, code: number) => o.tags.filter(([c]) => c === code).map(([, v]) => v);

function sampleWriter() {
  const w = new DxfWriter({ units: 'm', ltscale: 500 });
  w.addLayer({ name: 'Zones: A/B', color: '#ff8800', linetype: 'DASHED', lineweight: 0.33 });
  w.addLayer({ name: 'Labels', color: 3 });
  w.addLayer({ name: 'Hidden', color: '#0000ff', off: true, frozen: true, locked: true, plot: false });
  w.addLinetype('FENCE', [2, -1, 0, -1], 'Fence --x--');
  const X = 512345.678901234;
  const Y = 2765432.109876543;
  w.line('Zones_ A_B', { x: X, y: Y }, { x: X + 100, y: Y + 50 }, { linetype: 'FENCE', ltscale: 2 });
  w.polyline(
    'Zones_ A_B',
    [
      { x: X, y: Y, bulge: 0.5 },
      { x: X + 10, y: Y },
      { x: X + 10, y: Y + 10, bulge: -1 },
      { x: X, y: Y + 10 },
    ],
    true,
    { width: 0.25, color: '#123456' },
  );
  w.circle('Zones_ A_B', { x: X, y: Y }, 15, { transparency: 0.5 });
  w.arc('Zones_ A_B', { x: X, y: Y }, 20, -Math.PI / 2, Math.PI / 2, { color: 1, lineweight: 0.5 });
  w.ellipse('Zones_ A_B', { x: X, y: Y }, { x: 10, y: 0 }, 0.5);
  w.point('Auto layer', { x: X, y: Y });
  w.hatch(
    'Zones_ A_B',
    [
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 30 },
        { x: 0, y: 30 },
        { x: 0, y: 0 },
      ],
      [
        { x: 10, y: 15, bulge: 1 },
        { x: 20, y: 15, bulge: 1 },
      ],
    ],
    { color: '#00ff00', transparency: 0.6, style: 'odd' },
  );
  w.text('Labels', { x: X, y: Y }, 'Tank 50%% ^x', {
    height: 2.5,
    rotation: Math.PI / 2,
    hAlign: 'center',
    vAlign: 'middle',
  });
  w.text('Labels', { x: X, y: Y }, 'منطقة الخطر 15 م', { height: 2.5 });
  w.mtext('Labels', { x: X, y: Y }, 'A {b} c\\d\nمنطقة\n' + 'word '.repeat(80), {
    height: 2,
    attachment: 'bottom-right',
    rotation: Math.PI / 4,
    width: 30,
    lineSpacing: 1.5,
  });
  return w;
}

describe('DxfWriter structure', () => {
  const dxf = sampleWriter().toString();
  const { ps, sections, objects } = structure(dxf);

  it('has every section in order and ends with EOF', () => {
    expect(sections).toEqual(['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']);
    expect(ps[ps.length - 1]).toEqual([0, 'EOF']);
    expect(dxf.endsWith('EOF\r\n')).toBe(true);
    expect(dxf.split('\r\n')[0]).toBe('  0');
    expect(objects.filter((o) => o.type === 'ENDSEC')).toHaveLength(6);
  });

  it('writes the R2010 header', () => {
    const header = ps.slice(
      0,
      ps.findIndex(([c, v]) => c === 0 && v === 'ENDSEC'),
    );
    const hv = (name: string) => header[header.findIndex(([c, v]) => c === 9 && v === name) + 1];
    expect(hv('$ACADVER')).toEqual([1, 'AC1024']);
    expect(hv('$DWGCODEPAGE')).toEqual([3, 'ANSI_1252']);
    expect(hv('$INSUNITS')).toEqual([70, '6']);
    expect(hv('$MEASUREMENT')).toEqual([70, '1']);
    expect(hv('$LTSCALE')).toEqual([40, '500.0']);
    const extMin = header.findIndex(([c, v]) => c === 9 && v === '$EXTMIN');
    expect(Number(header[extMin + 1][1])).toBeLessThan(512345.678901234);
    expect(Number(header[header.findIndex(([c, v]) => c === 9 && v === '$EXTMAX') + 1][1])).toBeGreaterThan(
      512445,
    );
  });

  it('assigns unique handles below $HANDSEED and valid owners/pointers', () => {
    const handles = new Map<string, Obj>();
    for (const o of objects) {
      const h = o.type === 'DIMSTYLE' ? get(o, 105) : get(o, 5);
      if (['ENDSEC', 'EOF', 'CLASS', 'ENDTAB'].includes(o.type)) continue;
      expect(h, `${o.type} has a handle`).toMatch(/^[0-9A-F]+$/);
      expect(handles.has(h!), `duplicate handle ${h}`).toBe(false);
      handles.set(h!, o);
    }
    const seed = parseInt(ps[ps.findIndex(([c, v]) => c === 9 && v === '$HANDSEED') + 1][1], 16);
    for (const h of handles.keys()) expect(parseInt(h, 16)).toBeLessThan(seed);
    for (const o of objects) {
      for (const [code, v] of o.tags) {
        if (code === 330 || code === 340 || code === 350 || code === 390) {
          expect(v === '0' || handles.has(v), `${o.type} ${code} → ${v}`).toBe(true);
        }
      }
    }
    const ms = objects.find((o) => o.type === 'BLOCK_RECORD' && get(o, 2) === '*Model_Space')!;
    const entities = objects.filter((o) => o.section === 'ENTITIES' && o.type !== 'ENDSEC');
    expect(entities).toHaveLength(10);
    for (const e of entities) {
      expect(get(e, 330)).toBe(get(ms, 5));
      expect(getAll(e, 100)[0]).toBe('AcDbEntity');
      expect(getAll(e, 100).length).toBeGreaterThanOrEqual(2);
      expect(get(e, 8)).toBeTruthy();
    }
    // BLOCK_RECORD ↔ LAYOUT links
    const layout = handles.get(get(ms, 340)!)!;
    expect(layout.type).toBe('LAYOUT');
    expect(getAll(layout, 330).at(-1)).toBe(get(ms, 5));
  });

  it('writes all nine tables with matching record counts', () => {
    const tables = objects.filter((o) => o.type === 'TABLE');
    expect(tables.map((t) => get(t, 2))).toEqual([
      'VPORT',
      'LTYPE',
      'LAYER',
      'STYLE',
      'VIEW',
      'UCS',
      'APPID',
      'DIMSTYLE',
      'BLOCK_RECORD',
    ]);
    for (const t of tables) {
      const name = get(t, 2)!;
      const records = objects.filter((o) => o.section === 'TABLES' && o.type === name);
      expect(Number(get(t, 70)), name).toBe(records.length);
      for (const r of records) expect(getAll(r, 100)[0]).toBe('AcDbSymbolTableRecord');
    }
    const ltypes = objects.filter((o) => o.type === 'LTYPE').map((o) => get(o, 2));
    expect(ltypes).toEqual([
      'ByBlock',
      'ByLayer',
      'Continuous',
      'DASHED',
      'DASHEDX2',
      'DOT',
      'DASHDOT',
      'FENCE',
    ]);
    const dashed = objects.find((o) => o.type === 'LTYPE' && get(o, 2) === 'DASHED')!;
    expect(getAll(dashed, 49)).toEqual(['0.5', '-0.25']);
    expect(get(dashed, 40)).toBe('0.75');
    const styles = objects.filter((o) => o.type === 'STYLE');
    expect(styles.map((s) => [get(s, 2), get(s, 3)])).toEqual([
      ['Standard', 'txt'],
      ['Unicode', 'arial.ttf'],
    ]);
    expect(objects.find((o) => o.type === 'VPORT' && get(o, 2) === '*Active')).toBeDefined();
    expect(objects.find((o) => o.type === 'APPID' && get(o, 2) === 'ACAD')).toBeDefined();
  });

  it('writes layers with ACI, true colour, linetype, lineweight and state flags', () => {
    const layers = objects.filter((o) => o.type === 'LAYER');
    expect(layers.map((l) => get(l, 2))).toEqual(['0', 'Zones_ A_B', 'Labels', 'Hidden', 'Auto layer']);
    const zones = layers[1];
    expect(get(zones, 62)).toBe(String(nearestAci(255, 136, 0)));
    expect(get(zones, 420)).toBe(String(0xff8800));
    expect(get(zones, 6)).toBe('DASHED');
    expect(get(zones, 370)).toBe('35'); // 0.33 mm snapped
    const hidden = layers[3];
    expect(Number(get(hidden, 62))).toBeLessThan(0);
    expect(get(hidden, 70)).toBe('5'); // frozen + locked
    expect(get(hidden, 290)).toBe('0');
    expect(get(layers[4], 62)).toBe('7');
  });

  it('writes entities with exact float64 coordinates and correct group codes', () => {
    const ent = (t: string) => objects.filter((o) => o.section === 'ENTITIES' && o.type === t);
    const line = ent('LINE')[0];
    expect(get(line, 10)).toBe('512345.678901234');
    expect(get(line, 20)).toBe('2765432.109876543');
    expect(Number(get(line, 11))).toBe(512345.678901234 + 100);
    expect(get(line, 6)).toBe('FENCE');
    expect(get(line, 48)).toBe('2.0');
    const pl = ent('LWPOLYLINE')[0];
    expect(get(pl, 90)).toBe('4');
    expect(get(pl, 70)).toBe('1');
    expect(get(pl, 43)).toBe('0.25');
    expect(getAll(pl, 42)).toEqual(['0.5', '-1.0']);
    expect(get(pl, 420)).toBe(String(0x123456));
    const circle = ent('CIRCLE')[0];
    expect(get(circle, 440)).toBe(String(0x02000000 | 128));
    const arc = ent('ARC')[0];
    expect([get(arc, 50), get(arc, 51)]).toEqual(['270.0', '90.0']);
    expect(get(arc, 62)).toBe('1');
    expect(get(arc, 370)).toBe('50');
    const el = ent('ELLIPSE')[0];
    expect([get(el, 11), get(el, 40), get(el, 41), get(el, 42)]).toEqual([
      '10.0',
      '0.5',
      '0.0',
      String(Math.PI * 2),
    ]);
    const pt = ent('POINT')[0];
    expect(get(pt, 8)).toBe('Auto layer');
  });

  it('writes solid HATCH loops with bulges, island flags and transparency', () => {
    const h = objects.find((o) => o.type === 'HATCH')!;
    expect(getAll(h, 100)).toEqual(['AcDbEntity', 'AcDbHatch']);
    expect(get(h, 2)).toBe('SOLID');
    expect(get(h, 70)).toBe('1');
    expect(get(h, 91)).toBe('2');
    expect(getAll(h, 92)).toEqual(['3', '2']); // outer external, inner island
    expect(getAll(h, 72)).toEqual(['0', '1']);
    expect(getAll(h, 93)).toEqual(['4', '2']); // closing duplicate vertex removed
    expect(getAll(h, 42)).toEqual(['1.0', '1.0']);
    expect(get(h, 75)).toBe('0');
    expect(get(h, 98)).toBe('0');
    expect(get(h, 440)).toBe(String(0x02000000 | 102));
  });

  it('writes TEXT with alignment, rotation, style selection and escapes', () => {
    const [latin, arabic] = objects.filter((o) => o.type === 'TEXT');
    expect(getAll(latin, 100)).toEqual(['AcDbEntity', 'AcDbText', 'AcDbText']);
    expect(get(latin, 1)).toBe('Tank 50%%%%%% ^ x');
    expect(get(latin, 50)).toBe('90.0');
    expect([get(latin, 72), get(latin, 73)]).toEqual(['1', '2']);
    expect(get(latin, 11)).toBe(get(latin, 10));
    expect(get(latin, 7)).toBe('Standard');
    expect(get(arabic, 1)).toBe('منطقة الخطر 15 م');
    expect(get(arabic, 7)).toBe('Unicode');
    expect(get(arabic, 72)).toBeUndefined();
  });

  it('writes MTEXT with \\P paragraphs, escaped braces, chunking and direction vector', () => {
    const m = objects.find((o) => o.type === 'MTEXT')!;
    const chunks3 = getAll(m, 3);
    const last = get(m, 1)!;
    expect(chunks3.length).toBeGreaterThanOrEqual(1);
    for (const c of [...chunks3, last]) expect([...c].length).toBeLessThanOrEqual(250);
    const content = chunks3.join('') + last;
    expect(content.startsWith('A \\{b\\} c\\\\d\\Pمنطقة\\Pword word')).toBe(true);
    expect(get(m, 71)).toBe('9');
    expect(get(m, 41)).toBe('30.0');
    expect(Number(get(m, 11))).toBeCloseTo(Math.SQRT1_2, 15);
    expect(Number(get(m, 21))).toBeCloseTo(Math.SQRT1_2, 15);
    expect(get(m, 44)).toBe('1.5');
    expect(get(m, 7)).toBe('Unicode');
  });

  it('writes the OBJECTS dictionaries and layouts AutoCAD needs', () => {
    const dicts = objects.filter((o) => o.section === 'OBJECTS');
    const root = dicts[0];
    expect(root.type).toBe('DICTIONARY');
    expect(get(root, 330)).toBe('0');
    expect(getAll(root, 3)).toEqual([
      'ACAD_COLOR',
      'ACAD_GROUP',
      'ACAD_LAYOUT',
      'ACAD_MLINESTYLE',
      'ACAD_PLOTSETTINGS',
      'ACAD_PLOTSTYLENAME',
    ]);
    const layouts = dicts.filter((o) => o.type === 'LAYOUT');
    expect(layouts.map((l) => getAll(l, 1).at(-1))).toEqual(['Model', 'Layout1']);
    expect(dicts.find((o) => o.type === 'ACDBDICTIONARYWDFLT')).toBeDefined();
    expect(dicts.find((o) => o.type === 'ACDBPLACEHOLDER')).toBeDefined();
    expect(dicts.find((o) => o.type === 'MLINESTYLE')).toBeDefined();
    const classes = objects.filter((o) => o.type === 'CLASS').map((c) => get(c, 1));
    expect(classes).toEqual(['ACDBDICTIONARYWDFLT', 'ACDBPLACEHOLDER', 'LAYOUT']);
  });

  it(
    'validates with ezdxf when EZDXF_PYTHON points to a Python with ezdxf',
    { skip: !process.env.EZDXF_PYTHON },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'dxf-'));
      try {
        const file = join(dir, 'sample.dxf');
        const w = sampleWriter();
        w.textOutlines('Outlines', testFontSet(), { x: 0, y: 0 }, 'منطقة الخطر 15 م', {
          height: 3,
          anchor: 'middle',
        });
        writeFileSync(file, w.toBytes());
        const out = execFileSync(process.env.EZDXF_PYTHON!, ['scripts/validate-dxf.py', file], {
          encoding: 'utf8',
        });
        const result = JSON.parse(out);
        expect(result.load_errors).toEqual([]);
        expect(result.audit_errors).toEqual([]);
        expect(result.audit_fixes).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('DXF helpers', () => {
  it('dxfFloat round-trips float64 without exponents', () => {
    expect(dxfFloat(0)).toBe('0.0');
    expect(dxfFloat(-0)).toBe('0.0');
    expect(dxfFloat(1)).toBe('1.0');
    expect(dxfFloat(-12)).toBe('-12.0');
    expect(dxfFloat(0.1)).toBe('0.1');
    expect(dxfFloat(1e-7)).toBe('0.0000001');
    expect(dxfFloat(-3.5e-9)).toBe('-0.0000000035');
    expect(dxfFloat(1e-25)).toBe('0.0');
    expect(dxfFloat(1e25)).toBe('1e+25');
    expect(dxfFloat(NaN)).toBe('0.0');
    for (const v of [512345.678901234, 2765432.109876543, 0.1 + 0.2, 123456789.98765433, Math.PI * 1e6]) {
      const s = dxfFloat(v);
      expect(s).not.toMatch(/e/i);
      expect(Number(s)).toBe(v);
    }
  });

  it('ACI palette and nearest colour', () => {
    expect(ACI_RGB[1]).toBe(0xff0000);
    expect(ACI_RGB[11]).toBe(0xff7f7f);
    expect(ACI_RGB[12]).toBe(0xa50000);
    expect(ACI_RGB[21]).toBe(0xff9f7f);
    expect(ACI_RGB[22]).toBe(0xa52900);
    expect(ACI_RGB[250]).toBe(0x333333);
    expect(nearestAci(255, 0, 0)).toBe(1);
    expect(nearestAci(0, 0, 0)).toBe(7);
    expect(nearestAci(255, 255, 255)).toBe(7);
    expect(nearestAci(250, 120, 120)).toBe(11);
  });

  it('sanitises names and escapes MTEXT', () => {
    expect(sanitizeName('a<b>c/d\\e"f:g;h?i*j|k=l`m')).toBe('a_b_c_d_e_f_g_h_i_j_k_l_m');
    expect(sanitizeName('  ')).toBe('_');
    expect(sanitizeName('منطقة')).toBe('منطقة');
    expect(escapeMText('a\\b{c}\r\nd')).toBe('a\\\\b\\{c\\}\\Pd');
    expect(DASH_TO_LINETYPE['dash-dot']).toBe('DASHDOT');
  });

  it('splitChunks never breaks escapes, carets or surrogate pairs', () => {
    const s = 'ab\\Pc^ d\\U+0645😀'.repeat(40);
    for (const max of [3, 7, 10, 250]) {
      const chunks = splitChunks(s, max);
      expect(chunks.join('')).toBe(s);
      for (const c of chunks) {
        expect([...c].length).toBeLessThanOrEqual(Math.max(max, 7));
        expect(c.endsWith('\\')).toBe(false);
        expect(c.endsWith('^')).toBe(false);
        expect(/[\ud800-\udbff]$/.test(c)).toBe(false);
      }
    }
  });

  it('escapeUnicode writes \\U+XXXX sequences and LF line endings', () => {
    const dxf = new DxfWriter({ escapeUnicode: true, lineEnding: '\n' })
      .text('L', { x: 0, y: 0 }, 'مـ😀', { height: 1 })
      .toString();
    expect(dxf).toContain('\\U+0645\\U+0640\\U+D83D\\U+DE00');
    expect(dxf).not.toContain('\r');
    expect([...dxf].every((c) => c.charCodeAt(0) < 0x80)).toBe(true);
  });

  it('validates inputs', () => {
    const w = new DxfWriter();
    expect(() => w.line('a', { x: NaN, y: 0 }, { x: 1, y: 1 })).toThrow(/non-finite/);
    expect(() => w.circle('a', { x: 0, y: 0 }, 0)).toThrow();
    expect(() => w.polyline('a', [{ x: 0, y: 0 }], false)).toThrow();
    expect(() => w.line('a', { x: 0, y: 0 }, { x: 1, y: 1 }, { linetype: 'NOPE' })).toThrow(/linetype/);
    expect(() => w.text('a', { x: 0, y: 0 }, 'x', { height: 1, style: 'Missing' })).toThrow(/style/);
    expect(
      w.hatch('a', [
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      ]).entityCount,
    ).toBe(0); // degenerate ring skipped
    expect(
      new TextDecoder().decode(new DxfWriter().text('a', { x: 0, y: 0 }, 'م', { height: 1 }).toBytes()),
    ).toContain('م');
  });
});

describe('textToOutlines', () => {
  const fonts = testFontSet();

  it('returns per-glyph rings in drawing coordinates (y-up)', () => {
    const glyphs = textToOutlines(fonts, 'H', { x: 1000, y: 2000 }, { height: 10 });
    expect(glyphs).toHaveLength(1);
    const pts = glyphs[0].flat();
    const ys = pts.map((p) => p.y);
    const xs = pts.map((p) => p.x);
    expect(Math.min(...ys)).toBeCloseTo(2000, 6);
    expect(Math.max(...ys)).toBeCloseTo(2000 + 7.14, 1); // cap height above the baseline
    expect(Math.min(...xs)).toBeGreaterThan(1000);
  });

  it('shapes Arabic, honours anchor/rotation and keeps counters as separate rings', () => {
    const glyphs = textToOutlines(
      fonts,
      'منطقة الخطر 15 م',
      { x: 0, y: 0 },
      { height: 5, anchor: 'middle', baseline: 'middle' },
    );
    expect(glyphs.length).toBeGreaterThanOrEqual(12);
    const xs = glyphs.flat(2).map((p) => p.x);
    expect(Math.abs(Math.min(...xs) + Math.max(...xs))).toBeLessThan(1); // centred
    const zero = textToOutlines(fonts, 'O', { x: 0, y: 0 }, { height: 10 });
    expect(zero[0]).toHaveLength(2); // outer contour + counter
    const rot = textToOutlines(fonts, 'I', { x: 0, y: 0 }, { height: 10, rotation: Math.PI / 2 });
    const rxs = rot.flat(2).map((p) => p.x);
    expect(Math.min(...rxs)).toBeLessThan(-6); // the stem now points to −x
    const w = new DxfWriter().textOutlines('Out', fonts, { x: 0, y: 0 }, 'AB', {
      height: 2,
      color: '#ff0000',
    });
    expect(w.entityCount).toBe(2);
    expect(textToOutlines(fonts, 'x', { x: 0, y: 0 }, { height: 0 })).toEqual([]);
  });
});
