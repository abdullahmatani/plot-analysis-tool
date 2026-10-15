import type { DwgDatabase, DwgEntity } from '@mlightcad/libredwg-web';
import { describe, expect, it } from 'vitest';

import { ET, FLAG, GK, readPoly, readRings, type DrawingParseResult } from '@/underlay/entity-store';

import { dwgDatabaseToStore, dwgLineweight, listDwgLayouts, MAX_BLOCK_DEPTH } from './convert';
import { DwgReadError } from './errors';

// ------------------------------------------------------------------------------------------------
// Builders for hand-made LibreDWG databases.

type P = { x: number; y: number; z?: number };
type Props = Record<string, unknown>;

let handleSeq = 0x100;
const nextHandle = () => (handleSeq++).toString(16).toUpperCase();

function ent(type: string, props: Props = {}): DwgEntity {
  return {
    type,
    handle: nextHandle(),
    ownerBlockRecordSoftId: '',
    layer: '0',
    colorIndex: 256,
    lineType: '',
    lineweight: 29,
    lineTypeScale: 1,
    isVisible: true,
    transparencyType: 0,
    ...props,
  } as unknown as DwgEntity;
}

const line = (a: P, b: P, props: Props = {}) =>
  ent('LINE', {
    startPoint: { z: 0, ...a },
    endPoint: { z: 0, ...b },
    extrusionDirection: { x: 0, y: 0, z: 1 },
    ...props,
  });

interface BlockSpec {
  name: string;
  handle?: string;
  base?: P;
  flags?: number;
  ents: DwgEntity[];
}

interface DbSpec {
  model?: DwgEntity[];
  blocks?: BlockSpec[];
  layers?: Props[];
  ltypes?: { name: string; pattern?: number[] }[];
  header?: Props;
  layouts?: { name: string; tab: number; block: string }[];
}

function makeDb(spec: DbSpec): DwgDatabase {
  const records = [
    {
      name: '*Model_Space',
      handle: '1F',
      flags: 0,
      basePoint: { x: 0, y: 0, z: 0 },
      entities: spec.model ?? [],
    },
    ...(spec.blocks ?? []).map((b, i) => ({
      name: b.name,
      handle: b.handle ?? `B${i}`,
      flags: b.flags ?? 0,
      basePoint: { z: 0, ...(b.base ?? { x: 0, y: 0 }) },
      entities: b.ents,
    })),
  ];
  return {
    header: { INSUNITS: 6, LTSCALE: 1, ...(spec.header ?? {}) },
    tables: {
      BLOCK_RECORD: { entries: records },
      LAYER: {
        entries: [
          {
            name: '0',
            colorIndex: 7,
            color: 0xffffff,
            lineType: 'Continuous',
            lineweight: 31,
            off: false,
            frozen: false,
            plotFlag: 1,
          },
          ...(spec.layers ?? []),
        ],
      },
      LTYPE: {
        entries: [
          { name: 'ByBlock', pattern: [] },
          { name: 'ByLayer', pattern: [] },
          { name: 'Continuous', pattern: [] },
          ...(spec.ltypes ?? []).map((l) => ({
            name: l.name,
            pattern: (l.pattern ?? []).map((v) => ({ elementLength: v, elementTypeFlag: 0 })),
          })),
        ],
      },
      APPID: { entries: [] },
      DIMSTYLE: { entries: [] },
      STYLE: { entries: [] },
      VPORT: { entries: [] },
    },
    objects: {
      LAYOUT: (spec.layouts ?? []).map((l) => ({
        layoutName: l.name,
        tabOrder: l.tab,
        paperSpaceTableId: l.block,
      })),
      DICTIONARY: [],
      IMAGEDEF: [],
      LAYER_FILTER: [],
      LAYER_INDEX: [],
      MLEADERSTYLE: [],
      SPATIAL_FILTER: [],
      XRECORD: [],
    },
    entities: [],
    classes: [],
  } as unknown as DwgDatabase;
}

const geom = (r: DrawingParseResult, i: number) =>
  Array.from(r.store.geom.subarray(r.store.geomStart[i], r.store.geomStart[i] + r.store.geomLen[i]));

function expectClose(actual: ArrayLike<number>, expected: number[], tol = 1e-9) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++)
    expect(Math.abs(actual[i] - expected[i]), `index ${i}`).toBeLessThanOrEqual(tol);
}

const indicesOf = (r: DrawingParseResult, type: number) => {
  const out: number[] = [];
  for (let i = 0; i < r.store.count; i++) if (r.store.type[i] === type) out.push(i);
  return out;
};

// ------------------------------------------------------------------------------------------------

describe('dwgLineweight', () => {
  it('maps raw DWG lineweight indices to 1/100 mm and BYLAYER/BYBLOCK/default', () => {
    expect(dwgLineweight(0)).toBe(0);
    expect(dwgLineweight(7)).toBe(25);
    expect(dwgLineweight(13)).toBe(60);
    expect(dwgLineweight(23)).toBe(211);
    expect(dwgLineweight(29)).toBe(-1);
    expect(dwgLineweight(30)).toBe(-2);
    expect(dwgLineweight(31)).toBe(-3);
    expect(dwgLineweight(26)).toBe(-3);
    expect(dwgLineweight(-2)).toBe(-2);
    expect(dwgLineweight(undefined)).toBe(-1);
  });
});

