import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/** Rows 38, 43, 44: drawing shapes with typed dimensions, selection, styling and locked layers. */

interface Obj {
  id: string;
  name: string;
  layerId: string;
  geometry: {
    type: string;
    c?: { x: number; y: number };
    r?: number;
    w?: number;
    h?: number;
    pts?: { x: number; y: number }[];
  };
  style: Record<string, unknown>;
}

const objects = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __pat: { project(): { objects: Obj[] } | null } }).__pat.project()?.objects ??
      [],
  );

async function typeOnCanvas(page: Page, text: string) {
  for (const ch of text) await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
}

async function drawCircle(page: Page, centre: string, radius: string) {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('c');
  await expect(page.getByTestId('tool-hint')).toContainText('Circle: centre');
  await typeOnCanvas(page, centre);
  await expect(page.getByTestId('tool-hint')).toContainText('radius');
  await typeOnCanvas(page, radius);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Objects');
});

test('circle with a typed diameter measures exactly 30 m (row 38)', async ({ page }) => {
  await drawCircle(page, '100,200', 'd30');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  const [o] = await objects(page);
  expect(o.geometry.type).toBe('circle');
  expect(o.geometry.r).toBeCloseTo(15, 9);
  expect(o.geometry.c).toEqual({ x: 100, y: 200 });
  // New objects are selected and shown in the Properties panel with live measures.
  await expect(page.getByTestId('selection-properties')).toBeVisible();
  await expect(page.getByTestId('measure-area')).toContainText('706.86');
});

test('rectangle by typed width,height and polyline by relative coordinates', async ({ page }) => {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('r');
  await typeOnCanvas(page, '0,0');
  await typeOnCanvas(page, '40,25');
  await page.keyboard.press('p');
  await typeOnCanvas(page, '100,0');
  await typeOnCanvas(page, '@50,0');
  await typeOnCanvas(page, '@0,20');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  const [rect, poly] = await objects(page);
  expect(rect.geometry).toMatchObject({ type: 'rect', c: { x: 20, y: 12.5 }, w: 40, h: 25 });
  expect(poly.geometry.pts).toEqual([
    { x: 100, y: 0 },
    { x: 150, y: 0 },
    { x: 150, y: 20 },
  ]);
});

test('undo removes a drawn object and redo restores it', async ({ page }) => {
  await drawCircle(page, '0,0', '5');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await objects(page)).length).toBe(0);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
});

test('style preset applies all style fields in one undo step (row 42)', async ({ page }) => {
  const editor = page.getByTestId('style-editor');
  await drawCircle(page, '0,0', '5');
  await expect(editor).toBeVisible();
  // Style the first circle and save it as a preset.
  await editor.getByLabel('Colour #e11d48').first().click();
  await expect.poll(async () => (await objects(page))[0].style.stroke).toBe('#e11d48');
  await editor.getByRole('button', { name: 'Presets' }).click();
  await page.getByRole('menuitem', { name: /save current style/i }).click();
  await page.getByLabel('Preset name').fill('Red outline');
  await page.getByRole('button', { name: 'OK' }).click();
  const preset = await page.evaluate(
    () =>
      (
        window as unknown as {
          __pat: { project(): { stylePresets: { name: string; style: Record<string, unknown> }[] } };
        }
      ).__pat.project().stylePresets[0],
  );
  expect(preset.name).toBe('Red outline');
  // A second circle gets the preset in one step; a single undo restores its previous style.
  await page.keyboard.press('Escape');
  await drawCircle(page, '50,0', '5');
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  const original = (await objects(page))[1].style;
  await editor.getByRole('button', { name: 'Presets' }).click();
  await page.getByRole('menuitem', { name: 'Red outline' }).click();
  await expect.poll(async () => (await objects(page))[1].style).toEqual(preset.style);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await objects(page))[1].style).toEqual(original);
});

test('objects on a locked layer cannot be selected or edited (row 44)', async ({ page }) => {
  await drawCircle(page, '0,0', '5');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByRole('button', { name: 'Lock layer Analysis' }).click();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('selection-properties')).toHaveCount(0);
  // Drawing on the locked active layer is refused with a message.
  await page.keyboard.press('c');
  await expect(page.getByText(/is locked/)).toBeVisible();
});
