import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/**
 * Objects table (row 46; non-visual alternative to the canvas, row 84): lists analysis objects with
 * measures, search/filter/sort, click to select and zoom, selection synchronised both ways.
 */

interface Obj {
  id: string;
  name: string;
}

const objects = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __pat: { project(): { objects: Obj[] } } }).__pat.project().objects,
  );
/** The canvas selection (view store), sorted. */
const selection = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __patSelection(): string[] }).__patSelection()].sort());
const view = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __patCanvas: { frame(): { view: { cx: number; cy: number; scale: number } } } }
      ).__patCanvas.frame().view,
  );

async function type(page: Page, text: string) {
  for (const ch of text) await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Objects table');
  await page.getByTestId('canvas').focus();
  // A Ø30 m circle at (100, 200) and a 40 × 25 m rectangle at the origin.
  await page.keyboard.press('c');
  await type(page, '100,200');
  await type(page, 'd30');
  await page.keyboard.press('r');
  await type(page, '0,0');
  await type(page, '40,25');
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Data' }).click();
});

test('lists objects with layer, type and measures; search and sort', async ({ page }) => {
  const grid = page.getByTestId('objects-grid');
  const rows = grid.locator('tbody tr[data-object-id]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Circle 1');
  await expect(rows.nth(0)).toContainText('Analysis');
  await expect(rows.nth(0)).toContainText('706.86');
  await expect(rows.nth(0)).toContainText('15.00');
  await expect(rows.nth(1)).toContainText('Rectangle');
  await expect(rows.nth(1)).toContainText('130.00');
  // Sort by area (ascending: the circle is smaller).
  await grid.getByRole('button', { name: /^Area/ }).click();
  await expect(rows.nth(0)).toContainText('Circle 1');
  await grid.getByRole('button', { name: /^Area/ }).click();
  await expect(rows.nth(0)).toContainText('Rectangle 1');
  // Search.
  await page.getByTestId('objects-search').fill('rect');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Rectangle 1');
  await page.getByTestId('objects-search').fill('');
  await page.getByRole('combobox', { name: 'Filter by type' }).click();
  await page.getByRole('option', { name: 'Circle', exact: true }).click();
  await expect(rows).toHaveCount(1);
});

test('clicking a row selects and zooms to the object; canvas selection is reflected in the table', async ({
  page,
}) => {
  const [circle, rect] = await objects(page);
  const grid = page.getByTestId('objects-grid');
  const before = await view(page);
  await grid.locator(`tr[data-object-id="${rect.id}"]`).click();
  await expect(grid.locator(`tr[data-object-id="${rect.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await view(page)).cx).toBeCloseTo(20, 6);
  const after = await view(page);
  expect(after.cy).toBeCloseTo(12.5, 6);
  expect(after).not.toEqual(before);
  // Table → canvas selection.
  await expect(page.getByTestId('objects-selected-count')).toHaveText('1 selected');
  // Ctrl-click adds the circle.
  await grid.locator(`tr[data-object-id="${circle.id}"]`).click({ modifiers: ['Control'] });
  await expect.poll(() => selection(page)).toEqual([circle.id, rect.id].sort());

  // Canvas → table: Escape clears, Ctrl+A selects all, a click on the canvas selects one.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Escape');
  await expect.poll(() => selection(page)).toEqual([]);
  await page.keyboard.press('Control+a');
  await expect.poll(() => selection(page)).toEqual([circle.id, rect.id].sort());
  await page.keyboard.press('Escape');
  // Click the circle's outline on the canvas.
  const s = await page.evaluate(() =>
    (
      window as unknown as {
        __patCanvas: { frame(): { toScreen(p: { x: number; y: number }): { x: number; y: number } } };
      }
    ).__patCanvas
      .frame()
      .toScreen({ x: 115, y: 200 }),
  );
  const box = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.click(box.x + s.x, box.y + s.y);
  await expect.poll(() => selection(page)).toEqual([circle.id]);
  await expect(grid.locator(`tr[data-object-id="${circle.id}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('keyboard operation: arrows select, Space toggles, Enter zooms; locked layers cannot be selected', async ({
  page,
}) => {
  const [circle, rect] = await objects(page);
  const grid = page.getByTestId('objects-grid');
  await grid.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => selection(page)).toEqual([rect.id]);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => selection(page)).toEqual([circle.id]);
  await page.keyboard.press('Space');
  await expect.poll(() => selection(page)).toEqual([]);
  await page.keyboard.press('Space');
  await expect.poll(() => selection(page)).toEqual([circle.id]);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await view(page)).cx).toBeCloseTo(100, 6);
  await page.keyboard.press('Escape');
  await expect.poll(() => selection(page)).toEqual([]);

  // Lock the layer: rows stay listed (and zoomable) but cannot be selected.
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByRole('button', { name: 'Lock layer Analysis' }).click();
  await page.getByRole('tab', { name: 'Data' }).click();
  await grid.locator(`tr[data-object-id="${rect.id}"]`).click();
  await expect.poll(() => selection(page)).toEqual([]);
  await expect(grid.locator(`tr[data-object-id="${rect.id}"]`)).toContainText('Rectangle 1');
});
