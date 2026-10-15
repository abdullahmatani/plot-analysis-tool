import type { Page } from '@playwright/test';

import { PLOT_PLAN, importDrawing, type Pt } from './drawing-helpers';
import { createProject, expect, openApp, test } from './fixtures';
import { decodePng } from './png';

/**
 * Viewer navigation (row 17): pan with the middle button, Space+drag, the Pan tool and one finger;
 * zoom at the cursor with the wheel and with a pinch; zoom window, zoom extents and zoom to
 * selection; view rotation in 90° steps and to a free angle; saved views. Positions are checked in
 * world coordinates against the app's own screen ↔ world mapping, and the rotated underlay is
 * checked in the rendered pixels.
 */

interface View {
  cx: number;
  cy: number;
  scale: number;
  rotation: number;
}
interface Hooks {
  __pat: {
    view(): {
      view: View;
      selection: string[];
      hoverEntity: unknown;
      pickedEntity: unknown;
      set(p: object): void;
    };
    store(): { commit(label: string, fn: (d: Record<string, unknown[]>) => void): boolean; undo(): boolean };
    project(): { views: { name: string; centre: Pt; scale: number; rotation: number }[] } | null;
  };
  __patCanvas: {
    frame(): { toScreen(p: Pt): Pt; toWorld(p: Pt): Pt; width: number; height: number };
    zoomToBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, margin?: number): void;
    contentBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null;
  };
}

const getView = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__pat.view().view);

/** Canvas-relative point → page point. */
async function pageOf(page: Page, s: Pt): Promise<Pt> {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  return { x: box.x + s.x, y: box.y + s.y };
}
/** World point under a canvas-relative point. */
const worldAt = (page: Page, s: Pt) =>
  page.evaluate((s) => (window as unknown as Hooks).__patCanvas.frame().toWorld(s), s);
/** Canvas-relative position of a world point. */
const screenAt = (page: Page, w: Pt) =>
  page.evaluate((w) => (window as unknown as Hooks).__patCanvas.frame().toScreen(w), w);
const canvasSize = (page: Page) =>
  page.evaluate(() => {
    const f = (window as unknown as Hooks).__patCanvas.frame();
    return { w: f.width, h: f.height };
  });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

async function zoomAround(page: Page, c: Pt, half: number) {
  await page.evaluate(
    ([c, h]) =>
      (window as unknown as Hooks).__patCanvas.zoomToBounds(
        { minX: c.x - h, minY: c.y - h, maxX: c.x + h, maxY: c.y + h },
        0,
      ),
    [c, half] as const,
  );
}

async function palette(page: Page, command: string) {
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').getByRole('combobox').fill(command);
  await page.keyboard.press('Enter');
}

const SITE: Pt = { x: 600_150, y: 2_500_100 };
const TANK: Pt = { x: 600_200, y: 2_500_150 }; // concentric tank shells, r 15 m and 14.5 m

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Navigation');
  await importDrawing(page, PLOT_PLAN);
  await zoomAround(page, SITE, 120);
  await page.getByTestId('canvas').focus();
});

test('the wheel zooms in and out at the cursor, keeping the point under it fixed (row 17)', async ({
  page,
}) => {
  const { w, h } = await canvasSize(page);
  const cursor = { x: w * 0.7, y: h * 0.35 };
  const under = await worldAt(page, cursor);
  const p = await pageOf(page, cursor);
  const before = await getView(page);
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await getView(page)).scale).toBeGreaterThan(before.scale * 1.5);
  expect(dist(await screenAt(page, under), cursor)).toBeLessThan(0.5);
  await page.mouse.wheel(0, 800);
  await expect.poll(async () => (await getView(page)).scale).toBeLessThan(before.scale / 1.5);
  expect(dist(await screenAt(page, under), cursor)).toBeLessThan(0.5);
});

