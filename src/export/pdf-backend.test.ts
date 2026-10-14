import { PDFDocument, PDFName, PDFOperator, PDFRawStream, PDFString, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

import { multiply } from '@/core/affine';
import type { Affine2D } from '@/core/types';

import { renderScenePdf, renderScenesPdf } from './pdf-backend';
import { MM_PER_PT, PT_PER_MM, SceneBuilder, rectPath } from './scene';
import type { Scene } from './scene';
import { testFontSet } from './test-fonts';
import { makePng } from './test-png';

const OPS = pdfjs.OPS as Record<string, number>;
const OP_NAMES = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));

interface DrawnPath {
  paintOp: string;
  /** Subpaths with device-space (pt) points. */
  points: [number, number][];
  inForm: number;
}

interface Analysis {
  pdf: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  view: number[];
  ops: string[];
  paths: DrawnPath[];
  ocgTags: string[];
  formDepthMax: number;
  gstates: unknown[];
  text: string;
  close: () => Promise<void>;
}

async function analyse(bytes: Uint8Array): Promise<Analysis> {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const list = await page.getOperatorList();
  const ops: string[] = [];
  const paths: DrawnPath[] = [];
  const ocgTags: string[] = [];
  const gstates: unknown[] = [];
  let ctm: Affine2D = [1, 0, 0, 1, 0, 0];
  const stack: Affine2D[] = [];
  let formDepth = 0;
  let formDepthMax = 0;
  const tx = (x: number, y: number): [number, number] => [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5],
  ];
  list.fnArray.forEach((fn, i) => {
    const args = list.argsArray[i] as unknown[];
    const name = OP_NAMES[fn];
    ops.push(name);
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        break;
      case OPS.transform:
        ctm = multiply(ctm, args as Affine2D);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (args[0]) ctm = multiply(ctm, Array.from(args[0] as number[]) as Affine2D);
        formDepth++;
        formDepthMax = Math.max(formDepthMax, formDepth);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        formDepth--;
        break;
      case OPS.beginMarkedContentProps:
        if (args[0] === 'OC') ocgTags.push(String((args[1] as { id?: string })?.id ?? args[1]));
        break;
      case OPS.setGState:
        gstates.push(args[0]);
        break;
      case OPS.constructPath: {
        const paintOp = OP_NAMES[args[0] as number];
        const data = Array.from((args[1] as ArrayLike<number>[])[0] ?? []);
        const pts: [number, number][] = [];
        for (let k = 0; k < data.length;) {
          const op = data[k++];
          if (op === 0 || op === 1) {
            pts.push(tx(data[k], data[k + 1]));
            k += 2;
          } else if (op === 2) {
            pts.push(tx(data[k + 4], data[k + 5]));
            k += 6;
          } else if (op === 3) {
            pts.push(tx(data[k + 2], data[k + 3]));
            k += 4;
          }
        }
        paths.push({ paintOp, points: pts, inForm: formDepth });
        break;
      }
      default:
        break;
    }
  });
  const tc = await page.getTextContent();
  const text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ');
  return {
    pdf,
    view: page.view,
    ops,
    paths,
    ocgTags,
    formDepthMax,
    gstates,
    text,
    close: () => task.destroy(),
  };
}

const fonts = testFontSet();
const black = { color: '#000000', width: 0.35 };

