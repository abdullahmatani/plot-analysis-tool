import type { Page } from '@playwright/test';

import {
  PLOT_PLAN,
  around,
  clickWorld,
  importDrawing,
  menu,
  menuToggle,
  project,
  zoomTo,
  type Pt,
} from './drawing-helpers';
import { createProject, expect, openApp, test } from './fixtures';

/** Rows 26, 35, 36: measurement tools, annotations in display units, scale bar and north arrow. */

test.use({ viewport: { width: 1600, height: 1000 } });

const E0 = 600000;
const N0 = 2500000;
const P = (e: number, n: number): Pt => ({ x: E0 + e, y: N0 + n });

async function startTool(page: Page, title: string) {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Escape');
  await menu(page, 'Draw', title);
  const guard = page.getByTestId('calibration-guard');
  if (await guard.isVisible().catch(() => false)) await page.getByTestId('guard-confirm-units').click();
  await expect(page.getByTestId('measure-hud')).toBeVisible();
}

const num = async (page: Page, attr: string) =>
  Number(await page.getByTestId('measure-value').getAttribute(`data-${attr}`));

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Measure');
  await importDrawing(page, PLOT_PLAN);
});

test('distance, chain, area, radius, angle and object measurements match the CAD geometry (row 35)', async ({
  page,
}) => {
  // The first measurement asks to confirm the file units (metres).
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('d');
  await expect(page.getByTestId('calibration-guard')).toBeVisible();
  await page.getByTestId('guard-confirm-units').click();
  await expect(page.getByTestId('measure-hud')).toBeVisible();
  await zoomTo(page, { minX: E0 - 10, minY: N0 - 10, maxX: E0 + 160, maxY: N0 + 110 });
  await clickWorld(page, P(0, 0));
  await clickWorld(page, P(150, 100));
  expect(Math.abs((await num(page, 'distance')) - Math.hypot(150, 100))).toBeLessThan(0.001);
  await expect(page.getByTestId('measure-value')).toHaveText('180.28 m');

  await startTool(page, 'Measure chained distance / polyline length');
  await zoomTo(page, { minX: E0 - 10, minY: N0 - 10, maxX: E0 + 110, maxY: N0 + 60 });
  for (const p of [P(0, 0), P(50, 0), P(50, 50), P(100, 50)]) await clickWorld(page, p);
  await page.keyboard.press('Enter');
  expect(Math.abs((await num(page, 'total')) - 150)).toBeLessThan(0.001);

  await startTool(page, 'Measure area and perimeter');
  for (const p of [P(0, 0), P(50, 0), P(50, 50), P(0, 50)]) await clickWorld(page, p);
  await page.keyboard.press('Enter');
  expect(Math.abs((await num(page, 'area')) - 2500)).toBeLessThan(0.001);
  expect(Math.abs((await num(page, 'perimeter')) - 200)).toBeLessThan(0.001);

  await startTool(page, 'Measure angle');
  for (const p of [P(0, 0), P(50, 0), P(50, 50)]) await clickWorld(page, p);
  expect(Math.abs((await num(page, 'angle')) - Math.PI / 4)).toBeLessThan(1e-9);
  await expect(page.getByTestId('measure-value')).toHaveText('45.00°');

  // Tank shell CIRCLE (600200, 2500150, r 15): radius and diameter.
  await startTool(page, 'Measure radius / diameter');
  await zoomTo(page, around(P(200, 150), 22));
  await clickWorld(page, P(215, 150));
  expect(await num(page, 'radius')).toBe(15);
  await expect(page.getByTestId('measure-hud')).toContainText('30.00 m');

  // Tank outline LWPOLYLINE with two r = 5 m bulge corners: exact area and perimeter.
  await startTool(page, 'Measure object (length, area, radius)');
  await zoomTo(page, around(P(200, 150), 30));
  await clickWorld(page, P(195, 125));
  const corner = 25 - (25 * Math.PI) / 4;
  expect(Math.abs((await num(page, 'area')) - (45 * 50 - 2 * corner))).toBeLessThan(0.001);
  expect(Math.abs((await num(page, 'perimeter')) - (170 + 5 * Math.PI))).toBeLessThan(0.001);
});

