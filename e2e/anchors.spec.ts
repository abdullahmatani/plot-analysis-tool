import path from 'node:path';

import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/** Anchors (row 47): placing, snapping, bulk creation from circles, renaming with dataset rows. */

interface Anchor {
  id: string;
  name: string;
  p: { x: number; y: number };
}
interface Project {
  anchors: Anchor[];
  objects: { geometry: { type: string; c?: { x: number; y: number }; r?: number } }[];
  datasets: { id: string; table: { rows: (string | number | null)[][] } }[];
}

const project = (page: Page) =>
  page.evaluate(() => (window as unknown as { __pat: { project(): Project } }).__pat.project());
const undoDepth = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __pat: { store(): { history: { undo: unknown[] } } } }).__pat.store().history
        .undo.length,
  );
const toScreen = (page: Page, p: { x: number; y: number }) =>
  page.evaluate(
    (pt) =>
      (
        window as unknown as {
          __patCanvas: { frame(): { toScreen(q: { x: number; y: number }): { x: number; y: number } } };
        }
      ).__patCanvas
        .frame()
        .toScreen(pt),
    p,
  );

async function type(page: Page, text: string) {
  for (const ch of text) await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
}

async function placeAnchor(page: Page, at: string, name: string) {
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByTestId('anchor-place').click();
  await page.getByTestId('canvas').focus();
  await type(page, at);
  await page.getByLabel('Anchor name').fill(name);
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId(`anchor-${name}`)).toBeVisible();
}

async function pasteTable(page: Page, text: string) {
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByTestId('dataset-import-menu').click();
  await page.getByRole('menuitem', { name: /Paste/ }).click();
  await page.getByTestId('paste-target').focus();
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document
      .querySelector('[data-testid="paste-target"]')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  await page.getByTestId('mapping-next').click();
  await page.getByTestId('import-dataset').click();
  await expect(page.getByTestId('import-table-dialog')).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Anchors');
});

test('renaming an anchor updates every dataset row referencing it, in one undo step (row 47)', async ({
  page,
}) => {
  await placeAnchor(page, '12.5,7.25', 'P-101');
  await page.keyboard.press('Escape');
  expect((await project(page)).anchors).toMatchObject([{ name: 'P-101', p: { x: 12.5, y: 7.25 } }]);

  await pasteTable(
    page,
    'Equipment\tScenario\tRadius (m)\nP-101\tJet fire\t25\np-101\tPool fire\t12\nV-201\tFlash\t5\n',
  );
  const before = await project(page);
  const dsId = before.datasets[0].id;
  const centres = () =>
    page.evaluate(
      (id) =>
        (
          window as unknown as { __patContours: { rings(i: string): { centre: { x: number; y: number } }[] } }
        ).__patContours
          .rings(id)
          .map((r) => r.centre),
      dsId,
    );
  expect(await centres()).toEqual([
    { x: 12.5, y: 7.25 },
    { x: 12.5, y: 7.25 },
  ]);

  await page.getByRole('tab', { name: 'Layers' }).click();
  const depth = await undoDepth(page);
  await page.getByRole('button', { name: 'Anchor options for P-101' }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByLabel('Anchor name').fill('P-101A');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByTestId('anchor-P-101A')).toBeVisible();
  const after = await project(page);
  expect(after.anchors[0].name).toBe('P-101A');
  expect(after.datasets[0].table.rows.map((r) => r[0])).toEqual(['P-101A', 'P-101A', 'V-201']);
  expect(await undoDepth(page)).toBe(depth + 1);
  expect(await centres()).toHaveLength(2); // still attached

  // One undo restores the anchor name and the dataset rows together.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await project(page)).anchors[0].name).toBe('P-101');
  expect((await project(page)).datasets[0].table.rows.map((r) => r[0])).toEqual(['P-101', 'p-101', 'V-201']);

  // Deleting a referenced anchor asks first; its rows become unmatched.
  await page.getByRole('button', { name: 'Anchor options for P-101' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete anchor' }).click();
  await expect.poll(async () => (await project(page)).anchors).toEqual([]);
  expect(await centres()).toEqual([]);
});

test('anchors are snap targets: a circle centre picked near an anchor equals it exactly', async ({
  page,
}) => {
  await placeAnchor(page, '12.345,6.789', 'N-1');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Escape');
  const s = await toScreen(page, { x: 12.345, y: 6.789 });
  const box = (await page.getByTestId('canvas').boundingBox())!;
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('c');
  await page.mouse.move(box.x + s.x + 3, box.y + s.y - 2);
  await page.mouse.move(box.x + s.x + 3, box.y + s.y - 3);
  await page.mouse.down();
  await page.mouse.up();
  await type(page, '5');
  await expect.poll(async () => (await project(page)).objects.length).toBe(1);
  const g = (await project(page)).objects[0].geometry;
  expect(g.c).toEqual({ x: 12.345, y: 6.789 }); // snapped exactly to the anchor
  expect(g.r).toBeCloseTo(5, 9);
});

test('bulk-creates anchors from picked circle centres with a window selection', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+i');
  await (await chooser).setFiles(path.resolve('tests/fixtures/dxf/r12_entities.dxf'));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __patCanvas: { frame(): { scale: number } } }).__patCanvas.frame().scale,
      ),
    )
    .not.toBe(1);
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByTestId('anchor-from-circles').click();
  const box = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('tool-hint')).toContainText('3 circle(s) picked');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Name prefix').fill('C-');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => (await project(page)).anchors.length).toBe(3);
  const anchors = (await project(page)).anchors.map((a) => [a.name, a.p]);
  // The 12.5 m circle has the text "Centre" inside it and is named after it; the others are numbered.
  expect(anchors).toEqual([
    ['Centre', { x: 50, y: 50 }],
    ['C-1', { x: 30, y: 30 }],
    ['C-2', { x: -20, y: 5 }],
  ]);
  await expect(page.getByTestId('anchor-list')).toContainText('C-2');
});
