import { readFileSync } from 'node:fs';

import {
  AREA_LOCAL,
  AREA_PLANT_MM,
  FIXTURES,
  PDF_A1,
  PLOT_PLAN,
  around,
  clickWorld,
  hoverWorld,
  importDrawing,
  menu,
  openCalibration,
  paperOf,
  placeOf,
  project,
  siteOf,
  zoomTo,
  type Pt,
} from './drawing-helpers';
import { createProject, expect, openApp, test } from './fixtures';

/** Rows 26, 28–34: calibration methods, plant coordinates, guard, verification, recalibration, alignment. */

const pdfExp = JSON.parse(readFileSync(`${FIXTURES}pdf/expectations.json`, 'utf8'))[
  'plot-plan-a1-1to500.pdf'
];
const subExp = JSON.parse(readFileSync(`${FIXTURES}dxf/subdrawings.json`, 'utf8')) as {
  gridIntersections: { plant: [number, number]; local: [number, number] }[];
  tanks: { plant: [number, number]; local: [number, number]; r: number }[];
  bundEnds: { plant: [number, number]; local: [number, number] }[];
};
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const PDF_NAME = 'plot-plan-a1-1to500 p1';

test.use({ viewport: { width: 1600, height: 1000 } });

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Calibration');
});

test('two-point scale: re-measuring the calibrated dimension returns the entered value (row 28)', async ({
  page,
}) => {
  await importDrawing(page, PDF_A1, [1]);
  await expect(page.getByTestId('calibration-badge')).toHaveAttribute('data-state', 'uncalibrated');
  await openCalibration(page, PDF_NAME);
  const ref = pdfExp.page1.referenceDimension;
  const [a, b] = [paperOf(ref.from[0], ref.from[1]), paperOf(ref.to[0], ref.to[1])];
  await zoomTo(page, { minX: a.x - 0.02, minY: a.y - 0.03, maxX: b.x + 0.02, maxY: b.y + 0.03 });
  await page.getByTestId('cal-pick').click();
  await clickWorld(page, a);
  // The unfinished calibration is kept as a draft within 1 s (C7, row 93).
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const w = window as unknown as {
          __pat: { db(): { drafts: { toArray(): Promise<{ key: string; state: unknown }[]> } } };
        };
        const rows = await w.__pat.db().drafts.toArray();
        const s = rows.find((r) => r.key === 'calibration:session')?.state as
          { session?: { twoPoint?: { a: unknown } } } | undefined;
        return !!s?.session?.twoPoint?.a;
      }),
    )
    .toBe(true);
  await clickWorld(page, b);
  await expect(page.getByTestId('cal-picked')).toContainText('200.00 mm on paper');
  await page.getByTestId('cal-real-length').fill(String(ref.metres));
  await expect(page.getByTestId('cal-preview')).toContainText('1:500');
  await page.getByTestId('cal-apply').click();
  await expect(page.getByTestId('calibration-panel')).toBeHidden();
  await expect(page.getByTestId('calibration-badge')).toHaveAttribute('data-state', 'calibrated');
  const d = (await project(page)).drawings[0];
  expect(d.calibration?.method).toBe('two-point');

  // Re-measure the same dimension with the distance tool (snapped to the same endpoints).
  const k = d.calibration!.transform[0] / (0.0254 / 72);
  const w = (p: Pt) => ({ x: p.x * k, y: p.y * k });
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('d');
  await zoomTo(page, { minX: w(a).x - 10, minY: w(a).y - 15, maxX: w(b).x + 10, maxY: w(b).y + 15 });
  await clickWorld(page, w(a));
  await clickWorld(page, w(b));
  const value = page.getByTestId('measure-value');
  await expect(value).toHaveAttribute('data-mode', 'distance');
  expect(Number(await value.getAttribute('data-distance'))).toBeCloseTo(100, 9);
  await expect(value).toHaveText('100.00 m');
});