test('middle button, Space+drag and the Pan tool move the drawing with the pointer (row 17)', async ({
  page,
}) => {
  const { w, h } = await canvasSize(page);
  const drag = async (method: 'middle' | 'space' | 'pan-tool', d: Pt) => {
    const start = { x: w * 0.6, y: h * 0.5 };
    const under = await worldAt(page, start);
    const a = await pageOf(page, start);
    if (method === 'space') await page.keyboard.down('Space');
    if (method === 'pan-tool') await page.keyboard.press('h');
    await page.mouse.move(a.x, a.y);
    await page.mouse.down({ button: method === 'middle' ? 'middle' : 'left' });
    for (let i = 1; i <= 5; i++) await page.mouse.move(a.x + (d.x * i) / 5, a.y + (d.y * i) / 5);
    await page.mouse.up({ button: method === 'middle' ? 'middle' : 'left' });
    if (method === 'space') await page.keyboard.up('Space');
    if (method === 'pan-tool') await page.keyboard.press('v');
    expect(dist(await screenAt(page, under), { x: start.x + d.x, y: start.y + d.y }), method).toBeLessThan(
      0.5,
    );
  };
  const scale = (await getView(page)).scale;
  await drag('middle', { x: -140, y: 60 });
  await drag('space', { x: 90, y: -75 });
  await drag('pan-tool', { x: -50, y: -40 });
  expect((await getView(page)).scale).toBe(scale);
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('one finger pans; two fingers pinch-zoom about their midpoint (row 17)', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Pt[]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
      });
    const { w, h } = await canvasSize(page);

    // One finger (Select tool): pan.
    const start = { x: w * 0.5, y: h * 0.5 };
    const under = await worldAt(page, start);
    const a = await pageOf(page, start);
    await touch('touchStart', [a]);
    for (let i = 1; i <= 5; i++) await touch('touchMove', [{ x: a.x + 16 * i, y: a.y - 10 * i }]);
    await touch('touchEnd', []);
    expect(dist(await screenAt(page, under), { x: start.x + 80, y: start.y - 50 })).toBeLessThan(0.5);

    // Two fingers spreading from 100 px to 250 px apart: zoom ×2.5 about the midpoint.
    const mid = { x: w * 0.45, y: h * 0.55 };
    const fixed = await worldAt(page, mid);
    const m = await pageOf(page, mid);
    const scale = (await getView(page)).scale;
    await touch('touchStart', [
      { x: m.x - 50, y: m.y },
      { x: m.x + 50, y: m.y },
    ]);
    for (let i = 1; i <= 6; i++)
      await touch('touchMove', [
        { x: m.x - 50 - 12.5 * i, y: m.y },
        { x: m.x + 50 + 12.5 * i, y: m.y },
      ]);
    await touch('touchEnd', []);
    expect((await getView(page)).scale / scale).toBeCloseTo(2.5, 2);
    expect(dist(await screenAt(page, fixed), mid)).toBeLessThan(1);
  });
});

test('zoom window fits the dragged rectangle; a click zooms in 2× at that point (row 17)', async ({
  page,
}) => {
  // The empty grid square north-east of the site centre.
  const box = { minX: 600_250, minY: 2_500_050, maxX: 600_300, maxY: 2_500_100 };
  const a = await pageOf(page, await screenAt(page, { x: box.minX, y: box.maxY }));
  const b = await pageOf(page, await screenAt(page, { x: box.maxX, y: box.minY }));
  await page.keyboard.press('z');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await page.mouse.move(b.x, b.y);
  await page.mouse.up();
  const { w, h } = await canvasSize(page);
  const nw = await screenAt(page, { x: box.minX, y: box.maxY });
  const se = await screenAt(page, { x: box.maxX, y: box.minY });
  // Fitted with an 8 px margin: inside the canvas, filling its height (the square is the narrow side).
  expect(Math.min(nw.x, nw.y)).toBeGreaterThanOrEqual(7.5);
  expect(se.x).toBeLessThanOrEqual(w - 7.5);
  expect(se.y).toBeLessThanOrEqual(h - 7.5);
  expect(Math.max((se.x - nw.x) / (w - 16), (se.y - nw.y) / (h - 16))).toBeCloseTo(1, 3);

  const click = { x: w * 0.3, y: h * 0.6 };
  const under = await worldAt(page, click);
  const scale = (await getView(page)).scale;
  const c = await pageOf(page, click);
  await page.mouse.click(c.x, c.y);
  expect((await getView(page)).scale / scale).toBeCloseTo(2, 6);
  expect(dist(await screenAt(page, under), click)).toBeLessThan(0.5);
  await page.keyboard.press('v');
});