describe('dwgDatabaseToStore — simple entities and properties', () => {
  it('converts lines, circles and arcs (radians) with resolved colours and lineweights', () => {
    const db = makeDb({
      layers: [
        {
          name: 'Green',
          colorIndex: 3,
          color: 0xffffff,
          lineType: 'Continuous',
          lineweight: 13,
          plotFlag: 1,
        },
      ],
      model: [
        line({ x: 0, y: 0 }, { x: 10, y: 5 }, { colorIndex: 1, lineweight: 13 }),
        ent('CIRCLE', {
          center: { x: 5, y: 5, z: 0 },
          radius: 2,
          layer: 'Green',
          extrusionDirection: { x: 0, y: 0, z: 1 },
        }),
        ent('ARC', {
          center: { x: 0, y: 0, z: 0 },
          radius: 1,
          startAngle: Math.PI / 2,
          endAngle: Math.PI,
          color: 0x123456,
          colorIndex: 256,
          lineweight: 31,
        }),
        line({ x: 0, y: 0 }, { x: 1, y: 1 }, { colorIndex: 0, lineweight: 30 }),
      ],
    });
    const r = dwgDatabaseToStore(db, { version: 'AC1032' });
    expect(r.store.count).toBe(4);
    expect(r.report.counts).toEqual({ LINE: 2, CIRCLE: 1, ARC: 1 });
    expect(r.store.geomKind[0]).toBe(GK.LINE);
    expect(geom(r, 0)).toEqual([0, 0, 10, 5]);
    expect(r.store.color[0]).toBe(0xff0000);
    expect(r.store.lineweight[0]).toBe(60);
    // BYLAYER colour and lineweight from the layer
    expect(r.store.geomKind[1]).toBe(GK.CIRCLE);
    expect(geom(r, 1)).toEqual([5, 5, 2]);
    expect(r.store.color[1]).toBe(0x00ff00);
    expect(r.store.lineweight[1]).toBe(60);
    expect(r.store.layers[r.store.layer[1]].name).toBe('Green');
    // true colour, default lineweight
    expect(r.store.geomKind[2]).toBe(GK.ARC);
    expectClose(geom(r, 2), [0, 0, 1, Math.PI / 2, Math.PI]);
    expect(r.store.color[2]).toBe(0x123456);
    expect(r.store.lineweight[2]).toBe(-3);
    // BYBLOCK at the top level: white, default lineweight
    expect(r.store.color[3]).toBe(0xffffff);
    expect(r.store.lineweight[3]).toBe(-3);
    expect(r.insunits).toBe(6);
    expect(r.version).toBe('AC1032');
    expect(r.extents).toEqual({ minX: -1, minY: 0, maxX: 10, maxY: 7 });
  });

  it('builds the layer table (off, frozen, plot, Defpoints, true colour) and linetype patterns', () => {
    const db = makeDb({
      header: { LTSCALE: 2 },
      ltypes: [{ name: 'DASHED', pattern: [0.5, -0.25] }],
      layers: [
        { name: 'Off', colorIndex: 1, off: true, lineType: 'DASHED', lineweight: 7, plotFlag: 1 },
        { name: 'Frozen', colorIndex: 5, frozen: true, lineType: 'Continuous', lineweight: 31, plotFlag: 0 },
        { name: 'Defpoints', colorIndex: 7, lineType: 'Continuous', lineweight: 31, plotFlag: 1 },
        { name: 'TC', colorIndex: 256, color: 0x336699, lineType: 'Missing', lineweight: 31, plotFlag: 1 },
      ],
      model: [
        line({ x: 0, y: 0 }, { x: 1, y: 0 }, { layer: 'Off' }),
        line({ x: 0, y: 0 }, { x: 1, y: 0 }, { layer: 'Off', lineType: 'Continuous', lineTypeScale: 0.5 }),
        line({ x: 0, y: 0 }, { x: 1, y: 0 }, { lineType: 'DASHED' }),
        line({ x: 0, y: 0 }, { x: 1, y: 0 }, { lineType: 'NOPE' }),
        line({ x: 0, y: 0 }, { x: 1, y: 0 }, { layer: 'TC' }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    const L = Object.fromEntries(r.store.layers.map((l) => [l.name, l]));
    expect(L.Off).toMatchObject({
      color: 0xff0000,
      off: true,
      frozen: false,
      plot: true,
      linetype: 'DASHED',
      lineweight: 25,
    });
    expect(L.Frozen).toMatchObject({ color: 0x0000ff, frozen: true, plot: false, lineweight: -3 });
    expect(L.Defpoints.plot).toBe(false);
    expect(L.TC.color).toBe(0x336699);
    expect(r.store.linetypes.map((l) => l.name)).toEqual(['CONTINUOUS', 'DASHED']);
    expect(r.store.linetypes[1].pattern).toEqual([0.5, -0.25]);
    expect(r.store.linetype[0]).toBe(1); // BYLAYER → layer's DASHED
    expect(r.store.linetype[1]).toBe(0);
    expect(r.store.ltscale[0]).toBe(2);
    expect(r.store.ltscale[1]).toBe(1); // LTSCALE 2 × entity 0.5
    expect(r.store.linetype[2]).toBe(1);
    expect(r.store.linetype[3]).toBe(0);
    expect(r.report.warnings).toContain('Linetype "NOPE" is not defined — drawn continuous.');
    expect(r.report.warnings).toContain('Linetype "Missing" is not defined — drawn continuous.');
  });

  it('treats pre-2000 formats as unitless with BYLAYER lineweights', () => {
    const db = makeDb({
      header: { INSUNITS: 4 },
      model: [line({ x: 0, y: 0 }, { x: 1, y: 1 }, { lineweight: 0 })],
    });
    const r = dwgDatabaseToStore(db, { version: 'AC1014' });
    expect(r.insunits).toBe(0);
    expect(r.store.lineweight[0]).toBe(-3); // layer default, not 0.00 mm
    expect(dwgDatabaseToStore(db, { version: 'AC1015' }).insunits).toBe(4);
  });

  it('handles LWPOLYLINE closed flag (bit 512), bulges and elevation', () => {
    const db = makeDb({
      model: [
        ent('LWPOLYLINE', {
          flag: 512,
          elevation: 3,
          extrusionDirection: { x: 0, y: 0, z: 0 },
          vertices: [
            { x: 0, y: 0, bulge: 0 },
            { x: 2, y: 0, bulge: 1 },
            { x: 2, y: 2, bulge: 0 },
          ],
        }),
        ent('LWPOLYLINE', {
          flag: 0,
          vertices: [
            { x: 0, y: 0, bulge: 0 },
            { x: 1, y: 0, bulge: 0 },
          ],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.geomKind[0]).toBe(GK.POLY);
    expect(r.store.flags[0] & FLAG.CLOSED).toBe(FLAG.CLOSED);
    expect(readPoly(r.store, 0)).toEqual([
      { x: 0, y: 0, bulge: 0 },
      { x: 2, y: 0, bulge: 1 },
      { x: 2, y: 2, bulge: 0 },
    ]);
    // semicircle bulge bulges to x = 3
    expect(r.store.bbox[2]).toBeCloseTo(3, 12);
    expect(r.store.flags[1] & FLAG.CLOSED).toBe(0);
  });

  it('applies the OCS for extrusion (0, 0, −1) (mirrored about the Y axis)', () => {
    const N = { x: 0, y: 0, z: -1 };
    const db = makeDb({
      model: [
        ent('CIRCLE', { center: { x: 3, y: 4, z: 0 }, radius: 1, extrusionDirection: N }),
        ent('ARC', {
          center: { x: 3, y: 4, z: 0 },
          radius: 2,
          startAngle: 0,
          endAngle: Math.PI / 2,
          extrusionDirection: N,
        }),
        ent('LWPOLYLINE', {
          flag: 0,
          extrusionDirection: N,
          vertices: [
            { x: 1, y: 0, bulge: 0.5 },
            { x: 3, y: 0, bulge: 0 },
          ],
        }),
        ent('TEXT', {
          text: 'M',
          startPoint: { x: 5, y: 1 },
          endPoint: { x: 0, y: 0 },
          textHeight: 2,
          rotation: 0,
          xScale: 1,
          obliqueAngle: 0,
          generationFlag: 0,
          halign: 0,
          valign: 0,
          extrusionDirection: N,
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.geomKind[0]).toBe(GK.CIRCLE);
    expectClose(geom(r, 0), [-3, 4, 1]);
    expect(r.store.geomKind[1]).toBe(GK.ARC);
    expectClose(geom(r, 1), [-3, 4, 2, Math.PI / 2, Math.PI]);
    expect(readPoly(r.store, 2)).toEqual([
      { x: -1, y: 0, bulge: -0.5 },
      { x: -3, y: 0, bulge: 0 },
    ]);
    const t = geom(r, 3);
    expectClose(t.slice(0, 2), [-5, 1]);
    expect(t[4]).toBeLessThan(0); // mirrored text: negative width factor
  });

  it('converts SOLID (vertex order 1, 2, 4, 3), 3DFACE, POINT, LEADER and POLYLINE2D/3D', () => {
    const db = makeDb({
      model: [
        ent('SOLID', {
          corner1: { x: 0, y: 0 },
          corner2: { x: 1, y: 0 },
          corner3: { x: 0, y: 1 },
          corner4: { x: 1, y: 1 },
          extrusionDirection: { x: 0, y: 0, z: 1 },
        }),
        ent('3DFACE', {
          corner1: { x: 0, y: 0, z: 0 },
          corner2: { x: 1, y: 0, z: 1 },
          corner3: { x: 1, y: 1, z: 2 },
          corner4: { x: 1, y: 1, z: 2 },
        }),
        ent('POINT', { position: { x: 7, y: 8, z: 9 } }),
        ent('LEADER', {
          vertices: [
            { x: 0, y: 0, z: 0 },
            { x: 1, y: 1, z: 0 },
            { x: 2, y: 1, z: 0 },
          ],
        }),
        ent('POLYLINE2D', {
          flag: 1,
          elevation: 0,
          vertices: [
            { x: 0, y: 0, z: 0, bulge: 0, flag: 0 },
            { x: 5, y: 5, z: 0, bulge: 0, flag: 16 },
            { x: 1, y: 0, z: 0, bulge: 0, flag: 0 },
            { x: 1, y: 1, z: 0, bulge: 0, flag: 0 },
          ],
        }),
        ent('POLYLINE3D', {
          flag: 0,
          vertices: [
            { x: 0, y: 0, z: 5, flag: 32 },
            { x: 2, y: 3, z: 1, flag: 32 },
          ],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.type[0]).toBe(ET.SOLID);
    expect(readRings(r.store, 0)[0].map((v) => [v.x, v.y])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    expect(r.store.type[1]).toBe(ET.FACE3D);
    expect(readPoly(r.store, 1)).toHaveLength(3);
    expect(r.store.flags[1] & FLAG.CLOSED).toBe(FLAG.CLOSED);
    expect(geom(r, 2)).toEqual([7, 8]);
    expect(r.store.type[3]).toBe(ET.LEADER);
    expect(readPoly(r.store, 3)).toHaveLength(3);
    expect(r.store.type[4]).toBe(ET.POLYLINE);
    expect(readPoly(r.store, 4).map((v) => [v.x, v.y])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(r.store.flags[4] & FLAG.CLOSED).toBe(FLAG.CLOSED);
    expect(readPoly(r.store, 5).map((v) => [v.x, v.y])).toEqual([
      [0, 0],
      [2, 3],
    ]);
    expect(r.report.counts).toEqual({ SOLID: 1, '3DFACE': 1, POINT: 1, LEADER: 1, POLYLINE: 2 });
  });

  it('tessellates NURBS splines and interpolates fit-point splines', () => {
    const db = makeDb({
      model: [
        ent('SPLINE', {
          degree: 2,
          knots: [0, 0, 0, 1, 1, 1],
          controlPoints: [
            { x: 0, y: 0, z: 0 },
            { x: 1, y: 2, z: 0 },
            { x: 2, y: 0, z: 0 },
          ],
          fitPoints: [],
        }),
        ent('SPLINE', {
          degree: 3,
          knots: [],
          controlPoints: [],
          fitPoints: [
            { x: 0, y: 0, z: 0 },
            { x: 1, y: 1, z: 0 },
            { x: 2, y: 0, z: 0 },
            { x: 3, y: -1, z: 0 },
          ],
          startTangent: { x: 0, y: 0, z: 0 },
          endTangent: { x: 0, y: 0, z: 0 },
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    const a = readPoly(r.store, 0);
    expect(a[0]).toMatchObject({ x: 0, y: 0 });
    expect(a[a.length - 1]).toMatchObject({ x: 2, y: 0 });
    // Quadratic Bézier apex at t = 0.5 is (1, 1).
    expect(Math.max(...a.map((p) => p.y))).toBeCloseTo(1, 4);
    expect(a.length).toBeGreaterThan(10);
    const b = readPoly(r.store, 1);
    for (const f of [
      [0, 0],
      [1, 1],
      [2, 0],
      [3, -1],
    ])
      expect(b.some((p) => Math.hypot(p.x - f[0], p.y - f[1]) < 1e-12)).toBe(true);
  });
});

describe('dwgDatabaseToStore — spline accuracy (NFR-7)', () => {
  // Exactly a quarter circle of radius 500 m: rational quadratic.
  const arc = () =>
    ent('SPLINE', {
      degree: 2,
      knots: [0, 0, 0, 1, 1, 1],
      controlPoints: [
        { x: 600_500, y: 2_500_000, z: 0 },
        { x: 600_500, y: 2_500_500, z: 0 },
        { x: 600_000, y: 2_500_500, z: 0 },
      ],
      weights: [1, Math.SQRT1_2, 1],
      fitPoints: [],
    });
  const deviation = (r: DrawingParseResult) => {
    const p = readPoly(r.store, 0);
    let worst = 0;
    for (let k = 1; k < p.length; k++)
      worst = Math.max(
        worst,
        500 - Math.hypot((p[k - 1].x + p[k].x) / 2 - 600_000, (p[k - 1].y + p[k].y) / 2 - 2_500_000),
      );
    return worst;
  };

  it('stays within 0.5 mm of the true curve when the drawing is in metres', () => {
    expect(
      deviation(dwgDatabaseToStore(makeDb({ model: [arc()], header: { INSUNITS: 6 } }))),
    ).toBeLessThanOrEqual(5e-4);
    // Unitless, or a pre-2000 file (whose INSUNITS is not read): the relative tolerance only.
    expect(
      deviation(dwgDatabaseToStore(makeDb({ model: [arc()], header: { INSUNITS: 0 } }))),
    ).toBeGreaterThan(1e-3);
    expect(
      deviation(
        dwgDatabaseToStore(makeDb({ model: [arc()], header: { INSUNITS: 6 } }), { version: 'AC1014' }),
      ),
    ).toBeGreaterThan(1e-3);
  });
});

describe('dwgDatabaseToStore — block references', () => {
  it('applies insertion point, rotation, scale and base point', () => {
    const db = makeDb({
      blocks: [{ name: 'B', base: { x: 1, y: 1 }, ents: [line({ x: 1, y: 1 }, { x: 2, y: 1 })] }],
      model: [
        ent('INSERT', {
          name: 'B',
          insertionPoint: { x: 10, y: 0, z: 0 },
          xScale: 2,
          yScale: 2,
          zScale: 1,
          rotation: Math.PI / 2,
          attribs: [],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.count).toBe(1);
    expectClose(geom(r, 0), [10, 0, 10, 2]);
    expect(r.store.flags[0] & FLAG.IN_BLOCK).toBe(FLAG.IN_BLOCK);
    expect(r.store.insertIndex[0]).toBe(0);
    expect(r.store.inserts).toEqual([{ name: 'B', handle: expect.any(String), type: 'INSERT' }]);
    expect(r.store.ltscale[0]).toBeCloseTo(2, 6);
    expect(r.report.counts).toEqual({ INSERT: 1 });
  });

  it('mirrors arcs and bulges under a negative scale and turns circles into ellipses under non-uniform scale', () => {
    const blockEnts = [
      ent('ARC', { center: { x: 0, y: 0, z: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI / 2 }),
      ent('LWPOLYLINE', {
        flag: 0,
        vertices: [
          { x: 0, y: 0, bulge: 0.5 },
          { x: 2, y: 0, bulge: 0 },
        ],
      }),
      ent('CIRCLE', { center: { x: 0, y: 0, z: 0 }, radius: 1 }),
    ];
    const db = makeDb({
      blocks: [{ name: 'M', ents: blockEnts }],
      model: [
        ent('INSERT', {
          name: 'M',
          insertionPoint: { x: 0, y: 0, z: 0 },
          xScale: -1,
          yScale: 1,
          zScale: 1,
          rotation: 0,
          attribs: [],
        }),
        ent('INSERT', {
          name: 'M',
          insertionPoint: { x: 100, y: 0, z: 0 },
          xScale: 2,
          yScale: 1,
          zScale: 1,
          rotation: 0,
          attribs: [],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    // mirrored
    expect(r.store.geomKind[0]).toBe(GK.ARC);
    expectClose(geom(r, 0), [0, 0, 1, Math.PI / 2, Math.PI]);
    const mp = readPoly(r.store, 1);
    expectClose([mp[0].x, mp[0].y, mp[0].bulge, mp[1].x, mp[1].y, mp[1].bulge], [0, 0, -0.5, -2, 0, 0]);
    expect(r.store.geomKind[2]).toBe(GK.CIRCLE);
    // non-uniform: the arc becomes an elliptical arc, the bulge is tessellated, the circle an ellipse
    expect(r.store.geomKind[3]).toBe(GK.ELLIPSE);
    const poly = readPoly(r.store, 4);
    expect(poly.length).toBeGreaterThan(3);
    expect(poly.every((v) => v.bulge === 0)).toBe(true);
    expect(poly[poly.length - 1]).toMatchObject({ x: 104, y: 0 });
    expect(r.store.geomKind[5]).toBe(GK.ELLIPSE);
    const e = geom(r, 5);
    expectClose([e[0], e[1], Math.hypot(e[2], e[3]), e[4]], [100, 0, 2, 0.5]);
  });

  it('expands MINSERT-style arrays (columns × rows) in the rotated insert frame', () => {
    const db = makeDb({
      blocks: [{ name: 'A', ents: [ent('POINT', { position: { x: 0, y: 0, z: 0 } })] }],
      model: [
        ent('INSERT', {
          name: 'A',
          insertionPoint: { x: 1, y: 1, z: 0 },
          xScale: 1,
          yScale: 1,
          zScale: 1,
          rotation: Math.PI / 2,
          columnCount: 3,
          rowCount: 2,
          columnSpacing: 10,
          rowSpacing: 5,
          attribs: [],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.count).toBe(6);
    const pts = Array.from({ length: 6 }, (_, i) => geom(r, i).map((v) => Math.round(v * 1e9) / 1e9));
    expect(pts).toEqual([
      [1, 1],
      [1, 11],
      [1, 21],
      [-4, 1],
      [-4, 11],
      [-4, 21],
    ]);
    expect(r.store.inserts).toHaveLength(1);
  });

  it('inherits BYBLOCK colour/linetype/lineweight and layer "0" from the reference, through nesting', () => {
    const db = makeDb({
      ltypes: [{ name: 'DASHED', pattern: [1, -1] }],
      layers: [{ name: 'L1', colorIndex: 3, lineType: 'Continuous', lineweight: 31, plotFlag: 1 }],
      blocks: [
        {
          name: 'Inner',
          ents: [
            line({ x: 0, y: 0 }, { x: 1, y: 0 }, { colorIndex: 0, lineType: 'ByBlock', lineweight: 30 }),
          ],
        },
        {
          name: 'Outer',
          ents: [
            ent('INSERT', {
              name: 'Inner',
              insertionPoint: { x: 0, y: 0, z: 0 },
              xScale: 1,
              yScale: 1,
              zScale: 1,
              rotation: 0,
              colorIndex: 0,
              lineType: 'ByBlock',
              lineweight: 30,
              attribs: [],
            }),
            line({ x: 0, y: 0 }, { x: 0, y: 1 }, { colorIndex: 256 }),
          ],
        },
      ],
      model: [
        ent('INSERT', {
          name: 'Outer',
          layer: 'L1',
          insertionPoint: { x: 0, y: 0, z: 0 },
          xScale: 1,
          yScale: 1,
          zScale: 1,
          rotation: 0,
          colorIndex: 5,
          lineType: 'DASHED',
          lineweight: 13,
          attribs: [],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.count).toBe(2);
    for (const i of [0, 1]) {
      expect(r.store.layers[r.store.layer[i]].name).toBe('L1');
      expect(r.store.insertIndex[i]).toBe(0);
    }
    expect(r.store.color[0]).toBe(0x0000ff);
    expect(r.store.linetype[0]).toBe(1);
    expect(r.store.lineweight[0]).toBe(60);
    // BYLAYER on layer "0" inside a block resolves to the reference's layer L1 (green).
    expect(r.store.color[1]).toBe(0x00ff00);
    expect(r.store.inserts).toEqual([{ name: 'Outer', handle: expect.any(String), type: 'INSERT' }]);
  });

  it('skips recursive references and nesting deeper than the limit with warnings', () => {
    const self = ent('INSERT', {
      name: 'R',
      insertionPoint: { x: 1, y: 0, z: 0 },
      xScale: 1,
      yScale: 1,
      zScale: 1,
      rotation: 0,
      attribs: [],
    });
    const chain: BlockSpec[] = [];
    for (let k = 0; k < MAX_BLOCK_DEPTH + 5; k++) {
      chain.push({
        name: `C${k}`,
        ents: [
          line({ x: 0, y: 0 }, { x: 1, y: 0 }),
          ent('INSERT', {
            name: `C${k + 1}`,
            insertionPoint: { x: 0, y: 1, z: 0 },
            xScale: 1,
            yScale: 1,
            zScale: 1,
            rotation: 0,
            attribs: [],
          }),
        ],
      });
    }
    chain.push({ name: `C${MAX_BLOCK_DEPTH + 5}`, ents: [] });
    const db = makeDb({
      blocks: [{ name: 'R', ents: [line({ x: 0, y: 0 }, { x: 1, y: 1 }), self] }, ...chain],
      model: [
        ent('INSERT', {
          name: 'R',
          insertionPoint: { x: 0, y: 0, z: 0 },
          xScale: 1,
          yScale: 1,
          zScale: 1,
          rotation: 0,
          attribs: [],
        }),
        ent('INSERT', {
          name: 'C0',
          insertionPoint: { x: 0, y: 0, z: 0 },
          xScale: 1,
          yScale: 1,
          zScale: 1,
          rotation: 0,
          attribs: [],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.report.warnings.some((w) => w.includes('Block "R" references itself'))).toBe(true);
    expect(r.report.warnings.some((w) => w.includes(`deeper than ${MAX_BLOCK_DEPTH} levels`))).toBe(true);
    // R's line once + one line per allowed nesting level of the chain
    expect(r.store.count).toBe(1 + MAX_BLOCK_DEPTH);
    expect(r.report.skipped.INSERT).toBe(2);
  });

  it('reports missing blocks and unloaded xrefs', () => {
    const db = makeDb({
      blocks: [{ name: 'XREF', flags: 4, ents: [] }],
      model: [
        ent('INSERT', {
          name: 'Nope',
          insertionPoint: { x: 0, y: 0, z: 0 },
          xScale: 1,
          yScale: 1,
          zScale: 1,
          rotation: 0,
          attribs: [],
        }),
        ent('INSERT', {
          name: 'XREF',
          insertionPoint: { x: 0, y: 0, z: 0 },
          xScale: 1,
          yScale: 1,
          zScale: 1,
          rotation: 0,
          attribs: [],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.count).toBe(0);
    expect(r.report.skipped).toEqual({ INSERT: 1, 'INSERT (xref)': 1 });
    expect(r.report.warnings).toContain('Block "Nope" is not defined — its references were skipped.');
    expect(r.report.warnings).toContain('External reference "XREF" is not loaded.');
  });

  it('emits visible and invisible ATTRIBs in the container frame; ATTDEFs only at top level', () => {
    const textBase = (text: string, x: number, y: number) => ({
      text,
      startPoint: { x, y },
      endPoint: { x: 0, y: 0 },
      textHeight: 1,
      rotation: 0,
      xScale: 1,
      obliqueAngle: 0,
      generationFlag: 0,
      halign: 0,
      valign: 0,
      extrusionDirection: { x: 0, y: 0, z: 1 },
    });
    const db = makeDb({
      blocks: [
        {
          name: 'T',
          ents: [
            ent('ATTDEF', { tag: 'TAG', text: textBase('', 0, 0), flags: 0 }),
            line({ x: 0, y: 0 }, { x: 1, y: 0 }),
          ],
        },
      ],
      model: [
        ent('INSERT', {
          name: 'T',
          insertionPoint: { x: 10, y: 0, z: 0 },
          xScale: 1,
          yScale: 1,
          zScale: 1,
          rotation: 0,
          colorIndex: 2,
          attribs: [
            ent('ATTRIB', { tag: 'A', text: textBase('Value 1', 12, 3), flags: 0, colorIndex: 0 }),
            ent('ATTRIB', { tag: 'B', text: textBase('Hidden', 12, 5), flags: 1 }),
          ],
        }),
        ent('ATTDEF', { tag: 'TOPTAG', text: textBase('', 1, 2), flags: 0 }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.report.counts).toEqual({ INSERT: 1, ATTRIB: 2, ATTDEF: 1 });
    const attribs = indicesOf(r, ET.ATTRIB);
    expect(attribs).toHaveLength(2);
    expect(r.store.texts[r.store.textIndex[attribs[0]]]).toBe('Value 1');
    expectClose(geom(r, attribs[0]).slice(0, 2), [12, 3]);
    expect(r.store.color[attribs[0]]).toBe(0xffff00); // BYBLOCK → insert colour
    expect(r.store.flags[attribs[0]] & FLAG.HIDDEN).toBe(0);
    expect(r.store.flags[attribs[1]] & FLAG.HIDDEN).toBe(FLAG.HIDDEN);
    const texts = indicesOf(r, ET.TEXT);
    expect(texts.map((i) => r.store.texts[r.store.textIndex[i]])).toEqual(['TOPTAG']);
  });

  it('renders DIMENSION blocks and skips dimensions without one', () => {
    const db = makeDb({
      blocks: [
        {
          name: '*D1',
          ents: [
            line({ x: 0, y: 0 }, { x: 5, y: 0 }),
            ent('MTEXT', {
              text: '5',
              insertionPoint: { x: 2.5, y: 1, z: 0 },
              textHeight: 1,
              attachmentPoint: 8,
              direction: { x: 1, y: 0, z: 0 },
              rectWidth: 0,
              lineSpacing: 1,
            }),
          ],
        },
      ],
      model: [
        ent('DIMENSION', { name: '*D1', extrusionDirection: { x: 0, y: 0, z: 1 } }),
        ent('DIMENSION', { name: '*D9' }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.report.counts).toEqual({ DIMENSION: 1 });
    expect(r.report.skipped).toEqual({ DIMENSION: 1 });
    expect(r.store.count).toBe(2);
    expect(r.store.type[0]).toBe(ET.LINE);
    expect(r.store.inserts[0].type).toBe('DIMENSION');
    expect(r.store.flags[1] & FLAG.IN_BLOCK).toBe(FLAG.IN_BLOCK);
  });

  it('stops at the entity limit with an error', () => {
    const db = makeDb({
      blocks: [{ name: 'P', ents: [ent('POINT', { position: { x: 0, y: 0, z: 0 } })] }],
      model: [
        ent('INSERT', {
          name: 'P',
          insertionPoint: { x: 0, y: 0, z: 0 },
          xScale: 1,
          yScale: 1,
          zScale: 1,
          rotation: 0,
          columnCount: 100,
          rowCount: 100,
          columnSpacing: 1,
          rowSpacing: 1,
          attribs: [],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db, { maxEntities: 5000 });
    expect(r.report.errors[0]).toMatch(/too many entities .*\(limit 5,000\)/);
    expect(r.store.count).toBeLessThanOrEqual(8192);
    const capped = dwgDatabaseToStore(db, { maxVisits: 1000 });
    expect(capped.store.count).toBe(0);
    expect(capped.report.errors[0]).toMatch(/would expand to about 2\.0e\+4 entities/);
  });
});

describe('dwgDatabaseToStore — text', () => {
  const base = {
    startPoint: { x: 1, y: 2 },
    endPoint: { x: 5, y: 2 },
    textHeight: 2,
    rotation: 0,
    xScale: 1,
    obliqueAngle: 0,
    generationFlag: 0,
    extrusionDirection: { x: 0, y: 0, z: 1 },
  };

  it('handles TEXT justification, aligned text, backwards text and %% codes', () => {
    const db = makeDb({
      model: [
        ent('TEXT', { ...base, text: '%%c25 %%d %%p1', halign: 0, valign: 0 }),
        ent('TEXT', { ...base, text: 'mid', halign: 1, valign: 2 }),
        ent('TEXT', { ...base, text: 'aligned', halign: 3, valign: 0, endPoint: { x: 1, y: 6 } }),
        ent('TEXT', { ...base, text: 'back', halign: 0, valign: 0, generationFlag: 2 }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    const t = (i: number) => r.store.texts[r.store.textIndex[i]];
    expect(t(0)).toBe('Ø25 ° ±1');
    expectClose(geom(r, 0), [1, 2, 2, 0, 1, 0, 0, 0, 0, 1, -1]);
    expectClose(geom(r, 1), [5, 2, 2, 0, 1, 1, 2, 0, 0, 1, -1]);
    expectClose(geom(r, 2), [1, 2, 2, Math.PI / 2, 1, 0, 0, 0, 4, 1, -1]);
    expect(geom(r, 3)[4]).toBe(-1);
  });

  it('strips MTEXT formatting and maps attachment point and direction', () => {
    const db = makeDb({
      model: [
        ent('MTEXT', {
          text: '{\\fArial|b1|i0|c0|p34;Hello}\\PWorld \\S1^2;\\~x\\\\y\\U+00B0',
          insertionPoint: { x: 3, y: 4, z: 0 },
          textHeight: 2.5,
          attachmentPoint: 5,
          direction: { x: 0, y: 1, z: 0 },
          rectWidth: 40,
          lineSpacing: 1.5,
          extrusionDirection: { x: 0, y: 0, z: 1 },
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.texts[0]).toBe('Hello\nWorld 1/2 x\\y°');
    expectClose(geom(r, 0), [3, 4, 2.5, Math.PI / 2, 1, 1, 2, 0, 40, 1.5, -1]);
    expect(r.store.type[0]).toBe(ET.MTEXT);
  });
});

describe('dwgDatabaseToStore — hatches', () => {
  const square = {
    boundaryPathTypeFlag: 3,
    hasBulge: false,
    isClosed: true,
    numberOfVertices: 4,
    vertices: [
      { x: 0, y: 0, bulge: 0 },
      { x: 10, y: 0, bulge: 0 },
      { x: 10, y: 10, bulge: 0 },
      { x: 0, y: 10, bulge: 0 },
    ],
  };

  it('fills solid hatches and renders gradients as solid', () => {
    const db = makeDb({
      model: [
        ent('HATCH', {
          patternName: 'SOLID',
          solidFill: 1,
          boundaryPaths: [square],
          definitionLines: [],
          hatchStyle: 0,
        }),
        ent('HATCH', {
          patternName: '',
          solidFill: 0,
          gradientFlag: 1,
          boundaryPaths: [square],
          definitionLines: [],
          hatchStyle: 0,
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.count).toBe(2);
    for (const i of [0, 1]) {
      expect(r.store.geomKind[i]).toBe(GK.FILL);
      expect(r.store.flags[i] & FLAG.PATTERN).toBe(0);
    }
    expect(readRings(r.store, 0)).toHaveLength(1);
  });

  it('generates pattern lines clipped to the boundary (even-odd with a hole)', () => {
    const hole = {
      boundaryPathTypeFlag: 2,
      hasBulge: false,
      isClosed: true,
      vertices: [
        { x: 4, y: 4, bulge: 0 },
        { x: 6, y: 4, bulge: 0 },
        { x: 6, y: 6, bulge: 0 },
        { x: 4, y: 6, bulge: 0 },
      ],
    };
    const db = makeDb({
      model: [
        ent('HATCH', {
          patternName: 'ANSI31',
          solidFill: 0,
          hatchStyle: 0,
          boundaryPaths: [square, hole],
          definitionLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 1 }, dashLengths: [] }],
        }),
        ent('HATCH', {
          patternName: 'CUSTOM',
          solidFill: 0,
          hatchStyle: 0,
          boundaryPaths: [square],
          definitionLines: [],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.geomKind[0]).toBe(GK.FILL);
    expect(r.store.flags[0] & FLAG.PATTERN).toBe(FLAG.PATTERN);
    expect(readRings(r.store, 0)).toHaveLength(2);
    let len = 0;
    let lines = 0;
    for (let i = 0; i < r.store.count; i++) {
      if (!(r.store.flags[i] & FLAG.DERIVED)) continue;
      lines++;
      const [x1, y1, x2, y2] = geom(r, i);
      expect(y1).toBe(y2);
      expect(Math.min(x1, x2)).toBeGreaterThanOrEqual(0);
      expect(Math.max(x1, x2)).toBeLessThanOrEqual(10);
      len += Math.abs(x2 - x1);
    }
    // Half-open scanlines: y = 0…9 cross the square (a line on the top edge y = 10 does not); the
    // hole removes 2 units from y = 4 and y = 5 (y = 6 lies on its top edge).
    expect(lines).toBe(12);
    expect(len).toBeCloseTo(100 - 4, 9);
    expect(r.report.counts).toEqual({ HATCH: 2 });
    expect(r.report.warnings.some((w) => w.includes('no pattern definition'))).toBe(true);
  });

  it('builds rings from arc, line and ellipse edges (counter-clockwise and clockwise)', () => {
    const circle = {
      boundaryPathTypeFlag: 1,
      edges: [
        { type: 2, center: { x: 0, y: 0 }, radius: 2, startAngle: 0, endAngle: 2 * Math.PI, isCCW: true },
      ],
    };
    // Half disc: line along the x axis, then a clockwise arc stored with mirrored angles.
    const half = {
      boundaryPathTypeFlag: 1,
      edges: [
        { type: 1, start: { x: 10, y: 0 }, end: { x: 14, y: 0 } },
        {
          type: 2,
          center: { x: 12, y: 0 },
          radius: 2,
          startAngle: 2 * Math.PI - 0,
          endAngle: 2 * Math.PI - Math.PI,
          isCCW: false,
        },
      ],
    };
    const ell = {
      boundaryPathTypeFlag: 1,
      edges: [
        {
          type: 3,
          center: { x: 30, y: 0 },
          end: { x: 4, y: 0 },
          lengthOfMinorAxis: 0.5,
          startAngle: 0,
          endAngle: 2 * Math.PI,
          isCCW: true,
        },
      ],
    };
    const db = makeDb({
      model: [
        ent('HATCH', {
          patternName: 'SOLID',
          solidFill: 1,
          hatchStyle: 0,
          boundaryPaths: [circle, half, ell],
          definitionLines: [],
        }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    const rings = readRings(r.store, 0);
    expect(rings).toHaveLength(3);
    // full circle as two 180° bulged pieces
    expect(rings[0]).toHaveLength(2);
    expect(Math.abs(rings[0][0].bulge)).toBeCloseTo(1, 12);
    // clockwise arc from (14, 0) back to (10, 0) through (12, −2)
    expect(rings[1][1]).toMatchObject({ x: 14, y: 0 });
    expect(rings[1][1].bulge).toBeCloseTo(-1, 12);
    expect(r.store.bbox[1]).toBeCloseTo(-2, 9);
    // ellipse 4 × 2 around (30, 0)
    expect(r.store.bbox[2]).toBeCloseTo(34, 9);
  });
});

describe('dwgDatabaseToStore — layouts, skipped and invalid entities', () => {
  it('lists layouts in tab order and converts the selected one', () => {
    const db = makeDb({
      model: [line({ x: 0, y: 0 }, { x: 1, y: 1 })],
      blocks: [
        {
          name: '*Paper_Space',
          handle: '55',
          ents: [ent('VIEWPORT', {}), line({ x: 0, y: 0 }, { x: 420, y: 297 })],
        },
        { name: '*Paper_Space0', handle: '50', ents: [] },
      ],
      layouts: [
        { name: 'Model', tab: 0, block: '1F' },
        { name: 'Sheet B', tab: 2, block: '55' },
        { name: 'Sheet A', tab: 1, block: '50' },
      ],
    });
    expect(listDwgLayouts(db)).toEqual(['Model', 'Sheet A', 'Sheet B']);
    const model = dwgDatabaseToStore(db);
    expect(model.layout).toBe('Model');
    expect(model.store.count).toBe(1);
    const b = dwgDatabaseToStore(db, { layout: 'sheet b' });
    expect(b.layout).toBe('Sheet B');
    expect(b.store.count).toBe(1);
    expect(b.report.skipped).toEqual({ VIEWPORT: 1 });
    expect(() => dwgDatabaseToStore(db, { layout: 'Nope' })).toThrowError(DwgReadError);
    try {
      dwgDatabaseToStore(db, { layout: 'Nope' });
    } catch (e) {
      expect((e as DwgReadError).code).toBe('layout-not-found');
      expect((e as Error).message).toBe(
        'Layout "Nope" not found. Available layouts: Model, Sheet A, Sheet B',
      );
    }
  });

  it('falls back to *Paper_Space blocks when there are no LAYOUT objects', () => {
    const db = makeDb({
      model: [],
      blocks: [{ name: '*PAPER_SPACE', ents: [line({ x: 0, y: 0 }, { x: 1, y: 1 })] }],
    });
    expect(listDwgLayouts(db)).toEqual(['Model', 'Layout1']);
  });

  it('counts unsupported entity types as skipped with readable warnings', () => {
    const db = makeDb({
      model: [
        ent('RAY', {}),
        ent('XLINE', {}),
        ent('MLINE', {}),
        ent('IMAGE', {}),
        ent('IMAGE', {}),
        ent('ACAD_PROXY_ENTITY', {}),
        ent('MINSERT', {}),
        ent('FANCY', {}),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.count).toBe(0);
    expect(r.report.counts).toEqual({});
    expect(r.report.skipped).toEqual({
      RAY: 1,
      XLINE: 1,
      MLINE: 1,
      IMAGE: 2,
      ACAD_PROXY_ENTITY: 1,
      MINSERT: 1,
      FANCY: 1,
    });
    expect(r.report.warnings).toContain('2 IMAGE entities skipped: raster images are not imported.');
    expect(r.report.warnings).toContain('1 FANCY entity skipped: entity type not supported.');
  });

  it('skips invalid entities without failing the import', () => {
    const db = makeDb({
      model: [
        line({ x: NaN, y: 0 }, { x: 1, y: 1 }),
        ent('CIRCLE', { center: { x: 0, y: 0, z: 0 }, radius: 0 }),
        line({ x: 1e20, y: 0 }, { x: 1, y: 1 }),
        ent('LWPOLYLINE', { flag: 0, vertices: [{ x: 0, y: 0, bulge: 0 }] }),
        ent('ARC', {}),
        line({ x: 0, y: 0 }, { x: 1, y: 1 }),
      ],
    });
    const r = dwgDatabaseToStore(db);
    expect(r.store.count).toBe(1);
    expect(r.report.counts).toEqual({ LINE: 1 });
    expect(r.report.skipped).toEqual({ LINE: 2, CIRCLE: 1, LWPOLYLINE: 1, ARC: 1 });
    expect(r.report.warnings.some((w) => w.startsWith('5 invalid entities were skipped (LINE'))).toBe(true);
  });
});
