import { unzipSync, strFromU8 } from 'fflate';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { createProject, expect, openApp, test } from './fixtures';
import {
  addObjects,
  chooseFormat,
  DXF_FIXTURE,
  forceDownloads,
  importDrawing,
  openExport,
  PDF_FIXTURE,
  pngInfo,
  project,
  runExport,
  waitPreview,
} from './export-helpers';

/**
 * Export (rows 36, 48 export side, 76–81): every format from a project with an imported drawing and
 * analysis objects, true-scale PDF measured with pdf.js, PNG size/DPI, SVG layer groups, DXF in
 * drawing coordinates, CSV/XLSX with calibration header, WYSIWYG preview, profiles, Arabic labels.
 */

const PT_PER_MM = 72 / 25.4;
const ARABIC = 'منطقة الخطر';

interface PdfPath {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Text and painted path bounding boxes (pt, y up) of page 1, following form XObjects. */
async function analysePdf(
  bytes: Buffer,
): Promise<{ text: string; paths: PdfPath[]; width: number; height: number; ocgs: string[] }> {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
  } as never).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const text = tc.items.map((i) => ('str' in i ? i.str : '')).join(' ');
  const occ = await doc.getOptionalContentConfig();
  const ocgs: string[] = [];
  for (const [, g] of occ) ocgs.push((g as { name: string }).name);
  const ops = pdfjs.OPS as Record<string, number>;
  const list = await page.getOperatorList();
  type M = [number, number, number, number, number, number];
  const mul = (a: M, b: M): M => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const paths: PdfPath[] = [];
  list.fnArray.forEach((fn, i) => {
    const args = list.argsArray[i] as unknown[];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === ops.transform) ctm = mul(ctm, args as M);
    else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args[0]) ctm = mul(ctm, Array.from(args[0] as number[]) as M);
    } else if (fn === ops.paintFormXObjectEnd) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === ops.constructPath) {
      // pdf.js 5+: [paintOp, [pathData], minMax]; path data: 0 moveTo, 1 lineTo, 2 curveTo, 3 quad, 4 close.
      const data = Array.from((args[1] as ArrayLike<number>[])[0] ?? []);
      const pts: number[][] = [];
      for (let k = 0; k < data.length;) {
        const op = data[k++];
        if (op === 0 || op === 1) {
          pts.push([data[k], data[k + 1]]);
          k += 2;
        } else if (op === 2) {
          pts.push([data[k + 4], data[k + 5]]);
          k += 6;
        } else if (op === 3) {
          pts.push([data[k + 2], data[k + 3]]);
          k += 4;
        }
      }
      if (!pts.length) return;
      const t = pts.map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      paths.push({
        minX: Math.min(...t.map((p) => p[0])),
        minY: Math.min(...t.map((p) => p[1])),
        maxX: Math.max(...t.map((p) => p[0])),
        maxY: Math.max(...t.map((p) => p[1])),
      });
    }
  });
  await doc.loadingTask.destroy();
  return { text, paths, width: vp.width, height: vp.height, ocgs };
}

test.beforeEach(async ({ page }) => {
  await forceDownloads(page);
  await openApp(page);
  await createProject(page, 'Export E2E');
});