test('stated ratio 1:500 on the A1 PDF measures correctly without picking points (row 30)', async ({
  page,
}) => {
  await importDrawing(page, PDF_A1, [1]);
  await openCalibration(page, PDF_NAME);
  await page.getByTestId('cal-tab-ratio').click();
  await expect(page.getByTestId('cal-page-size')).toHaveText('841.0 × 594.0 mm (A1)');
  await page.getByTestId('cal-ratio').fill('500');
  await expect(page.getByTestId('cal-preview')).toContainText('sheet covers 420.50 m × 297.00 m');
  await page.getByTestId('cal-apply').click();
  await expect(page.getByTestId('calibration-badge')).toHaveAttribute('data-state', 'calibrated');
  const d = (await project(page)).drawings[0];
  expect(d.calibration).toMatchObject({ method: 'ratio', ratio: 500 });
  expect(d.calibration!.transform[0]).toBeCloseTo((0.0254 / 72) * 500, 15);

  // Tank radii (row 35 radius tool) and the 300 m site boundary.
  await menu(page, 'Draw', 'Measure radius / diameter');
  const value = page.getByTestId('measure-value');
  for (const t of pdfExp.page1.tanks as { x: number; y: number; r: number }[]) {
    const c = siteOf(t.x, t.y);
    await zoomTo(page, around(c, t.r * 1.6));
    await clickWorld(page, { x: c.x + t.r, y: c.y });
    await expect(value).toHaveAttribute('data-mode', 'radius');
    expect(Math.abs(Number(await value.getAttribute('data-radius')) - t.r)).toBeLessThan(0.001);
  }
  await page.keyboard.press('Escape');
  await menu(page, 'Draw', 'Measure distance');
  await zoomTo(page, { ...around(siteOf(150, 0), 170) });
  await clickWorld(page, siteOf(0, 0));
  await clickWorld(page, siteOf(300, 0));
  expect(Math.abs(Number(await value.getAttribute('data-distance')) - 300)).toBeLessThan(0.001);
});

test('multi-reference fit reports RMS and per-reference residuals and highlights the worst (row 29)', async ({
  page,
}) => {
  await importDrawing(page, PDF_A1, [1]);
  await openCalibration(page, PDF_NAME);
  await page.getByTestId('cal-tab-references').click();
  const refs: [Pt, Pt, string][] = [
    [paperOf(0, 0), paperOf(300, 0), '300'],
    [paperOf(0, 0), paperOf(0, 200), '200'],
    [paperOf(100, 5), paperOf(200, 5), '100'],
    [paperOf(300, 0), paperOf(300, 200), '205'], // deliberately wrong: really 200 m
  ];
  await zoomTo(page, { minX: 0.08, minY: 0.08, maxX: 0.72, maxY: 0.52 });
  for (const [i, [a, b, v]] of refs.entries()) {
    await page.getByTestId('cal-add-ref').click();
    await clickWorld(page, a);
    await clickWorld(page, b);
    await page.getByTestId(`cal-ref-value-${i}`).fill(v);
  }
  await expect(page.getByTestId('cal-fit')).toBeVisible();
  await expect(page.getByTestId('cal-ref-row-3')).toHaveAttribute('data-worst', 'true');
  for (const i of [0, 1, 2])
    await expect(page.getByTestId(`cal-ref-row-${i}`)).toHaveAttribute('data-worst', 'false');
  for (const i of [0, 1, 2, 3]) await expect(page.getByTestId(`cal-ref-residual-${i}`)).toContainText(' m');
  const rms = Number(await page.getByTestId('cal-rms').getAttribute('data-rms'));
  expect(rms).toBeGreaterThan(1);
  await page.getByTestId('cal-apply').click();
  await expect(page.getByTestId('calibration-panel')).toBeHidden();
  const c = (await project(page)).drawings[0].calibration!;
  expect(c.method).toBe('multi-point');
  expect(c.residualRms).toBeCloseTo(rms, 9);
  expect(c.references.filter((r) => r.residual !== undefined)).toHaveLength(8);
});

