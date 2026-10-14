import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/** Offsets (0.7.0, rows 55–61). */

interface Vertex {
  x: number;
  y: number;
  bulge?: number;
}
interface Obj {
  id: string;
  name: string;
  kind: string;
  layerId: string;
  style: Record<string, unknown>;
  label?: { template: string; visible: boolean };
  attributes: Record<string, string | number>;
  derived?: { sourceId: string; distance: number; join: string; ringGroup?: string };
  geometry: {
    type: string;
    c?: { x: number; y: number };
    r?: number;
    w?: number;
    h?: number;
    pts?: Vertex[];
    closed?: boolean;
    rings?: Vertex[][];
  };
}

type W = {
  __pat: {
    project(): { objects: Obj[]; chordTolerance: number } | null;
    store(): { history: { undo: { label: string }[] } };
  };
  __patCanvas: {
    overlayCanvas: HTMLCanvasElement;
    zoomExtents(): void;
    frame(): { toScreen(p: { x: number; y: number }): { x: number; y: number } };
  };
};

const objects = (page: Page) => page.evaluate(() => (window as unknown as W).__pat.project()?.objects ?? []);
const undoLabels = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__pat.store().history.undo.map((e) => e.label));

async function at(page: Page, x: number, y: number) {
  return page.evaluate(
    ([wx, wy]) => {
      const c = (window as unknown as W).__patCanvas;
      const r = c.overlayCanvas.getBoundingClientRect();
      const s = c.frame().toScreen({ x: wx, y: wy });
      return { x: r.left + s.x, y: r.top + s.y };
    },
    [x, y] as const,
  );
}

async function typeOnCanvas(page: Page, text: string) {
  for (const ch of text) await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
}

async function canvasFocus(page: Page) {
  await page.keyboard.press('Escape');
  await page.getByTestId('canvas').focus();
}

async function drawCircle(page: Page, c: string, r: string) {
  await canvasFocus(page);
  await page.keyboard.press('c');
  await typeOnCanvas(page, c);
  await typeOnCanvas(page, r);
}

async function drawPolygon(page: Page, pts: string[]) {
  await canvasFocus(page);
  await page.keyboard.press('g');
  for (const p of pts) await typeOnCanvas(page, p);
  await page.keyboard.press('Enter');
}

async function zoomExtents(page: Page) {
  await page.evaluate(() => (window as unknown as W).__patCanvas.zoomExtents());
  await page.waitForTimeout(100);
}

/** Offsets the current selection through the dialog. */
async function offset(page: Page, distance: string, opts: { merge?: boolean; join?: string } = {}) {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('o');
  const dialog = page.getByTestId('offset-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('offset-distance').fill(distance);
  if (opts.join) {
    await dialog.getByLabel('Corner style').click();
    await page.getByRole('option', { name: opts.join }).click();
  }
  if (opts.merge) await dialog.getByLabel('Merge overlapping results into one envelope').check();
  await page.getByTestId('offset-apply').click();
}

/** Area of a closed bulge polyline (shoelace + circular segments). */
function bulgeArea(pts: Vertex[]): number {
  let a = 0;
  const o = pts[0];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += ((p.x - o.x) * (q.y - o.y) - (q.x - o.x) * (p.y - o.y)) / 2;
    if (p.bulge) {
      const th = 4 * Math.atan(p.bulge);
      const chord = Math.hypot(q.x - p.x, q.y - p.y);
      const r = chord / (2 * Math.abs(Math.sin(th / 2)));
      a += ((r * r) / 2) * (th - Math.sin(th));
    }
  }
  return Math.abs(a);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Offsets');
});

