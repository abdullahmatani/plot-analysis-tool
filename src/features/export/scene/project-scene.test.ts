import { describe, expect, it } from 'vitest';

import { apply } from '@/core/affine';
import { renderScenePdf } from '@/export/pdf-backend';
import { PT_PER_MM, walkScene, type GroupItem, type PathItem, type TextItem } from '@/export/scene';
import { testFontSet } from '@/export/test-fonts';
import { GK } from '@/underlay/entity-store';

import {
  addObject,
  circlesOf,
  dxfDrawing,
  pdfDrawing,
  pdfVectors,
  settingsFor,
  shapesOf,
  testProject,
} from '../test-helpers';
import { buildProjectScene, computeLayout } from './project-scene';
import { niceScaleAtLeast, paperSizeMm } from './sheet';

const fonts = testFontSet();

function groups(items: readonly import('@/export/scene').SceneItem[]): GroupItem[] {
  const out: GroupItem[] = [];
  walkScene(items, (it) => {
    if (it.kind === 'group') out.push(it);
  });
  return out;
}

function texts(items: readonly import('@/export/scene').SceneItem[]): TextItem[] {
  const out: TextItem[] = [];
  walkScene(items, (it) => {
    if (it.kind === 'text') out.push(it);
  });
  return out;
}

describe('sheet layout', () => {
  it('paper sizes and orientation', () => {
    expect(paperSizeMm({ paper: 'A1', orientation: 'landscape' })).toEqual({ w: 841, h: 594 });
    expect(paperSizeMm({ paper: 'A4', orientation: 'portrait' })).toEqual({ w: 210, h: 297 });
    expect(paperSizeMm({ paper: 'ANSI D', orientation: 'landscape' })).toEqual({ w: 863.6, h: 558.8 });
    expect(paperSizeMm({ paper: 'custom', customMm: { w: 300, h: 200 }, orientation: 'portrait' })).toEqual({
      w: 300,
      h: 200,
    });
  });

  it('rounds fitted scales up to standard scales', () => {
    expect(niceScaleAtLeast(480)).toBe(500);
    expect(niceScaleAtLeast(500)).toBe(500);
    expect(niceScaleAtLeast(1100)).toBe(1250);
    expect(niceScaleAtLeast(3_000_000)).toBe(5_000_000);
  });

  it('world → paper honours the print scale and the view rotation', () => {
    const p = testProject();
    p.sheet.scale = 500;
    p.sheet.viewCentre = { x: 1000, y: 2000 };
    p.sheet.viewRotation = Math.PI / 2;
    const layout = computeLayout({ project: p, settings: settingsFor(p), drawings: {}, contours: [] });
    const M = layout.paperFromWorld;
    const c = apply(M, { x: 1000, y: 2000 });
    expect(c.x).toBeCloseTo(layout.viewport.x + layout.viewport.w / 2, 9);
    expect(c.y).toBeCloseTo(layout.viewport.y + layout.viewport.h / 2, 9);
    // 10 m east, rotated 90° CCW, points up on paper and is 20 mm long at 1:500.
    const e = apply(M, { x: 1010, y: 2000 });
    expect(e.x - c.x).toBeCloseTo(0, 9);
    expect(e.y - c.y).toBeCloseTo(-20, 9);
  });

  it('fits content to a standard scale when no scale is set', () => {
    const p = testProject();
    addObject(p, { type: 'rect', c: { x: 0, y: 0 }, w: 400, h: 200, rot: 0 });
    const layout = computeLayout({ project: p, settings: settingsFor(p), drawings: {}, contours: [] });
    expect([500, 1000, 1250]).toContain(layout.scale);
    expect(layout.scaleStatement).toBe(`Scale 1:${layout.scale} at A1`);
  });
});