test('zoom extents shows the whole drawing (row 17)', async ({ page }) => {
  await zoomAround(page, TANK, 2);
  await page.keyboard.press('Home');
  const b = (await page.evaluate(() => (window as unknown as Hooks).__patCanvas.contentBounds()))!;
  const { w, h } = await canvasSize(page);
  const lo = await screenAt(page, { x: b.minX, y: b.maxY });
  const hi = await screenAt(page, { x: b.maxX, y: b.minY });
  expect(Math.min(lo.x, lo.y)).toBeGreaterThanOrEqual(23.5);
  expect(hi.x).toBeLessThanOrEqual(w - 23.5);
  expect(hi.y).toBeLessThanOrEqual(h - 23.5);
  expect(Math.max((hi.x - lo.x) / (w - 48), (hi.y - lo.y) / (h - 48))).toBeCloseTo(1, 3);
});

test('zoom to selection fits the selected objects, else the picked underlay entity (row 17)', async ({
  page,
}) => {
  // Nothing selected: a message, and the view stays.
  const before = await getView(page);
  await page.keyboard.press('Shift+Z');
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Nothing is selected' })).toBeVisible();
  expect(await getView(page)).toEqual(before);

  // A picked underlay entity: click the outer tank shell (at 45°, clear of the grid lines through the
  // tank centre), then Shift+Z.
  await zoomAround(page, TANK, 20);
  const r45 = 15 * Math.SQRT1_2;
  const edge = await pageOf(page, await screenAt(page, { x: TANK.x + r45, y: TANK.y + r45 }));
  await page.mouse.move(edge.x + 2, edge.y);
  await page.mouse.move(edge.x, edge.y);
  // The hovered entity is what a click pins (updated on the next frame after the pointer moves).
  await expect
    .poll(() => page.evaluate(() => !!(window as unknown as Hooks).__pat.view().hoverEntity))
    .toBe(true);
  await page.mouse.click(edge.x, edge.y);
  await expect
    .poll(() => page.evaluate(() => !!(window as unknown as Hooks).__pat.view().pickedEntity))
    .toBe(true);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Shift+Z');
  await expect.poll(async () => (await getView(page)).cx).toBeCloseTo(TANK.x, 6);
  const { w, h } = await canvasSize(page);
  const fit = (d: number) => Math.min(w - 96, h - 96) / d; // zoomToBounds margin 48 px
  let v = await getView(page);
  expect(v.cy).toBeCloseTo(TANK.y, 6);
  expect(v.scale).toBeGreaterThanOrEqual(fit(30) * 0.999);
  expect(v.scale).toBeLessThanOrEqual(fit(29) * 1.001);

  // Selected analysis objects take precedence over the picked entity.
  await page.evaluate(() => {
    const w = window as unknown as Hooks;
    w.__pat.store().commit('Add zone', (d) => {
      d.objects.push({
        id: 'zone1',
        layerId: (d as unknown as { activeLayerId: string }).activeLayerId,
        name: 'Zone',
        kind: 'shape',
        geometry: { type: 'circle', c: { x: 600_270, y: 2_500_070 }, r: 4 },
        style: {},
        attributes: {},
        createdAt: new Date().toISOString(),
      });
    });
    w.__pat.view().set({ selection: ['zone1'] });
  });
  await page.keyboard.press('Shift+Z');
  await expect.poll(async () => (await getView(page)).cx).toBeCloseTo(600_270, 6);
  v = await getView(page);
  expect(v.cy).toBeCloseTo(2_500_070, 6);
  expect(v.scale).toBeCloseTo(fit(8), 6);
});

test('view rotation in 90° steps and to a free angle; the underlay turns with it (row 17)', async ({
  page,
}) => {
  const rot = async () => (await getView(page)).rotation;
  const centre = await getView(page);
  await page.keyboard.press('Alt+]');
  expect(await rot()).toBeCloseTo(-Math.PI / 2, 12);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Alt+]');
  expect(await rot()).toBe(0);
  await page.keyboard.press('Alt+[');
  expect(await rot()).toBeCloseTo(Math.PI / 2, 12);
  const v90 = await getView(page);
  expect([v90.cx, v90.cy, v90.scale]).toEqual([centre.cx, centre.cy, centre.scale]);

  await palette(page, 'Rotate view to angle');
  const input = page.getByRole('dialog').getByLabel('Angle in degrees (anticlockwise)');
  await input.fill('30');
  await input.press('Enter');
  await expect.poll(rot).toBeCloseTo(Math.PI / 6, 12);

  // The rendered vertical grid line E 600 300 must appear rotated by 30°: drawn where the view maps
  // it, and absent where it would be without rotation.
  await zoomAround(page, { x: 600_275, y: 2_500_075 }, 40);
  await page.waitForTimeout(300);
  const shot = decodePng(await page.getByTestId('canvas-container').screenshot());
  const k = shot.width / (await canvasSize(page)).w; // device pixels per CSS pixel
  const lineAt = async (world: Pt) => {
    const s = await screenAt(page, world);
    const [x0, y0] = [Math.round(s.x * k), Math.round(s.y * k)];
    let best = 0;
    const bg = shot.px(Math.round((await screenAt(page, { x: 600_275, y: 2_500_075 })).x * k), y0);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const p = shot.px(x0 + dx, y0 + dy);
        best = Math.max(best, Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]));
      }
    return best;
  };
  for (const y of [2_500_060, 2_500_075, 2_500_090])
    expect(await lineAt({ x: 600_300, y })).toBeGreaterThan(60);
  // Unrotated, the line would pass through the screen point of (600 300, y) with rotation 0, which
  // the 30° view maps from this world point instead:
  const v = await getView(page);
  const { w, h } = await canvasSize(page);
  const unrotated = { x: w / 2 + v.scale * (600_300 - v.cx), y: h / 2 - v.scale * (2_500_090 - v.cy) };
  const ghost = await worldAt(page, unrotated);
  expect(Math.abs(ghost.x - 600_300)).toBeGreaterThan(3);
  expect(await lineAt(ghost)).toBeLessThan(60);
});