test('circle offset is exact; contraction to r ≤ 0 is rejected with a message (row 55)', async ({ page }) => {
  await drawCircle(page, '612345.125,2534210.5', '12.5');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  await offset(page, '7.5');
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  const [src, off] = await objects(page);
  expect(off.kind).toBe('offset');
  expect(off.geometry).toEqual({ type: 'circle', c: { x: 612345.125, y: 2534210.5 }, r: 20 });
  expect(off.derived).toMatchObject({ sourceId: src.id, distance: 7.5, join: 'round' });
  expect(off.attributes.offset).toBe('+7.5 m');
  // Contraction to r ≤ 0 is refused. (Select the source by its outline, under the offset's fill.)
  await zoomExtents(page);
  await canvasFocus(page);
  const edge = await at(page, 612345.125 + 12.5, 2534210.5);
  await page.mouse.click(edge.x, edge.y);
  await expect(page.getByTestId('selection-properties')).toContainText('Circle 1');
  await offset(page, '-12.5');
  await expect(page.getByText('Contraction removes the circle (r ≤ 0)').first()).toBeVisible();
  expect(await objects(page)).toHaveLength(2);
});

test('rectangle offsets: round = exact Minkowski sum (default), mitre = square box (row 56)', async ({
  page,
}) => {
  await canvasFocus(page);
  await page.keyboard.press('r');
  await typeOnCanvas(page, '0,0');
  await typeOnCanvas(page, '40,25');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  await offset(page, '5');
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  const round = (await objects(page))[1];
  expect(round.geometry.type).toBe('polyline');
  expect(bulgeArea(round.geometry.pts!)).toBeCloseTo(40 * 25 + 2 * 5 * 65 + Math.PI * 25, 6);
  await zoomExtents(page);
  await canvasFocus(page);
  const p = await at(page, 20, 0);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('selection-properties')).toContainText('Rectangle 1');
  await offset(page, '5', { join: 'Mitre — square corners' });
  await expect.poll(async () => (await objects(page)).length).toBe(3);
  expect((await objects(page))[2].geometry).toMatchObject({
    type: 'rect',
    c: { x: 20, y: 12.5 },
    w: 50,
    h: 35,
  });
});

test('live offset follows a moved source vertex in one undo step; distance edit; Detach (row 59)', async ({
  page,
}) => {
  await drawPolygon(page, ['0,0', '40,0', '40,20', '0,20']);
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  await offset(page, '5');
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  await zoomExtents(page);
  const [src, off] = await objects(page);
  const maxX = (o: Obj) => Math.max(...o.geometry.pts!.map((v) => v.x));
  expect(maxX(off)).toBeCloseTo(45, 9);

  // Select the source by its outline (its offset is drawn on top) and drag the vertex grip (40, 20).
  await canvasFocus(page);
  const edge = await at(page, 20, 0);
  await page.mouse.click(edge.x, edge.y);
  await expect(page.getByTestId('selection-properties')).toContainText(src.name);
  const from = await at(page, 40, 20);
  const to = await at(page, 60, 30);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => maxX((await objects(page))[1])).toBeGreaterThan(64);
  const moved = (await objects(page))[0].geometry.pts![2];
  // Offset stays 5 m outside the moved vertex (round join), and is still live.
  const live = (await objects(page))[1];
  // (the round join is tessellated with vertices on the arc, within the 5 mm chord tolerance).
  expect(maxX(live)).toBeLessThanOrEqual(moved.x + 5 + 1e-9);
  expect(maxX(live)).toBeGreaterThan(moved.x + 5 - 0.005);
  expect(live.derived?.sourceId).toBe(src.id);
  expect((await undoLabels(page)).at(-1)).toBe('Edit shape');
  // One undo restores source and offset together.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => maxX((await objects(page))[1])).toBeCloseTo(45, 9);
  expect((await objects(page))[0].geometry.pts![2]).toEqual({ x: 40, y: 20 });

  // Editing the distance in Properties recomputes the offset instantly.
  await canvasFocus(page);
  const offEdge = await at(page, 20, -5);
  await page.mouse.click(offEdge.x, offEdge.y);
  const section = page.getByTestId('offset-section');
  await expect(section).toBeVisible();
  await section.getByLabel('Offset distance').fill('10');
  await section.getByLabel('Offset distance').press('Enter');
  await expect.poll(async () => maxX((await objects(page))[1])).toBeCloseTo(50, 9);
  expect((await objects(page))[1].attributes.offset).toBe('+10 m');
  // Detach → static geometry, no longer follows the source.
  await page.getByTestId('offset-detach').click();
  await expect.poll(async () => (await objects(page))[1].derived).toBeUndefined();
  await expect(section).toContainText('Static');
});