describe('project → scene', () => {
  it('draws analysis objects at true scale with layer groups, labels and the calibration statement', async () => {
    const p = testProject();
    p.sheet.scale = 500;
    p.sheet.viewCentre = { x: 0, y: 0 };
    const o = addObject(p, { type: 'circle', c: { x: 0, y: 0 }, r: 10 }, { name: 'Tank zone' });
    o.label = { template: '{name}', placement: 'centroid', visible: true };
    const r = buildProjectScene({ project: p, settings: settingsFor(p), drawings: {}, contours: [], fonts });
    const names = groups(r.scene.items).map((g) => g.name);
    expect(names).toContain('Analysis');
    expect(names).toContain('Legend');
    expect(names).toContain('Title block');
    const t = texts(r.scene.items).map((x) => x.text);
    expect(t).toContain('Tank zone');
    expect(t.some((x) => x.startsWith('Calibration: '))).toBe(true);
    expect(t.some((x) => x.includes('Scale 1:500 at A1'))).toBe(true);

    // True scale: the 10 m radius circle is 20 mm on paper, measured in the PDF (row 77).
    const pdf = await renderScenePdf(r.scene, { fonts });
    const v = await pdfVectors(pdf);
    expect(v.width).toBeCloseTo(841 * PT_PER_MM, 3);
    const cx = (r.layout.viewport.x + r.layout.viewport.w / 2) * PT_PER_MM;
    const cy = v.height - (r.layout.viewport.y + r.layout.viewport.h / 2) * PT_PER_MM;
    // The only centred shape smaller than the frame is the circle (≥ 12 Bézier segments → polyline).
    const circle = shapesOf(v.result).find((c) => Math.hypot(c.cx - cx, c.cy - cy) < 0.01 && c.w < 200);
    expect(circle, 'circle at the viewport centre').toBeTruthy();
    expect(circle!.w / 2 / PT_PER_MM).toBeCloseTo(20, 3);
    expect(circle!.h / 2 / PT_PER_MM).toBeCloseTo(20, 3);
    expect(v.text).toContain('Tank zone');
    expect(v.text).toContain('Calibration');
  });

  it('scale bar measures true on the PDF (row 36)', async () => {
    const p = testProject();
    p.sheet.scale = 500;
    const r = buildProjectScene({ project: p, settings: settingsFor(p), drawings: {}, contours: [], fonts });
    const pdf = await renderScenePdf(r.scene, { fonts });
    const v = await pdfVectors(pdf);
    // The bar outline is a closed 4-vertex polyline 1.6 mm high; its length must equal the labelled
    // length at 1:500 (50 m → 100 mm on A1).
    const s = v.result.store;
    const widths: number[] = [];
    for (let i = 0; i < s.count; i++) {
      if (s.geomKind[i] !== GK.POLY) continue;
      const o = i * 4;
      const w = s.bbox[o + 2] - s.bbox[o];
      const h = s.bbox[o + 3] - s.bbox[o + 1];
      if (Math.abs(h - 1.6 * PT_PER_MM) < 0.01 && w > 50) widths.push(w);
    }
    expect(widths.length).toBeGreaterThan(0);
    const longest = Math.max(...widths);
    expect(longest / PT_PER_MM).toBeCloseTo(100, 4);
    expect(v.text).toContain('50 m');
  });

  it('draws CAD underlays as vectors in the right place (plant coordinates)', () => {
    const { drawing, input } = dxfDrawing('tests/fixtures/dxf/r2018_plotplan.dxf');
    const p = testProject();
    p.drawings.push(drawing);
    p.sheet.scale = 1000;
    const r = buildProjectScene({
      project: p,
      settings: settingsFor(p),
      drawings: { [drawing.id]: input },
      contours: [],
      fonts,
    });
    const underlay = groups(r.scene.items).find((g) => g.name === drawing.name);
    expect(underlay).toBeTruthy();
    // Source layers become nested optional-content layers.
    expect(underlay!.children.every((c) => c.kind === 'group' && c.layer)).toBe(true);
    // Every source circle appears with radius r · 1 mm/m at 1:1000.
    const s = input.store!;
    const M = r.layout.paperFromWorld;
    const paths: PathItem[] = [];
    walkScene(underlay!.children, (it) => {
      if (it.kind === 'path') paths.push(it);
    });
    let checked = 0;
    for (let i = 0; i < s.count; i++) {
      if (s.geomKind[i] !== GK.CIRCLE) continue;
      const o = s.geomStart[i];
      const c = apply(M, { x: s.geom[o], y: s.geom[o + 1] });
      const rMm = s.geom[o + 2];
      const right = { x: c.x + rMm, y: c.y };
      const found = paths.some((pth) =>
        pth.d.some(
          (cmd) => cmd.op === 'M' && Math.abs(cmd.x - right.x) < 1e-6 && Math.abs(cmd.y - right.y) < 1e-6,
        ),
      );
      if (found) checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // Text is drawn with the bundled fonts.
    expect(texts(underlay!.children).length).toBeGreaterThan(5);
    expect(r.calibration[1]).toContain('Uncalibrated');
  });

  it('embeds PDF underlays as vector pages at true scale', async () => {
    const { drawing, input } = await pdfDrawing('tests/fixtures/pdf/plot-plan-a1-1to500.pdf', 1, 500);
    const p = testProject();
    p.drawings.push(drawing);
    p.sheet.scale = 500;
    // Ratio calibration puts the world origin at the page corner: tank T-102 (page 320, 380 mm) is
    // at world (160, 190) m.
    p.sheet.viewCentre = { x: 160, y: 190 };
    const r = buildProjectScene({
      project: p,
      settings: settingsFor(p),
      drawings: { [drawing.id]: input },
      contours: [],
      fonts,
    });
    expect(r.pdfItems).toHaveLength(1);
    expect(r.calibration[1]).toContain('Calibrated (stated ratio 1:500)');
    const pdf = await renderScenePdf(r.scene, { fonts });
    const v = await pdfVectors(pdf);
    // Tank T-102 (r = 15 m) sits at the viewport centre with r = 30 mm at 1:500.
    const cx = (r.layout.viewport.x + r.layout.viewport.w / 2) * PT_PER_MM;
    const cy = v.height - (r.layout.viewport.y + r.layout.viewport.h / 2) * PT_PER_MM;
    const tank = circlesOf(v.result).find((c) => Math.hypot(c.x - cx, c.y - cy) < 0.5);
    expect(tank, 'embedded tank circle').toBeTruthy();
    expect(tank!.r / PT_PER_MM).toBeCloseTo(30, 2);
  });

  it('always states the calibration even without title block or legend calibration (row 32)', () => {
    const p = testProject();
    p.sheet.showTitleBlock = false;
    p.legend.showCalibration = false;
    addObject(p, { type: 'circle', c: { x: 0, y: 0 }, r: 5 });
    for (const region of ['sheet', 'view', 'window'] as const) {
      const r = buildProjectScene({
        project: p,
        settings: settingsFor(p, { region }),
        drawings: {},
        contours: [],
        fonts,
        view: { cx: 0, cy: 0, scale: 10, rotation: 0, width: 800, height: 600 },
      });
      expect(
        texts(r.scene.items).some((t) => t.text.startsWith('Calibration')),
        region,
      ).toBe(true);
    }
  });

  it('labels in world units scale with the print scale; Arabic labels are kept as text', () => {
    const p = testProject();
    p.sheet.scale = 200;
    const o = addObject(
      p,
      { type: 'rect', c: { x: 0, y: 0 }, w: 20, h: 10, rot: 0 },
      { name: 'منطقة الخطر' },
    );
    o.style = { labelSize: 2, labelSizeUnit: 'world' };
    o.label = { template: '{name}', placement: 'centroid', visible: true };
    const r = buildProjectScene({ project: p, settings: settingsFor(p), drawings: {}, contours: [], fonts });
    const label = texts(r.scene.items).find((t) => t.text === 'منطقة الخطر');
    expect(label).toBeTruthy();
    expect(label!.size).toBeCloseTo(10, 9); // 2 m at 1:200 = 10 mm
    expect(label!.halo).toBeTruthy();
  });

  it('is deterministic (same input → identical scene)', () => {
    const p = testProject();
    addObject(p, {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 10, y: 0, bulge: 0.5 },
        { x: 10, y: 10 },
      ],
      closed: true,
    });
    const a = buildProjectScene({ project: p, settings: settingsFor(p), drawings: {}, contours: [], fonts });
    const b = buildProjectScene({ project: p, settings: settingsFor(p), drawings: {}, contours: [], fonts });
    expect(JSON.stringify(a.scene)).toBe(JSON.stringify(b.scene));
  });
});