describe('renderScenePdf', () => {
  it('uses the paper size in points and draws a 100 mm line exactly 100 mm long', async () => {
    const scene = new SceneBuilder(420, 297).line(10, 20, 110, 20, black).build();
    const bytes = await renderScenePdf(scene, { fonts });
    const a = await analyse(bytes);
    expect(a.view[2]).toBeCloseTo((420 * 72) / 25.4, 9);
    expect(a.view[3]).toBeCloseTo((297 * 72) / 25.4, 9);
    const line = a.paths.find((p) => p.paintOp === 'stroke' && p.points.length === 2)!;
    expect(line).toBeDefined();
    const [[x1, y1], [x2, y2]] = line.points;
    const lengthMm = Math.hypot(x2 - x1, y2 - y1) * MM_PER_PT;
    expect(lengthMm).toBeCloseTo(100, 9);
    // position on the page: 10 mm from the left, 20 mm from the top
    expect(x1 * MM_PER_PT).toBeCloseTo(10, 9);
    expect((a.view[3] - y1) * MM_PER_PT).toBeCloseTo(20, 9);
    await a.close();
    // pdf-lib can reload the file
    const re = await PDFDocument.load(bytes);
    expect(re.getPageCount()).toBe(1);
    expect(re.getPage(0).getWidth()).toBeCloseTo(420 * PT_PER_MM, 6);
  });

  it('writes optional-content layers listed by getOptionalContentConfig()', async () => {
    const scene = new SceneBuilder(297, 210)
      .layer('Analysis', (b) => b.rect(10, 10, 50, 30, black))
      .layer('Contours', (b) => b.layer('Ring 1', (r) => r.circle(100, 100, 20, black)))
      .layer('منطقة الخطر', (b) => b.line(0, 0, 10, 10, black))
      .layer('Analysis', (b) => b.line(5, 5, 6, 6, black)) // same name → same OCG
      .build();
    const bytes = await renderScenePdf(scene, { fonts });
    const a = await analyse(bytes);
    const cfg = await a.pdf.getOptionalContentConfig();
    const order = cfg.getOrder() as unknown[];
    const ids: string[] = [];
    const nested: string[] = [];
    const flat = (arr: unknown[], depth: number) => {
      for (const v of arr) {
        if (typeof v === 'string') (depth ? nested : ids).push(v);
        else if (Array.isArray(v)) flat(v, depth + 1);
        else if (v && typeof v === 'object' && 'order' in v)
          flat((v as { order: unknown[] }).order, depth + 1);
      }
    };
    flat(order, 0);
    const name = (id: string) => cfg.getGroup(id)?.name;
    expect(ids.map(name)).toEqual(['Analysis', 'Contours', 'منطقة الخطر']);
    expect(nested.map(name)).toEqual(['Ring 1']);
    // The written /Order nests "Ring 1" directly under "Contours".
    const doc = await PDFDocument.load(bytes);
    const ocp = String(doc.catalog.lookup(PDFName.of('OCProperties')));
    expect(ocp).toMatch(/\/Order \[ (\d+) 0 R (\d+) 0 R \[ (\d+) 0 R \] (\d+) 0 R \]/);
    ids.push(...nested);
    for (const id of ids) expect(cfg.getGroup(id)!.visible).toBe(true);
    expect(a.ocgTags.length).toBe(5); // BDC per layer group occurrence
    await a.close();
  });

  it('embeds source PDF pages as vectors with the full affine transform', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([200, 100]);
    page.drawRectangle({ x: 20, y: 20, width: 60, height: 40, borderColor: rgb(1, 0, 0), borderWidth: 1 });
    page.drawLine({ start: { x: 0, y: 0 }, end: { x: 200, y: 0 }, thickness: 2 });
    const srcBytes = await src.save();
    // place the page with its top-left at (10, 10) mm, true size, rotated 0
    const t: Affine2D = [MM_PER_PT, 0, 0, -MM_PER_PT, 10, 10 + 100 * MM_PER_PT];
    const scene = new SceneBuilder(297, 210).pdfPage(srcBytes, 0, t).build();
    const a = await analyse(await renderScenePdf(scene, { fonts }));
    expect(a.ops).toContain('paintFormXObjectBegin');
    expect(a.ops).not.toContain('paintImageXObject');
    const inForm = a.paths.filter((p) => p.inForm > 0);
    expect(inForm.length).toBeGreaterThanOrEqual(2);
    // The source baseline (0,0)→(200,0) pt lands at paper (10, 10+100pt) → (10+200pt, same).
    const base = inForm.find(
      (p) => p.paintOp === 'stroke' && p.points.every(([, y]) => Math.abs(y - p.points[0][1]) < 1e-6),
    )!;
    const xs = base.points.map(([x]) => x * MM_PER_PT);
    expect(Math.min(...xs)).toBeCloseTo(10, 6);
    expect(Math.max(...xs)).toBeCloseTo(10 + 200 * MM_PER_PT, 6);
    expect((a.view[3] - base.points[0][1]) * MM_PER_PT).toBeCloseTo(10 + 100 * MM_PER_PT, 6);
    await a.close();
  });

  it("registers an embedded page's own layers under the enclosing layer and honours hidden ones", async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([200, 100]);
    const ctx = src.context;
    const ocg = (name: string) => ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(name) }));
    const [pipes, text, grid] = [ocg('Pipes'), ocg('Text'), ocg('Grid')];
    src.catalog.set(
      PDFName.of('OCProperties'),
      ctx.obj({
        OCGs: [pipes, text, grid],
        D: { ON: [pipes, text], OFF: [grid], Order: [pipes, text, grid] },
      }),
    );
    page.node.Resources()!.set(PDFName.of('Properties'), ctx.obj({ P1: pipes, P2: text, P3: grid }));
    ['P1', 'P2', 'P3'].forEach((tag, i) => {
      page.pushOperators(PDFOperator.of('BDC' as never, [PDFName.of('OC'), PDFName.of(tag)]));
      page.drawLine({ start: { x: 10, y: 10 + i * 20 }, end: { x: 190, y: 10 + i * 20 }, thickness: 1 });
      page.pushOperators(PDFOperator.of('EMC' as never));
    });
    const srcBytes = await src.save();
    const scene = new SceneBuilder(297, 210)
      .layer('Underlay', (b) =>
        b.add({
          kind: 'pdfPage',
          bytes: srcBytes,
          pageIndex: 0,
          transform: [MM_PER_PT, 0, 0, -MM_PER_PT, 10, 100],
          hiddenLayers: ['Text'],
        }),
      )
      .layer('Analysis', (b) => b.line(0, 0, 10, 10, black))
      .build();
    const a = await analyse(await renderScenePdf(scene, { fonts }));
    const cfg = await a.pdf.getOptionalContentConfig();
    const order = cfg.getOrder() as unknown[];
    const name = (id: string) => cfg.getGroup(id)?.name;
    const top = order.filter((v): v is string => typeof v === 'string').map(name);
    expect(top).toEqual(['Underlay', 'Analysis']);
    const nested = order.find((v) => typeof v === 'object' && v !== null && 'order' in v) as {
      order: string[];
    };
    expect(nested.order.map(name)).toEqual(['Pipes', 'Text', 'Grid']);
    const vis = Object.fromEntries(nested.order.map((id) => [name(id), cfg.getGroup(id)!.visible]));
    expect(vis).toEqual({ Pipes: true, Text: false, Grid: false });
    // the source's marked content survives inside the embedded form
    expect(a.ocgTags.length).toBe(2 + 3);
    await a.close();
  });

  it('applies a rotated/scaled transform to embedded pages', async () => {
    const src = await PDFDocument.create();
    src.addPage([100, 100]).drawLine({ start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, thickness: 1 });
    const srcBytes = await src.save();
    const k = 0.5 * MM_PER_PT; // 1:2 scale
    const th = Math.PI / 6;
    const t: Affine2D = [k * Math.cos(th), -k * Math.sin(th), k * Math.sin(th), k * Math.cos(th), 50, 150];
    const a = await analyse(
      await renderScenePdf(new SceneBuilder(297, 210).pdfPage(srcBytes, 0, t).build(), { fonts }),
    );
    const seg = a.paths.find((p) => p.inForm > 0 && p.paintOp === 'stroke')!;
    const [x1, y1] = seg.points[0];
    const [x2, y2] = seg.points[seg.points.length - 1];
    expect(Math.hypot(x2 - x1, y2 - y1) * MM_PER_PT).toBeCloseTo(100 * k, 6);
    // CCW on paper by 30° → device-space (y-up) angle +30°
    expect(Math.atan2(y2 - y1, x2 - x1)).toBeCloseTo(th, 6);
    await a.close();
  });

  it('draws Arabic text as vector glyph outlines and keeps Latin text searchable', async () => {
    const scene = new SceneBuilder(297, 210)
      .text('منطقة الخطر 15 م', 100, 100, {
        size: 5,
        anchor: 'middle',
        baseline: 'middle',
        halo: { color: '#ffffff', width: 0.6 },
      })
      .text('Tank T-101', 20, 20, { size: 3, bold: true })
      .build();
    const bytes = await renderScenePdf(scene, { fonts });
    const a = await analyse(bytes);
    expect(a.formDepthMax).toBeGreaterThanOrEqual(1);
    const glyphFills = a.paths.filter((p) => p.inForm > 0 && p.paintOp === 'fill');
    const glyphStrokes = a.paths.filter((p) => p.inForm > 0 && p.paintOp === 'stroke');
    expect(glyphFills.length).toBeGreaterThan(15);
    expect(glyphStrokes.length).toBeGreaterThan(5); // halo
    // Arabic glyphs are centred on x = 100 mm
    const arabicXs = glyphFills.flatMap((p) => p.points.map(([x]) => x * MM_PER_PT)).filter((x) => x > 60);
    expect((Math.min(...arabicXs) + Math.max(...arabicXs)) / 2).toBeCloseTo(100, 0);
    expect(a.text).toContain('Tank T-101');
    // invisible layer: nominal glyphs with exact ToUnicode → clean Arabic extraction
    expect(a.text).toContain('منطقة الخطر');
    expect(a.text).toContain('15');
    expect([...a.text].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
    await a.close();
  });

  it('reuses one form XObject per unique glyph', async () => {
    const one = await renderScenePdf(new SceneBuilder(100, 100).text('A', 10, 10, { size: 3 }).build(), {
      fonts,
      searchableText: false,
    });
    const many = await renderScenePdf(
      new SceneBuilder(100, 100)
        .text('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 10, 10, { size: 3 })
        .build(),
      {
        fonts,
        searchableText: false,
      },
    );
    const doc = await PDFDocument.load(many);
    const forms = doc.context
      .enumerateIndirectObjects()
      .filter(
        ([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Form'),
      );
    expect(forms.length).toBe(1);
    expect(many.length - one.length).toBeLessThan(1500);
  });

  it('renders fills, even-odd, dashes, opacity and hatches', async () => {
    const ring = [...rectPath(10, 10, 80, 80), ...rectPath(30, 30, 40, 40)];
    const scene = new SceneBuilder(210, 297)
      .path(
        ring,
        { color: '#0000ff', width: 0.5, dash: [2, 1], opacity: 0.8 },
        { color: '#ff0000', opacity: 0.25, rule: 'evenodd' },
      )
      .path(rectPath(100, 10, 50, 50), undefined, {
        color: '#00aa00',
        opacity: 0,
        hatch: { pattern: 'diagonal-cross', spacing: 3, lineWidth: 0.2 },
      })
      .path(rectPath(100, 100, 30, 30), black, {
        color: '#333333',
        opacity: 0.1,
        hatch: { pattern: 'dots', spacing: 5, lineWidth: 0.3, color: '#000000' },
      })
      .build();
    const a = await analyse(await renderScenePdf(scene, { fonts }));
    expect(a.paths.some((p) => p.paintOp === 'eoFillStroke')).toBe(true);
    expect(a.ops).toContain('setDash');
    expect(JSON.stringify(a.gstates)).toContain('ca');
    // hatch: clip then many line segments
    const hatchLines = a.paths.filter((p) => p.paintOp === 'stroke' && p.points.length > 20);
    expect(hatchLines.length).toBeGreaterThanOrEqual(1);
    for (const [x, y] of hatchLines[0].points) {
      // hatch lines are generated for the bbox of the 50×50 square (clipped by the PDF clip)
      expect(x * MM_PER_PT).toBeGreaterThanOrEqual(100 - 1e-6);
      expect(x * MM_PER_PT).toBeLessThanOrEqual(150 + 1e-6);
      expect((a.view[3] - y) * MM_PER_PT).toBeGreaterThanOrEqual(10 - 1e-6);
    }
    expect(a.paths.some((p) => p.paintOp === 'fill' && p.points.length > 30)).toBe(true); // dots
    await a.close();
  });

  it('embeds PNG images, group opacity and clip paths', async () => {
    const png = makePng(4, 2, (x) => [x * 60, 0, 255 - x * 60, 255]);
    const scene = new SceneBuilder(100, 100, { background: '#fafafa' })
      .image(10, 10, 40, 20, png, { rotation: Math.PI / 2, opacity: 0.5 })
      .group('faded', { opacity: 0.5, clip: rectPath(0, 0, 50, 50) }, (b) => {
        b.circle(25, 25, 10, black, { color: '#ff0000' });
        b.circle(30, 25, 10, black, { color: '#00ff00' });
      })
      .build();
    const a = await analyse(await renderScenePdf(scene, { fonts }));
    expect(a.ops).toContain('paintImageXObject');
    expect(a.ops).toContain('beginGroup');
    expect(a.paths.some((p) => p.paintOp === 'endPath')).toBe(true); // clip path
    await a.close();
  });

  it('falls back to the PNG when a source PDF cannot be embedded', async () => {
    const warnings: string[] = [];
    const png = makePng(2, 2, () => [0, 0, 0, 255]);
    const scene = new SceneBuilder(100, 100)
      .pdfPage(new Uint8Array([1, 2, 3]), 0, [1, 0, 0, 1, 0, 0], {
        fallbackPng: { png, x: 0, y: 0, w: 50, h: 50 },
      })
      .build();
    const a = await analyse(await renderScenePdf(scene, { fonts, onWarning: (m) => warnings.push(m) }));
    expect(a.ops).toContain('paintImageXObject');
    expect(warnings.length).toBe(1);
    await a.close();
  });

  it('is deterministic and supports multi-page output with metadata', async () => {
    const scene: Scene = new SceneBuilder(210, 297, { meta: { title: 'Plot 1', author: 'QA' } })
      .layer('A', (b) => b.text('Label', 10, 10, { size: 3 }))
      .build();
    const a = await renderScenePdf(scene, { fonts });
    const b = await renderScenePdf(scene, { fonts });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const multi = await renderScenesPdf([scene, scene], {
      fonts,
      creationDate: new Date('2026-01-01T00:00:00Z'),
    });
    const doc = await PDFDocument.load(multi);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getTitle()).toBe('Plot 1');
    expect(doc.getAuthor()).toBe('QA');
    expect(doc.getCreationDate()?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