test('plant coordinates: picking a grid intersection shows its labelled E/N (row 31)', async ({ page }) => {
  await importDrawing(page, AREA_LOCAL);
  await openCalibration(page, 'area_layout_local_mm');
  await page.getByTestId('cal-tab-coordinates').click();
  const g = subExp.gridIntersections;
  const local = (i: number) => ({ x: g[i].local[0] / 1000, y: g[i].local[1] / 1000 });
  for (const [k, i] of [0, 11].entries()) {
    await zoomTo(page, around(local(i), 8));
    await page.getByTestId('cal-add-coord').click();
    await clickWorld(page, local(i));
    await page.getByTestId(`cal-coords-x-${k}`).fill(String(g[i].plant[0]));
    await page.getByTestId(`cal-coords-y-${k}`).fill(String(g[i].plant[1]));
  }
  await page.getByTestId('cal-apply').click();
  await expect(page.getByTestId('calibration-panel')).toBeHidden();
  const d = (await project(page)).drawings[0];
  expect(d.calibration?.method).toBe('coordinates');

  // Every other grid intersection reads its labelled coordinate (NFR-7: within 1 mm).
  await menu(page, 'Draw', 'Point coordinates');
  const value = page.getByTestId('measure-value');
  for (const i of [1, 5, 6, 10]) {
    const p = { x: g[i].plant[0], y: g[i].plant[1] };
    await zoomTo(page, around(p, 8));
    await hoverWorld(page, p);
    await expect(page.getByTestId('cursor-coords')).toContainText(`E ${fmt(p.x)} N ${fmt(p.y)} m`);
    await clickWorld(page, p);
    expect(Math.abs(Number(await value.getAttribute('data-x')) - p.x)).toBeLessThan(0.001);
    expect(Math.abs(Number(await value.getAttribute('data-y')) - p.y)).toBeLessThan(0.001);
  }

  // Plant north vs true north (row 31/36): the north arrow follows the setting.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('north-arrow')).toHaveAttribute('data-north', 'plant');
  await menu(page, 'File', /Project settings/);
  await page.getByLabel('True north bearing from plant north').fill('12');
  await page.getByLabel('True north bearing from plant north').press('Enter');
  await page.getByRole('radio', { name: 'True north' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  const north = (await project(page)).north;
  expect(north.arrow).toBe('true');
  expect(north.trueNorthAngle).toBeCloseTo((-12 * Math.PI) / 180, 12);
  expect(Number(await page.getByTestId('north-arrow').getAttribute('data-angle'))).toBeCloseTo(-12, 9);
});

/** "600 250.000": display precision 2 + 1, thousands grouped with narrow no-break spaces. */
function fmt(v: number): string {
  const [i, f] = v.toFixed(3).split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')}.${f}`;
}

test('plant coordinates on the plot plan grid (r2018_plotplan.dxf)', async ({ page }) => {
  await importDrawing(page, PLOT_PLAN);
  await openCalibration(page, 'r2018_plotplan');
  await page.getByTestId('cal-tab-coordinates').click();
  const pts: [Pt, string, string][] = [
    [{ x: 600000, y: 2500000 }, '600000', '2500000'],
    [{ x: 600300, y: 2500200 }, '600300', '2500200'],
  ];
  for (const [k, [p, e, n]] of pts.entries()) {
    await zoomTo(page, around(p, 10));
    await page.getByTestId('cal-add-coord').click();
    await clickWorld(page, p);
    await page.getByTestId(`cal-coords-x-${k}`).fill(e);
    await page.getByTestId(`cal-coords-y-${k}`).fill(n);
  }
  await page.getByTestId('cal-apply').click();
  await expect(page.getByTestId('calibration-panel')).toBeHidden();
  // Grid intersection labelled "E 600050" / "N 2500100".
  await menu(page, 'Draw', 'Point coordinates');
  const p = { x: 600050, y: 2500100 };
  await zoomTo(page, around(p, 10));
  await clickWorld(page, p);
  const value = page.getByTestId('measure-value');
  expect(Math.abs(Number(await value.getAttribute('data-x')) - p.x)).toBeLessThan(0.001);
  expect(Math.abs(Number(await value.getAttribute('data-y')) - p.y)).toBeLessThan(0.001);
  await expect(value).toContainText('E 600\u202F050.000 m');
});

test('calibration guard, file units confirmation and Check distance → Verified (rows 30, 32)', async ({
  page,
}) => {
  await importDrawing(page, PDF_A1, [1]);
  // Measuring on an uncalibrated drawing warns first.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('d');
  const guard = page.getByTestId('calibration-guard');
  await expect(guard).toBeVisible();
  await expect(guard).toContainText(PDF_NAME);
  await page.getByTestId('guard-continue').click();
  await expect(page.getByTestId('measure-hud')).toBeVisible();
  await expect(page.getByTestId('measure-uncalibrated')).toBeVisible();
  await page.keyboard.press('Escape');

  // Calibrate at 1:500, then verify against the 300 m site width.
  await openCalibration(page, PDF_NAME);
  await page.getByTestId('cal-tab-ratio').click();
  await page.getByTestId('cal-ratio').fill('500');
  await page.getByTestId('cal-apply').click();
  await menu(page, 'View', /Check distance/);
  await expect(page.getByTestId('check-panel')).toBeVisible();
  await zoomTo(page, around(siteOf(150, 0), 170));
  await clickWorld(page, siteOf(0, 0));
  await clickWorld(page, siteOf(300, 0));
  await expect(page.getByTestId('check-measured')).toContainText('300.000 m');
  // A wrong known value fails and leaves the drawing Calibrated.
  await page.getByTestId('check-known').fill('290');
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('check-result')).toHaveAttribute('data-pass', 'false');
  await expect(page.getByTestId('calibration-badge')).toHaveAttribute('data-state', 'calibrated');
  await page.getByTestId('check-known').fill('300');
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('check-result')).toHaveAttribute('data-pass', 'true');
  await expect(page.getByTestId('calibration-badge')).toHaveAttribute('data-state', 'verified');
  const v = (await project(page)).drawings[0].verified!;
  expect(v.expected).toBe(300);
  expect(Math.abs(v.measured - 300)).toBeLessThan(0.001);

  // A CAD drawing's header units are confirmed from the guard in one click.
  await importDrawing(page, PLOT_PLAN);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Escape');
  await menu(page, 'Draw', 'Measure distance');
  await expect(guard).toContainText('Metres (m) ($INSUNITS 6)');
  await page.getByTestId('guard-confirm-units').click();
  await expect(page.getByTestId('measure-hud')).toBeVisible();
  const plot = (await project(page)).drawings.find((d) => d.name === 'r2018_plotplan')!;
  expect(plot.calibration).toMatchObject({ method: 'cad-units', transform: [1, 0, 0, 1, 0, 0] });
});