test('exports PDF, PNG, SVG, DXF, CSV and XLSX from a DXF project (rows 77–80, 48)', async ({ page }) => {
  test.setTimeout(180_000);
  await importDrawing(page, DXF_FIXTURE);
  await addObjects(page, [
    {
      name: 'Tank exclusion',
      geometry: { type: 'circle', c: { x: 600100, y: 2500100 }, r: 25 },
      attributes: { Owner: 'Ops', Capacity: 5000 },
      label: { template: '{name}', placement: 'centroid', visible: true },
    },
    {
      name: ARABIC,
      geometry: { type: 'rect', c: { x: 600160, y: 2500070 }, w: 40, h: 25, rot: 0.2 },
      style: { fill: '#2563eb', stroke: '#2563eb', hatch: 'diagonal', fillOpacity: 0.3 },
      label: { template: '{name}', placement: 'centroid', visible: true },
    },
  ]);
  await openExport(page);
  // Fixed print scale and centre so positions are known.
  await page.getByLabel('Scale denominator').fill('500');
  await page.getByLabel('Scale denominator').press('Enter');
  await expect(page.getByTestId('export-scale')).toHaveText('1:500');
  await waitPreview(page);

  // PDF: vector, true scale, optional-content layers, calibration statement, Arabic text.
  const pdf = await runExport(page);
  expect(pdf.name).toMatch(/\.pdf$/);
  expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const a = await analysePdf(pdf.bytes);
  expect(a.width).toBeCloseTo(841 * PT_PER_MM, 2);
  expect(a.ocgs).toEqual(expect.arrayContaining(['Analysis', 'Legend', 'Title block', 'r2018_plotplan']));
  expect(a.text).toContain('Calibration: Uncalibrated');
  expect(a.text).toContain('Tank exclusion');
  expect(a.text.includes(ARABIC) || a.text.includes([...ARABIC].reverse().join(''))).toBe(true);
  // The 25 m radius tank is 100 mm wide at 1:500 (measured in the PDF).
  const tank = a.paths.find(
    (p) =>
      Math.abs(p.maxX - p.minX - 100 * PT_PER_MM) < 0.05 &&
      Math.abs(p.maxY - p.minY - 100 * PT_PER_MM) < 0.05,
  );
  expect(tank, 'tank circle 100 mm across').toBeTruthy();

  // PNG at 50 dpi: A1 (841 × 594 mm) → 1656 × 1169 px, DPI recorded.
  await chooseFormat(page, 'png');
  await page.getByTestId('export-dpi').fill('50');
  await expect(page.getByTestId('export-png-size')).toHaveText('1656 × 1169 px');
  const png = await runExport(page);
  const info = pngInfo(png.bytes);
  expect(info).toMatchObject({ width: 1656, height: 1169 });
  expect(info.dpi).toBeCloseTo(50, 0);

  // SVG: analysis layers as Inkscape layer groups; Arabic label as text.
  await chooseFormat(page, 'svg');
  await waitPreview(page);
  const svg = (await runExport(page)).bytes.toString('utf8');
  expect(svg).toContain('<svg');
  expect(svg).toMatch(
    /inkscape:groupmode="layer"[^>]*inkscape:label="Analysis"|inkscape:label="Analysis"[^>]*inkscape:groupmode="layer"/,
  );
  expect(svg).toContain(ARABIC);
  expect(svg).toContain('Calibration: Uncalibrated');
  expect(svg).not.toMatch(/(?:href|src)="https?:/);

  // DXF in the drawing's coordinates (plant metres): the tank circle at its exact position.
  await chooseFormat(page, 'dxf');
  const dxf = (await runExport(page)).bytes.toString('utf8');
  expect(dxf).toContain('AC1024');
  expect(dxf).toMatch(/\r\nCIRCLE\r\n[\s\S]*?\r\n 10\r\n600100\.0\r\n 20\r\n2500100\.0\r\n/);
  expect(dxf).toContain('Analysis-LABELS');
  expect(dxf).toContain(ARABIC); // UTF-8 MTEXT (plus glyph outlines)
  expect(dxf).toContain('Uncalibrated');

  // CSV: calibration header lines, attribute columns, totals.
  await chooseFormat(page, 'csv');
  const csv = (await runExport(page)).bytes.toString('utf8');
  expect(csv).toContain('# Calibration: Uncalibrated');
  expect(csv).toMatch(/Owner/);
  expect(csv).toMatch(/\r\nTotal,/);
  expect(csv).toContain(ARABIC);

  // XLSX: header sheet with calibration, objects, totals.
  await chooseFormat(page, 'xlsx');
  const xlsx = unzipSync(new Uint8Array((await runExport(page)).bytes));
  const wb = strFromU8(xlsx['xl/workbook.xml']);
  expect(wb).toContain('Export info');
  expect(wb).toContain('Objects');
  const sheet1 = strFromU8(xlsx['xl/worksheets/sheet1.xml']);
  expect(sheet1).toContain('Calibration');
  const sheet2 = strFromU8(xlsx['xl/worksheets/sheet2.xml']);
  expect(sheet2).toContain('Total');
  expect(sheet2).toContain('Capacity');
});

test('PDF underlay at true scale: the exported PDF measures world distances (rows 77, 36)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await importDrawing(page, PDF_FIXTURE);
  // Stated scale 1:500 (the calibration UI is another feature; set the same data it writes).
  await page.evaluate(() => {
    const w = window as unknown as {
      __pat: {
        store(): { commit(l: string, fn: (d: { drawings: Record<string, unknown>[] }) => void): boolean };
      };
    };
    const k = (0.0254 / 72) * 500;
    w.__pat.store().commit('Calibrate 1:500', (d) => {
      d.drawings[0].calibration = {
        method: 'ratio',
        ratio: 500,
        transform: [k, 0, 0, k, 0, 0],
        references: [],
        at: '2026-10-14T00:00:00.000Z',
      };
    });
  });
  // A 10 m radius circle at the tank T-102 position (page 320, 380 mm → world 160, 190 m).
  await addObjects(page, [
    { name: 'Check circle', geometry: { type: 'circle', c: { x: 160, y: 190 }, r: 10 } },
  ]);
  await openExport(page);
  await page.getByLabel('Scale denominator').fill('500');
  await page.getByLabel('Scale denominator').press('Enter');
  await waitPreview(page);
  const { bytes } = await runExport(page);
  const a = await analysePdf(bytes);
  expect(a.text).toContain('Calibrated (stated ratio 1:500)');
  // Analysis circle: 20 m across → 40 mm; source tank (r = 15 m, embedded page) → 60 mm.
  const near = (p: PdfPath, mm: number) =>
    Math.abs(p.maxX - p.minX - mm * PT_PER_MM) < 0.2 && Math.abs(p.maxY - p.minY - mm * PT_PER_MM) < 0.2;
  const centre = (p: PdfPath) => [(p.minX + p.maxX) / 2, (p.minY + p.maxY) / 2];
  const circle = a.paths.find((p) => near(p, 40));
  expect(circle, 'analysis circle 40 mm').toBeTruthy();
  const [cx, cy] = centre(circle!);
  // The embedded source tank T-102 (r = 15 m) is concentric with it on paper.
  const tank = a.paths
    .filter((p) => near(p, 60))
    .sort(
      (p, q) =>
        Math.hypot(centre(p)[0] - cx, centre(p)[1] - cy) - Math.hypot(centre(q)[0] - cx, centre(q)[1] - cy),
    )[0];
  expect(tank, 'embedded source tank 60 mm').toBeTruthy();
  expect(Math.hypot(centre(tank)[0] - cx, centre(tank)[1] - cy)).toBeLessThan(0.5);
  // Scale bar: 50 m at 1:500 = 100 mm (row 36).
  const bar = a.paths.find(
    (p) =>
      Math.abs(p.maxX - p.minX - 100 * PT_PER_MM) < 0.05 &&
      Math.abs(p.maxY - p.minY - 1.6 * PT_PER_MM) < 0.05,
  );
  expect(bar, 'scale bar 100 mm').toBeTruthy();

  // Raster outputs draw the PDF page with pdf.js: PNG shows the page content (not an opaque block)
  // and SVG embeds a raster stand-in of the page.
  await chooseFormat(page, 'png');
  await page.getByTestId('export-dpi').fill('40');
  const png = await runExport(page);
  const stats = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let black = 0;
    let blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40) black++;
      if (d[i + 2] > 120 && d[i] < 90 && d[i + 1] < 90) blue++; // the source page's tank outlines
    }
    const n = d.length / 4;
    return { black: black / n, blue };
  }, png.bytes.toString('base64'));
  expect(stats.black).toBeLessThan(0.05);
  expect(stats.blue).toBeGreaterThan(50);
  await chooseFormat(page, 'svg');
  await waitPreview(page);
  const svg = (await runExport(page)).bytes.toString('utf8');
  expect(svg).toMatch(/<image[^>]+data:image\/png;base64,/);
});

