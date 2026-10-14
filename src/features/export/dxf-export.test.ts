import { describe, expect, it } from 'vitest';

import { apply, similarity } from '@/core/affine';
import { testFontSet } from '@/export/test-fonts';
import { parseDxf } from '@/import/dxf';
import { ET, GK, readPoly } from '@/underlay/entity-store';
import { placementOf } from '@/underlay/models';

import { buildAnalysisDxf, needsShaping } from './dxf-export';
import { addObject, dxfDrawing, settingsFor, testProject } from './test-helpers';

const fonts = testFontSet();

function layerOf(store: ReturnType<typeof parseDxf>['store'], i: number) {
  return store.layers[store.layer[i]]?.name;
}

describe('DXF export of analysis (row 79)', () => {
  it('overlays the source exactly when written in drawing coordinates (XREF at 0,0)', () => {
    const src = dxfDrawing('tests/fixtures/dxf/r2018_plotplan.dxf');
    // A plant-coordinates calibration with rotation, scale and a large translation.
    src.drawing.calibration = {
      method: 'coordinates',
      transform: similarity(1.000137, 0.2617993877991494, -600123.25, -2499870.5),
      references: [],
      residualRms: 0.004,
      at: '2026-10-14T00:00:00.000Z',
    };
    const p = testProject();
    p.drawings.push(src.drawing);
    const place = placementOf(src.drawing, src.input.insunits);
    const k = Math.sqrt(place[0] * place[3] - place[1] * place[2]);
    const s = src.input.store!;
    const sourceCircles: { x: number; y: number; r: number }[] = [];
    let sourcePoly: { x: number; y: number; bulge: number }[] | null = null;
    for (let i = 0; i < s.count; i++) {
      const o = s.geomStart[i];
      if (s.geomKind[i] === GK.CIRCLE) {
        const c = { x: s.geom[o], y: s.geom[o + 1], r: s.geom[o + 2] };
        sourceCircles.push(c);
        // Analysis object traced from the entity: its world position via the placement.
        addObject(p, { type: 'circle', c: apply(place, c), r: c.r * k }, { name: `C${i}` });
      } else if (s.geomKind[i] === GK.POLY && s.type[i] === ET.LWPOLYLINE && !sourcePoly) {
        sourcePoly = readPoly(s, i);
        addObject(
          p,
          {
            type: 'polyline',
            pts: sourcePoly.map((v) => ({ ...apply(place, v), bulge: v.bulge })),
            closed: true,
          },
          { name: 'Trace' },
        );
      }
    }
    expect(sourceCircles.length).toBeGreaterThan(2);
    const r = buildAnalysisDxf({
      project: p,
      settings: settingsFor(p, {
        format: 'dxf',
        dxfCoordinates: 'drawing',
        dxfDrawingId: src.drawing.id,
        includeLegend: false,
      }),
      drawings: { [src.drawing.id]: src.input },
      contours: [],
      fonts,
    });
    expect(r.units).toBe('m');
    const out = parseDxf(r.bytes);
    const os = out.store;
    const circles: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < os.count; i++) {
      if (os.geomKind[i] !== GK.CIRCLE || layerOf(os, i) !== 'Analysis') continue;
      const o = os.geomStart[i];
      circles.push({ x: os.geom[o], y: os.geom[o + 1], r: os.geom[o + 2] });
    }
    expect(circles).toHaveLength(sourceCircles.length);
    for (const c of sourceCircles) {
      // Concentric circles share a centre: match on centre and radius.
      const m = circles.find((x) => Math.hypot(x.x - c.x, x.y - c.y) < 1e-6 && Math.abs(x.r - c.r) < 1e-9);
      expect(m, `circle r=${c.r} at ${c.x}, ${c.y}`).toBeTruthy();
    }
    // The traced polyline lands on the source vertices.
    let poly: { x: number; y: number; bulge: number }[] | null = null;
    for (let i = 0; i < os.count; i++)
      if (os.geomKind[i] === GK.POLY && layerOf(os, i) === 'Analysis') poly = readPoly(os, i);
    expect(poly).toHaveLength(sourcePoly!.length);
    poly!.forEach((v, i) => {
      expect(Math.abs(v.x - sourcePoly![i].x)).toBeLessThan(1e-6);
      expect(Math.abs(v.y - sourcePoly![i].y)).toBeLessThan(1e-6);
      expect(v.bulge).toBeCloseTo(sourcePoly![i].bulge, 12);
    });
    // Fills on their own layer; calibration statement present.
    const layers = os.layers.map((l) => l.name);
    expect(layers).toContain('Analysis-FILL');
    expect(os.texts.some((t) => t.includes('Calibrated (plant coordinates, RMS'))).toBe(true);
  });

  it('writes world (plant) coordinates, labels, contours and the legend on named layers', () => {
    const p = testProject();
    const o = addObject(
      p,
      { type: 'rect', c: { x: 600100, y: 2500050 }, w: 20, h: 10, rot: 0 },
      { name: 'Laydown A' },
    );
    o.label = { template: '{name}', placement: 'centroid', visible: true };
    p.sheet.scale = 500;
    const r = buildAnalysisDxf({
      project: p,
      settings: settingsFor(p, { format: 'dxf', dxfCoordinates: 'world', includeLegend: true }),
      drawings: {},
      contours: [],
      fonts,
    });
    const out = parseDxf(r.bytes);
    const os = out.store;
    let poly = null;
    for (let i = 0; i < os.count; i++)
      if (os.geomKind[i] === GK.POLY && layerOf(os, i) === 'Analysis') poly = readPoly(os, i);
    expect(poly!.map((v) => [v.x, v.y])).toEqual([
      [600090, 2500045],
      [600110, 2500045],
      [600110, 2500055],
      [600090, 2500055],
    ]);
    const names = os.layers.map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining(['Analysis', 'Analysis-LABELS', 'PAT-LEGEND']));
    expect(os.texts).toContain('Laydown A');
    // Label height: 2.5 mm paper at 1:500 = 1.25 m em → cap height ≈ 0.89 m.
    for (let i = 0; i < os.count; i++) {
      if (os.geomKind[i] !== GK.TEXT || os.texts[os.textIndex[i]] !== 'Laydown A') continue;
      expect(os.geom[os.geomStart[i] + 2]).toBeCloseTo(1.25 * 0.714, 6);
    }
  });

  it('writes Arabic labels as shaped outlines plus UTF-8 MTEXT (row 48)', () => {
    const p = testProject();
    const o = addObject(p, { type: 'circle', c: { x: 0, y: 0 }, r: 10 }, { name: 'منطقة الخطر' });
    o.label = { template: '{name}', placement: 'centroid', visible: true };
    expect(needsShaping('منطقة الخطر')).toBe(true);
    expect(needsShaping('Zone A')).toBe(false);
    const r = buildAnalysisDxf({
      project: p,
      settings: settingsFor(p, { format: 'dxf', dxfCoordinates: 'world', includeLegend: false }),
      drawings: {},
      contours: [],
      fonts,
    });
    const text = new TextDecoder().decode(r.bytes);
    expect(text).toContain('منطقة الخطر');
    const os = parseDxf(r.bytes).store;
    const hatches = [...Array(os.count).keys()].filter(
      (i) => os.type[i] === ET.HATCH && layerOf(os, i) === 'Analysis-LABELS',
    );
    expect(hatches.length).toBeGreaterThan(5);
    const textLayer = os.layers.find((l) => l.name === 'Analysis-LABELS-TEXT');
    expect(textLayer?.off).toBe(true);
    // Plain MTEXT when outlines are not wanted.
    const plain = buildAnalysisDxf({
      project: p,
      settings: settingsFor(p, {
        format: 'dxf',
        dxfCoordinates: 'world',
        includeLegend: false,
        dxfText: 'text',
      }),
      drawings: {},
      contours: [],
      fonts,
    });
    const ps = parseDxf(plain.bytes).store;
    expect(ps.texts).toContain('منطقة الخطر');
  });

  it('is deterministic', () => {
    const p = testProject();
    addObject(p, { type: 'circle', c: { x: 1, y: 2 }, r: 3 });
    const a = buildAnalysisDxf({
      project: p,
      settings: settingsFor(p, { format: 'dxf' }),
      drawings: {},
      contours: [],
      fonts,
    });
    const b = buildAnalysisDxf({
      project: p,
      settings: settingsFor(p, { format: 'dxf' }),
      drawings: {},
      contours: [],
      fonts,
    });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });
});