test('recalibration: objects move with the drawing or keep their world position, one undo step (row 33)', async ({
  page,
}) => {
  await importDrawing(page, PDF_A1, [1]);
  await openCalibration(page, PDF_NAME);
  await page.getByTestId('cal-tab-ratio').click();
  await page.getByTestId('cal-ratio').fill('1000'); // wrong scale
  await page.getByTestId('cal-apply').click();
  await expect(page.getByTestId('calibration-badge')).toHaveAttribute('data-state', 'calibrated');
  // Circle drawn on tank T-101 at the wrong scale: centre and radius typed in world metres.
  const t = pdfExp.page1.tanks[0];
  const c1000 = { x: (100 + 2 * t.x) * 1, y: (100 + 2 * t.y) * 1 };
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('c');
  for (const s of [`${c1000.x},${c1000.y}`, String(2 * t.r)]) {
    for (const ch of s) await page.keyboard.press(ch);
    await page.keyboard.press('Enter');
  }
  await expect.poll(async () => (await project(page)).objects.length).toBe(1);

  const recalibrate = async (choice: 'recal-move' | 'recal-keep') => {
    await openCalibration(page, PDF_NAME);
    await page.getByTestId('cal-tab-ratio').click();
    await page.getByTestId('cal-ratio').fill('500');
    await page.getByTestId('cal-apply').click();
    await expect(page.getByTestId('recalibration-prompt')).toContainText('1 analysis object');
    await page.getByTestId(choice).click();
    await expect(page.getByTestId('calibration-panel')).toBeHidden();
  };

  await recalibrate('recal-move');
  let p = await project(page);
  expect(p.drawings[0].calibration?.ratio).toBe(500);
  const moved = p.objects[0].geometry;
  expect(moved.type).toBe('circle');
  expect(moved.r).toBeCloseTo(t.r, 9);
  expect(moved.c!.x).toBeCloseTo((100 + 2 * t.x) * 0.5, 9);
  expect(moved.c!.y).toBeCloseTo((100 + 2 * t.y) * 0.5, 9);

  // One undo restores both the calibration and the object.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await project(page)).drawings[0].calibration?.ratio).toBe(1000);
  p = await project(page);
  expect(p.objects[0].geometry.c).toEqual(c1000);
  expect(p.objects[0].geometry.r).toBeCloseTo(2 * t.r, 12);

  await recalibrate('recal-keep');
  p = await project(page);
  expect(p.drawings[0].calibration?.ratio).toBe(500);
  expect(p.objects[0].geometry.c).toEqual(c1000);
});