test('multi-ring offset: one layer, one ring group, labelled and ramp-coloured (row 58)', async ({
  page,
}) => {
  await drawCircle(page, '100,200', '15');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  await page.getByRole('menubar').getByText('Offset').click();
  await page.getByRole('menuitem', { name: 'Multi-ring offset…' }).click();
  await expect(page.getByTestId('offset-dialog')).toBeVisible();
  await page.getByTestId('ring-distances').fill('10, 25, 50');
  await expect(page.getByTestId('ring-preview')).toContainText('+50 m');
  await page.getByTestId('offset-apply').click();
  await expect.poll(async () => (await objects(page)).length).toBe(4);
  const [src, ...rings] = await objects(page);
  expect(rings.map((r) => r.geometry.r)).toEqual([65, 40, 25]);
  expect(new Set(rings.map((r) => r.layerId))).toEqual(new Set([src.layerId]));
  expect(new Set(rings.map((r) => r.derived?.ringGroup)).size).toBe(1);
  expect(rings[0].derived?.ringGroup).toBeTruthy();
  expect(rings.map((r) => r.attributes.offset)).toEqual(['+50 m', '+25 m', '+10 m']);
  expect(rings.every((r) => r.label?.template === '{offset}' && r.label.visible)).toBe(true);
  expect(new Set(rings.map((r) => r.style.stroke)).size).toBe(3);
  expect((await undoLabels(page)).at(-1)).toBe('Multi-ring offset (3 rings)');
});

test('batch offset merged into one envelope: area equals the union area (row 60)', async ({ page }) => {
  await drawCircle(page, '0,0', '10');
  await drawCircle(page, '15,0', '10');
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  await canvasFocus(page);
  await page.keyboard.press('Control+a');
  await offset(page, '5', { merge: true });
  await expect.poll(async () => (await objects(page)).length).toBe(3);
  const env = (await objects(page))[2];
  expect(env.kind).toBe('offset');
  expect(env.derived).toBeUndefined();
  expect(env.geometry).toMatchObject({ type: 'polyline', closed: true });
  // Union of two discs r = 15 at 15 m: 2πr² − lens.
  const r = 15;
  const d = 15;
  const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
  const union = 2 * Math.PI * r * r - lens;
  const chordTol = (await page.evaluate(
    () => (window as unknown as W).__pat.project()!.chordTolerance,
  )) as number;
  // Vertices lie on the circles: the polygon is inside the true union by at most chordTol × perimeter.
  expect(Math.abs(bulgeArea(env.geometry.pts!) - union)).toBeLessThan(chordTol * 2 * 2 * Math.PI * r);
});

test('chord tolerance setting recomputes live offsets (row 61)', async ({ page }) => {
  await drawPolygon(page, ['0,0', '40,0', '40,20', '0,20']);
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  await offset(page, '5');
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  const coarse = (await objects(page))[1].geometry.pts!.length;
  await page.getByRole('menubar').getByText('Offset').click();
  await page.getByRole('menuitem', { name: 'Chord tolerance…' }).click();
  await page.getByLabel('Chord tolerance (mm)').fill('1');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__pat.project()!.chordTolerance))
    .toBeCloseTo(0.001, 12);
  await expect.poll(async () => (await objects(page))[1].geometry.pts!.length).toBeGreaterThan(coarse);
});