test('kept measurements are annotations whose text follows the display units (rows 26, 35)', async ({
  page,
}) => {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('d');
  await page.getByTestId('guard-confirm-units').click();
  await page.getByTestId('measure-keep').click();
  await zoomTo(page, { minX: E0 - 10, minY: N0 - 10, maxX: E0 + 160, maxY: N0 + 110 });
  await clickWorld(page, P(0, 0));
  await clickWorld(page, P(150, 100));
  await expect.poll(async () => (await project(page)).objects.length).toBe(1);
  const p = await project(page);
  const o = p.objects[0];
  expect(o.kind).toBe('measurement');
  expect(o.measurement?.mode).toBe('distance');
  expect(p.layers.find((l) => l.id === o.layerId)?.name).toBe('Measurements');
  expect(o.geometry.pts).toEqual([P(0, 0), P(150, 100)]);
  await expect(page.getByTestId('measure-value')).toHaveText('180.28 m');

  // Switching units updates the readouts instantly (and the canvas annotation text, drawn from the same formatter).
  await menu(page, 'File', /Project settings/);
  await page.getByLabel('Length units').click();
  await page.getByRole('option', { name: 'Millimetres (mm)' }).click();
  await expect(page.getByTestId('display-preview')).toContainText('mm');
  await page.getByLabel('Decimal places').click();
  await page.getByRole('option', { name: '1', exact: true }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('measure-value')).toHaveText('180\u202F277.6 mm');
  expect((await project(page)).display.units).toBe('mm');
  await expect(page.getByTestId('project-settings')).toBeHidden();
  const box = (await page.getByTestId('canvas').boundingBox())!;
  let dx = 0;
  await expect
    .poll(async () => {
      dx = (dx + 7) % 40;
      await page.mouse.move(box.x + box.width * 0.7 + dx, box.y + box.height * 0.6);
      return page.getByTestId('cursor-coords').textContent();
    })
    .toContain(' mm');
  // Each setting is one undo step; the annotation itself was one more.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Escape');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await expect.poll(async () => (await project(page)).objects.length).toBe(0);
  expect((await project(page)).display.units).toBe('m');
});

test('scale bar shows a nice length at the view scale; scale bar and north arrow toggle (row 36)', async ({
  page,
}) => {
  const bar = page.getByTestId('scale-bar');
  await expect(bar).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __patCanvas: { setView(v: object): void } }).__patCanvas.setView({
      cx: 600150,
      cy: 2500100,
      scale: 2,
      rotation: 0,
    }),
  );
  // 2 px per metre, ≤ 160 px → 50 m drawn 100 px long.
  await expect(bar).toHaveAttribute('data-metres', '50');
  await expect(bar).toHaveAttribute('data-px', '100');
  await expect(bar).toContainText('50 m');
  const rect = await page.getByTestId('scale-bar-graphic').locator('rect').first().boundingBox();
  expect(Math.abs(rect!.width - 100)).toBeLessThanOrEqual(1.5);
  await page.evaluate(() =>
    (window as unknown as { __patCanvas: { setView(v: object): void } }).__patCanvas.setView({
      cx: 600150,
      cy: 2500100,
      scale: 0.05,
      rotation: Math.PI / 2,
    }),
  );
  // 0.05 px per metre: ≤ 3 200 m → 2.5 km.
  await expect(bar).toHaveAttribute('data-metres', '2500');
  await expect(bar).toContainText('2.5 km');
  // The north arrow turns with the view.
  expect(Number(await page.getByTestId('north-arrow').getAttribute('data-angle'))).toBeCloseTo(90, 9);
  await menuToggle(page, 'View', 'Show scale bar');
  await expect(bar).toBeHidden();
  await menuToggle(page, 'View', 'Show north arrow');
  await expect(page.getByTestId('north-arrow')).toBeHidden();
  await menuToggle(page, 'View', 'Show scale bar');
  await expect(bar).toBeVisible();
});
