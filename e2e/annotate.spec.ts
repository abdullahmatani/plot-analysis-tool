import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/** Rows 40, 41, 48: text (incl. Arabic), callouts, numbered tags with renumbering, label dragging. */

interface Obj {
  id: string;
  name: string;
  kind: string;
  text?: string;
  tagNumber?: number;
  geometry: { type: string; p?: { x: number; y: number }; pts?: { x: number; y: number }[] };
  label?: { offset?: { x: number; y: number } };
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

/** Screen position (page coordinates) of a world point. */
async function toPage(page: Page, p: { x: number; y: number }) {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const s = await page.evaluate(
    (pt) =>
      (
        window as unknown as {
          __patCanvas: { frame(): { toScreen(p: { x: number; y: number }): { x: number; y: number } } };
        }
      ).__patCanvas
        .frame()
        .toScreen(pt),
    p,
  );
  return { x: box.x + s.x, y: box.y + s.y };
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Annotations');
  await page.getByTestId('canvas').focus();
});

test('free text accepts Arabic and multi-line text (rows 41, 48)', async ({ page }) => {
  await page.keyboard.press('t');
  await typeOnCanvas(page, '10,10');
  const box = page.getByRole('dialog').getByLabel('Text');
  await box.fill('خزان الوقود T-101\nسعة ٥٠٠٠ م³');
  await box.press('Control+Enter');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  const [o] = await objects(page);
  expect(o.kind).toBe('text');
  expect(o.text).toBe('خزان الوقود T-101\nسعة ٥٠٠٠ م³');
  expect(o.geometry.p).toEqual({ x: 10, y: 10 });
  await expect(page.getByLabel('Annotation text')).toHaveValue(o.text!);
});

test('leader callout keeps its arrow point and text position (row 41)', async ({ page }) => {
  await page.keyboard.press('Shift+T');
  await typeOnCanvas(page, '0,0');
  await typeOnCanvas(page, '12,6');
  await page.getByRole('dialog').getByLabel('Text').fill('Pump P-101');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  const [o] = await objects(page);
  expect(o.kind).toBe('callout');
  expect(o.geometry.pts).toEqual([
    { x: 0, y: 0 },
    { x: 12, y: 6 },
  ]);
});

test('tags number per layer and deleting one offers renumbering (row 41)', async ({ page }) => {
  await page.keyboard.press('b');
  for (const at of ['0,0', '30,0', '60,0']) {
    await typeOnCanvas(page, at);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await objects(page)).map((o) => o.tagNumber)).toEqual([1, 2, 3]);
  await page.keyboard.press('Home');
  // Select tag 2 by clicking its bubble, then delete it.
  const at = await toPage(page, { x: 30, y: 0 });
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('annotation-editor')).toBeVisible();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await objects(page)).map((o) => o.tagNumber)).toEqual([1, 3]);
  await page.getByRole('button', { name: 'Renumber' }).click();
  await expect.poll(async () => (await objects(page)).map((o) => o.tagNumber)).toEqual([1, 2]);
  // Renumbering is a single undo step.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await objects(page)).map((o) => o.tagNumber)).toEqual([1, 3]);
});

test('labels can be dragged with the label tool and reset by double-click (row 40)', async ({ page }) => {
  await page.keyboard.press('c');
  await typeOnCanvas(page, '0,0');
  await typeOnCanvas(page, '10');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+L');
  const from = await toPage(page, { x: 0, y: 0 });
  const to = await toPage(page, { x: 0, y: 6 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await objects(page))[0].label?.offset?.y ?? 0).toBeGreaterThan(5);
  await page.mouse.dblclick(to.x, to.y);
  await expect.poll(async () => (await objects(page))[0].label?.offset).toBeUndefined();
});
