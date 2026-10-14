import type { Page } from '@playwright/test';

import { project, screenOf } from './drawing-helpers';
import { createProject, expect, openApp, test } from './fixtures';
import { decodePng } from './png';

/**
 * Row 54 acceptance (test plan, docs/TEST-PLAN.md §3): on the scanned reference page (raster only,
 * 2 px per paper mm = 0.25 m per scan pixel at 1:500) the rendered scan sits where the calibration
 * says, and manually traced vertices land within one scan pixel of the true positions.
 */

const SCAN_PX_M = 0.25;
/** World position of the site corners on the scanned page after 1:500 calibration (page 1 layout). */
const CORNERS = [
  { x: 50, y: 50 },
  { x: 350, y: 50 },
  { x: 350, y: 250 },
  { x: 50, y: 250 },
];

async function importScannedPage(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+i');
  await (await chooser).setFiles('tests/fixtures/pdf/plot-plan-a1-1to500.pdf');
  const picker = page.getByTestId('pdf-page-picker');
  await expect(picker).toBeVisible();
  await picker.getByText('Page 1', { exact: true }).click(); // deselect the vector page
  await picker.getByText('Page 3', { exact: true }).click();
  await picker.getByRole('button', { name: /^Import 1 page/ }).click();
  await expect.poll(async () => (await project(page)).drawings.length).toBe(1);
}

/** Centroid (screen px) of dark pixels in a strip across a boundary line of the scan. */
async function lineCentre(page: Page, at: { x: number; y: number }, axis: 'x' | 'y'): Promise<number> {
  const half = 24;
  const clip =
    axis === 'y'
      ? { x: Math.round(at.x) - 4, y: Math.round(at.y) - half, width: 9, height: 2 * half + 1 }
      : { x: Math.round(at.x) - half, y: Math.round(at.y) - 4, width: 2 * half + 1, height: 9 };
  const png = decodePng(new Uint8Array(await page.screenshot({ clip })));
  let sum = 0;
  let wsum = 0;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const [r, g, b] = png.px(x, y);
      const dark = 255 - (r + g + b) / 3;
      if (dark < 60) continue;
      sum += dark * (axis === 'y' ? y : x);
      wsum += dark;
    }
  expect(wsum, 'scan line visible').toBeGreaterThan(0);
  return (axis === 'y' ? clip.y : clip.x) + sum / wsum + 0.5;
}

test('raster tracing accuracy on a scanned page (row 54)', async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Raster');
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').getByRole('combobox').fill('Light canvas background');
  await page.keyboard.press('Enter');
  await importScannedPage(page);
  // Stated ratio 1:500 (row 30): PDF points → metres.
  const k = (0.0254 / 72) * 500;
  await page.evaluate((k) => {
    const w = window as unknown as {
      __pat: {
        store(): { commit(l: string, fn: (d: { drawings: Record<string, unknown>[] }) => void): boolean };
      };
    };
    w.__pat.store().commit('Calibrate', (d) => {
      d.drawings[0].calibration = {
        method: 'ratio',
        ratio: 500,
        transform: [k, 0, 0, k, 0, 0],
        references: [],
        at: '',
      };
    });
  }, k);
  // Zoom so that one scan pixel is about 6 screen pixels (as with the loupe on a normal view).
  await page.evaluate(() =>
    (
      window as unknown as {
        __patCanvas: { setView(v: { cx: number; cy: number; scale: number; rotation: number }): void };
      }
    ).__patCanvas.setView({ cx: 52, cy: 52, scale: 24, rotation: 0 }),
  );
  await page.waitForTimeout(1500); // raster tiles for the new zoom

  // 1. The rendered scan is where the calibration puts it: bottom and left site boundaries.
  const scale = 24;
  const bottom = await screenOf(page, { x: 56, y: 50 });
  const yLine = await lineCentre(page, bottom, 'y');
  expect(Math.abs(yLine - bottom.y) / scale, 'bottom boundary offset (m)').toBeLessThanOrEqual(SCAN_PX_M);
  const left = await screenOf(page, { x: 50, y: 56 });
  const xLine = await lineCentre(page, left, 'x');
  expect(Math.abs(xLine - left.x) / scale, 'left boundary offset (m)').toBeLessThanOrEqual(SCAN_PX_M);

  // 2. Manual tracing on the scan: clicking the rendered corner gives vertices within one scan pixel.
  const corner = { x: xLine, y: yLine };
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('t');
  await page.mouse.click(corner.x, corner.y);
  const world = await page.evaluate(
    ([x, y]) => {
      const c = (
        window as unknown as {
          __patCanvas: { frame(): { toWorld(p: { x: number; y: number }): { x: number; y: number } } };
        }
      ).__patCanvas;
      return c.frame().toWorld({ x, y });
    },
    [
      corner.x - (await page.getByTestId('canvas').boundingBox())!.x,
      corner.y - (await page.getByTestId('canvas').boundingBox())!.y,
    ],
  );
  expect(
    Math.hypot(world.x - CORNERS[0].x, world.y - CORNERS[0].y),
    'traced corner error (m)',
  ).toBeLessThanOrEqual(SCAN_PX_M * Math.SQRT2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});