test('two-point alignment makes matching features of a sub-drawing coincide (row 34)', async ({ page }) => {
  await importDrawing(page, PLOT_PLAN);
  await importDrawing(page, AREA_LOCAL);
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByRole('button', { name: 'Drawing options for area_layout_local_mm' }).click();
  await page.getByRole('menuitem', { name: 'Align to another drawing…' }).click();
  await expect(page.getByTestId('align-panel')).toBeVisible();
  const sub = (i: number) => ({ x: subExp.tanks[i].local[0] / 1000, y: subExp.tanks[i].local[1] / 1000 });
  const base = (i: number) => ({ x: subExp.tanks[i].plant[0], y: subExp.tanks[i].plant[1] });
  await page.getByTestId('align-pick').click();
  for (const p of [sub(0), base(0), sub(1), base(1)]) {
    await zoomTo(page, around(p, 30));
    await clickWorld(page, p);
  }
  await expect(page.getByTestId('align-preview')).toContainText('rotation 15.00°');
  await page.getByTestId('align-apply').click();
  await expect(page.getByTestId('align-panel')).toBeHidden();
  const d = (await project(page)).drawings.find((x) => x.name === 'area_layout_local_mm')!;
  expect(d.alignment).toBeDefined();
  for (const e of subExp.bundEnds) {
    const w = placeOf(d, { x: e.local[0], y: e.local[1] }, 0.001);
    expect(dist(w, { x: e.plant[0], y: e.plant[1] })).toBeLessThan(0.001);
  }
  // Snapping on the aligned sub-drawing lands on plot-plan coordinates.
  await menu(page, 'Draw', 'Point coordinates');
  const corner = { x: subExp.gridIntersections[6].plant[0], y: subExp.gridIntersections[6].plant[1] };
  await zoomTo(page, around(corner, 6));
  await clickWorld(page, corner);
  const value = page.getByTestId('measure-value');
  expect(Math.abs(Number(await value.getAttribute('data-x')) - corner.x)).toBeLessThan(0.001);
});

test('shared coordinates place a plant-coordinate sub-drawing on the plot plan (row 34)', async ({
  page,
}) => {
  await importDrawing(page, PLOT_PLAN);
  await importDrawing(page, AREA_PLANT_MM);
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByRole('button', { name: 'Drawing options for area_layout_plant_mm_header' }).click();
  await page.getByRole('menuitem', { name: 'Align to another drawing…' }).click();
  await page.getByTestId('align-mode-shared').click();
  await page.getByTestId('align-apply').click();
  await expect(page.getByTestId('align-panel')).toBeHidden();
  const d = (await project(page)).drawings.find((x) => x.name === 'area_layout_plant_mm_header')!;
  expect(d.unitsOverride).toBe('m');
  const w = placeOf(d, { x: 600175, y: 2500120.05 }, 1);
  expect(dist(w, { x: 600175, y: 2500120.05 })).toBeLessThan(1e-9);
});