test('saved views: save, go to, rename, update and delete; undoable and kept with the project (row 17)', async ({
  page,
}) => {
  const views = () => page.evaluate(() => (window as unknown as Hooks).__pat.project()!.views);
  const near = (a: View, b: { centre: Pt; scale: number; rotation: number }) =>
    Math.abs(a.cx - b.centre.x) < 1e-6 &&
    Math.abs(a.cy - b.centre.y) < 1e-6 &&
    Math.abs(a.scale / b.scale - 1) < 1e-9 &&
    Math.abs(a.rotation - b.rotation) < 1e-12;

  // Save the bund area, rotated 90°.
  await zoomAround(page, { x: 600_227, y: 2_500_150 }, 60);
  await page.keyboard.press('Alt+[');
  const bund = await getView(page);
  await palette(page, 'Save current view');
  const name = page.getByRole('dialog').getByLabel('Name');
  await name.fill('Bund');
  await name.press('Enter');
  await expect.poll(async () => (await views()).map((v) => v.name)).toEqual(['Bund']);

  // Elsewhere, then back through the palette.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Home');
  expect(near(await getView(page), (await views())[0])).toBe(false);
  await palette(page, 'Go to view “Bund”');
  await expect.poll(async () => near(await getView(page), (await views())[0])).toBe(true);
  expect(near(bund, (await views())[0])).toBe(true);

  // Manage: rename, update to the current view, delete; then undo the delete.
  await palette(page, 'Saved views');
  const dialog = page.getByTestId('saved-views-dialog');
  await expect(dialog.getByTestId('saved-view-row')).toHaveCount(1);
  await expect(dialog.getByTestId('saved-view-row')).toContainText('90°');
  await dialog.getByRole('button', { name: 'Rename view Bund' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename view' }).getByLabel('Name');
  await rename.fill('Tank farm');
  await rename.press('Enter');
  await expect(rename).toBeHidden();
  await expect(dialog.getByTestId('saved-view-row')).toContainText('Tank farm');
  const close = async () => {
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog).toBeHidden();
  };
  await close();

  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Home');
  const extents = await getView(page);
  await palette(page, 'Saved views');
  await dialog.getByRole('button', { name: 'Update view Tank farm to the current view' }).click();
  await expect.poll(async () => near(extents, (await views())[0])).toBe(true);

  await dialog.getByRole('button', { name: 'Delete view Tank farm' }).click();
  await page
    .getByRole('dialog', { name: 'Delete view “Tank farm”?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(dialog.getByText('No saved views yet')).toBeVisible();
  expect(await views()).toEqual([]);
  await close();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await views()).map((v) => v.name)).toEqual(['Tank farm']);

  // Kept with the project: reopen it after a reload and go to the view. Edits older than 1 s are
  // durable (NFR-9); the wait keeps the reload out of that window.
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.locator('[data-ready="true"]')).toBeVisible();
  await page.getByTestId('recent-projects').getByRole('button').first().click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect.poll(async () => (await views()).map((v) => v.name)).toEqual(['Tank farm']);
  await palette(page, 'Go to view “Tank farm”');
  await expect.poll(async () => near(await getView(page), (await views())[0])).toBe(true);
});