test('layout preview matches the PNG export exactly (row 76)', async ({ page }) => {
  test.setTimeout(120_000);
  await importDrawing(page, DXF_FIXTURE);
  await addObjects(page, [
    {
      name: 'Zone',
      geometry: { type: 'circle', c: { x: 600150, y: 2500100 }, r: 30 },
      label: { template: '{name}', placement: 'centroid', visible: true },
    },
  ]);
  await openExport(page);
  await chooseFormat(page, 'png');
  await waitPreview(page);
  const dpi = Number(await page.getByTestId('export-preview').getAttribute('data-dpi'));
  expect(dpi).toBeGreaterThan(10);
  await page.getByTestId('export-dpi').fill(String(dpi));
  await waitPreview(page);
  const { bytes } = await runExport(page);
  const diff = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
    const preview = document.querySelector('[data-testid="export-preview"]') as HTMLCanvasElement;
    if (bmp.width !== preview.width || bmp.height !== preview.height)
      return { size: [bmp.width, bmp.height, preview.width, preview.height], mean: 1 };
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const a = ctx.getImageData(0, 0, c.width, c.height).data;
    const b = preview.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let differing = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      sum += d;
      if (d > 30) differing++;
    }
    return {
      size: [bmp.width, bmp.height],
      mean: sum / (a.length / 4) / 765,
      differing: differing / (a.length / 4),
    };
  }, bytes.toString('base64'));
  expect(diff.mean).toBeLessThan(0.002);
  expect(diff.differing ?? 1).toBeLessThan(0.002);
});

test('a saved profile re-runs to identical output; the sheet layout in the project is untouched (row 81)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await importDrawing(page, DXF_FIXTURE);
  await addObjects(page, [{ name: 'A', geometry: { type: 'circle', c: { x: 600100, y: 2500100 }, r: 20 } }]);
  await openExport(page);
  await page.getByLabel('Title block Title').fill('Client issue');
  await page.getByLabel('Title block Title').press('Enter');
  await page.getByLabel('Scale denominator').fill('1000');
  await page.getByLabel('Scale denominator').press('Enter');
  await waitPreview(page);
  const first = await runExport(page);
  await page.getByTestId('export-save-profile').click();
  await page.getByLabel('Profile name').fill('A1 client issue');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect
    .poll(async () =>
      (await project<{ exportProfiles: { name: string }[] }>(page)).exportProfiles.map((p) => p.name),
    )
    .toEqual(['A1 client issue']);
  // Change the project's sheet afterwards.
  await page.getByLabel('Scale denominator').fill('2500');
  await page.getByLabel('Scale denominator').press('Enter');
  await page.getByTestId('export-close').click();
  // Re-run the profile from the command palette.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Export profile: A1 client issue');
  const dl = page.waitForEvent('download', { timeout: 120_000 });
  await page.keyboard.press('Enter');
  const again = await dl;
  const bytes = (await import('node:fs')).readFileSync((await again.path())!);
  expect(Buffer.compare(bytes, first.bytes)).toBe(0);
  const p = await project<{ sheet: { scale: number } }>(page);
  expect(p.sheet.scale).toBe(2500);
});

test('300 dpi A1 PNG export succeeds within memory limits (row 78)', async ({ page }) => {
  test.setTimeout(300_000);
  await importDrawing(page, DXF_FIXTURE);
  await addObjects(page, [
    {
      name: 'Zone',
      geometry: { type: 'circle', c: { x: 600150, y: 2500100 }, r: 30 },
      style: { hatch: 'cross', fillOpacity: 0.3 },
      label: { template: '{name} {area}', placement: 'centroid', visible: true },
    },
  ]);
  await openExport(page);
  await chooseFormat(page, 'png');
  await page.getByTestId('export-dpi').fill('300');
  await expect(page.getByTestId('export-png-size')).toHaveText('9933 × 7016 px');
  const heapBefore = await page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
  );
  const t0 = Date.now();
  const { bytes } = await runExport(page, 240_000);
  const ms = Date.now() - t0;
  const heapAfter = await page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
  );
  const info = pngInfo(bytes);
  expect(info).toMatchObject({ width: 9933, height: 7016 });
  expect(info.dpi).toBeCloseTo(300, 0);
  test.info().annotations.push({
    type: 'perf',
    description: `300 dpi A1 PNG: ${ms} ms, ${(bytes.length / 1e6).toFixed(1)} MB, main heap ${(heapBefore / 1e6).toFixed(0)} → ${(heapAfter / 1e6).toFixed(0)} MB`,
  });
  // The main thread never holds the full image (it is rendered and encoded in strips in a worker).
  expect(heapAfter - heapBefore).toBeLessThan(150e6);
});

test('cancelling a running export stops it without a download', async ({ page }) => {
  test.setTimeout(120_000);
  await importDrawing(page, DXF_FIXTURE);
  await openExport(page);
  await chooseFormat(page, 'png');
  await page.getByTestId('export-dpi').fill('600');
  let downloaded = false;
  page.on('download', () => (downloaded = true));
  await page.getByTestId('export-run').click();
  await expect(page.getByTestId('export-progress')).toBeVisible();
  await page.getByTestId('export-cancel').click();
  await expect(page.getByText('Export cancelled.')).toBeVisible();
  await expect(page.getByTestId('export-run')).toBeEnabled();
  await page.waitForTimeout(500);
  expect(downloaded).toBe(false);
});
