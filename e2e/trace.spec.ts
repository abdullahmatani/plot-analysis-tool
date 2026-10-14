import path from 'node:path';
import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/** Tracing (0.6.0, rows 49–54) on the reference DXF fixtures. */

interface Vertex {
  x: number;
  y: number;
  bulge?: number;
}
interface Obj {
  id: string;
  kind: string;
  layerId: string;
  geometry: {
    type: string;
    c?: { x: number; y: number };
    r?: number;
    pts?: Vertex[];
    closed?: boolean;
    rings?: Vertex[][];
  };
}

const FIXTURES = path.resolve('tests/fixtures/dxf');
const X0 = 600000;
const Y0 = 2500000;

const objects = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __pat: { project(): { objects: Obj[] } | null } }).__pat.project()?.objects ??
      [],
  );

async function importDxf(page: Page, file: string) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+i')]);
  await chooser.setFiles(path.join(FIXTURES, file));
  await expect(page.getByText(`Imported “${file}”`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('canvas').focus();
}

/** Page coordinates of a world point. */
async function at(page: Page, x: number, y: number) {
  return page.evaluate(
    ([wx, wy]) => {
      const c = (
        window as unknown as {
          __patCanvas: {
            overlayCanvas: HTMLCanvasElement;
            frame(): { toScreen(p: { x: number; y: number }): { x: number; y: number } };
          };
        }
      ).__patCanvas;
      const r = c.overlayCanvas.getBoundingClientRect();
      const s = c.frame().toScreen({ x: wx, y: wy });
      return { x: r.left + s.x, y: r.top + s.y };
    },
    [x, y] as const,
  );
}

async function clickWorld(page: Page, x: number, y: number, dx = 0, dy = 0) {
  const p = await at(page, x, y);
  await page.mouse.move(p.x + dx, p.y + dy);
  await page.mouse.click(p.x + dx, p.y + dy);
}

async function typeOnCanvas(page: Page, text: string) {
  for (const ch of text) await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
}

const P = (x: number, y: number) => ({ x: X0 + x, y: Y0 + y });

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Tracing');
});

test('pick-trace: a picked circle has the source centre and radius exactly (row 50)', async ({ page }) => {
  await importDxf(page, 'r12_entities.dxf');
  await page.keyboard.press('Shift+T');
  await expect(page.getByTestId('tool-hint')).toContainText('Pick-trace');
  await clickWorld(page, 62.5, 50);
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  const [o] = await objects(page);
  expect(o.kind).toBe('trace');
  // Source: CIRCLE handle 96 at (50, 50), r 12.5 (tests/fixtures/dxf/expectations.json).
  expect(o.geometry).toEqual({ type: 'circle', c: { x: 50, y: 50 }, r: 12.5 });
});

test('pick-trace keeps UTM circles and hatch boundaries exact (row 50)', async ({ page }) => {
  await importDxf(page, 'r2018_trace_site.dxf');
  await page.keyboard.press('Shift+T');
  await clickWorld(page, X0 + 35.125 + 12.5, Y0 + 80.375);
  await clickWorld(page, X0 + 85, Y0 + 66);
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  const [circle, hatch] = await objects(page);
  expect(circle.geometry).toEqual({ type: 'circle', c: P(35.125, 80.375), r: 12.5 });
  expect(hatch.geometry.closed).toBe(true);
  expect(hatch.geometry.pts).toEqual([P(70, 60), P(100, 60), { ...P(100, 75), bulge: 0.4 }, P(70, 75)]);
});

test('chain trace: a building drawn as separate lines becomes one closed polygon (row 51)', async ({
  page,
}) => {
  await importDxf(page, 'r2018_trace_site.dxf');
  await page.keyboard.press('Shift+C');
  await clickWorld(page, X0 + 10, Y0 + 25);
  // The partition wall makes a junction: Tab cycles the direction, Enter follows it.
  const hint = page.getByTestId('tool-hint');
  await expect(hint).toContainText('Junction (1/2)');
  await page.keyboard.press('Tab');
  await expect(hint).toContainText('Junction (2/2)');
  await page.keyboard.press('Tab');
  await expect(hint).toContainText('Junction (1/2)');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  const [o] = await objects(page);
  expect(o.kind).toBe('trace');
  expect(o.geometry.closed).toBe(true);
  expect(o.geometry.pts).toHaveLength(6);
  for (const c of [P(10, 10), P(50, 10), P(50, 25), P(35, 25), P(35, 40), P(10, 40)])
    expect(o.geometry.pts).toContainEqual(c);

  // A rectangle of four lines with 5 cm corner gaps closes in one click, with exact corners.
  await clickWorld(page, X0 + 85, Y0 + 10);
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  const b = (await objects(page))[1];
  expect(b.geometry.closed).toBe(true);
  for (const c of [P(70, 10), P(100, 10), P(100, 30), P(70, 30)]) expect(b.geometry.pts).toContainEqual(c);
});

test('boundary pick inside a bunded area returns the bund outline (row 52)', async ({ page }) => {
  await importDxf(page, 'r2018_trace_site.dxf');
  await page.keyboard.press('b');
  await expect(page.getByTestId('tool-hint')).toContainText('Boundary pick');
  await clickWorld(page, X0 + 13, Y0 + 63);
  await expect.poll(async () => (await objects(page)).length, { timeout: 20_000 }).toBe(1);
  const [o] = await objects(page);
  expect(o.geometry.type).toBe('multipolygon');
  const [outer, hole] = o.geometry.rings!;
  expect(outer).toHaveLength(4);
  for (const c of [P(10, 60), P(60, 60), P(60, 100), P(10, 100)]) expect(outer).toContainEqual(c);
  // The tank inside the bund is an island (hole) with its exact radius.
  for (const v of hole) expect(Math.hypot(v.x - (X0 + 35.125), v.y - (Y0 + 80.375))).toBeCloseTo(12.5, 6);
  // Islands off → the bund outline alone.
  await page.getByRole('menubar').getByText('Trace').click();
  await page.getByRole('menuitemcheckbox', { name: /detect islands/i }).click();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('b');
  await clickWorld(page, X0 + 58, Y0 + 98);
  await expect.poll(async () => (await objects(page)).length, { timeout: 20_000 }).toBe(2);
  expect((await objects(page))[1].geometry).toMatchObject({ type: 'polyline', closed: true });
});

test('manual trace: vertices equal snapped source points; arcs; Backspace; draft saved (row 49)', async ({
  page,
}) => {
  await importDxf(page, 'r2018_trace_site.dxf');
  await page.keyboard.press('t');
  await expect(page.getByTestId('tool-hint')).toContainText('Trace');
  // Endpoints of building B's lines (snapped from a couple of pixels away).
  await clickWorld(page, X0 + 70.05, Y0 + 10, 2, -2);
  await clickWorld(page, X0 + 99.95, Y0 + 10, -2, 2);
  await clickWorld(page, X0 + 85, Y0 + 20); // a wrong click…
  await page.keyboard.press('Backspace'); // …removed again
  await clickWorld(page, X0 + 100, Y0 + 29.95, 2, 1);
  await clickWorld(page, X0 + 70, Y0 + 29.95, -1, 2);
  // In-progress traces are saved as drafts (row 93).
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const w = window as unknown as {
            __pat: {
              db(): { drafts: { toArray(): Promise<{ key: string; state: { points: unknown[] } }[]> } };
            };
          };
          const d = (await w.__pat.db().drafts.toArray()).find((x) => x.key === 'tool:trace.manual');
          return d?.state.points.length ?? 0;
        }),
      { timeout: 5000 },
    )
    .toBe(4);
  await page.keyboard.press('c');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  const [o] = await objects(page);
  expect(o.geometry).toEqual({
    type: 'polyline',
    pts: [P(70.05, 10), P(99.95, 10), P(100, 29.95), P(70, 29.95)],
    closed: true,
  });

  // Straight then tangent arc, typed: the arc continues the line smoothly (quarter circle).
  await page.keyboard.press('t');
  await typeOnCanvas(page, `${X0 + 200},${Y0}`);
  await typeOnCanvas(page, '@10,0');
  await page.keyboard.press('a');
  await expect(page.getByTestId('tool-hint')).toContainText('tangent arc');
  await typeOnCanvas(page, '@10,10');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await objects(page)).length).toBe(2);
  const arc = (await objects(page))[1];
  expect(arc.geometry.closed).toBe(false);
  expect(arc.geometry.pts![1].bulge).toBeCloseTo(Math.tan(Math.PI / 8), 12);
  expect(arc.geometry.pts![2]).toEqual({ x: X0 + 220, y: Y0 + 10 });
});

test('trace editing: simplify within tolerance, "+" grip inserts a vertex, reverse (row 53)', async ({
  page,
}) => {
  await page.getByTestId('canvas').focus();
  // A polyline with near-collinear vertices (deviations 1–3 cm).
  await page.keyboard.press('p');
  for (const pt of ['0,0', '10,0.01', '20,-0.02', '30,0', '40,0.03', '50,0', '50,20'])
    await typeOnCanvas(page, pt);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  const before = (await objects(page))[0].geometry.pts!;
  await page.getByRole('menubar').getByText('Trace').click();
  await page.getByRole('menuitem', { name: 'Simplify…' }).click();
  await page.getByLabel(/Tolerance/).fill('0.025');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => (await objects(page))[0].geometry.pts!.length).toBeLessThan(before.length);
  const after = (await objects(page))[0].geometry.pts!;
  // Kept vertices are untouched input vertices; the 3 cm deviation survives a 2.5 cm tolerance.
  for (const v of after) expect(before).toContainEqual(v);
  expect(after).toContainEqual({ x: 40, y: 0.03 });
  expect(after).not.toContainEqual({ x: 10, y: 0.01 });

  // Reverse keeps the shape.
  await page.getByRole('menubar').getByText('Trace').click();
  await page.getByRole('menuitem', { name: 'Reverse direction' }).click();
  await expect.poll(async () => (await objects(page))[0].geometry.pts![0]).toEqual({ x: 50, y: 20 });

  // Drag the midpoint "+" grip of the last segment (50,0)–(50,20)… now the first: (50,20)–(50,0).
  await page.evaluate(() =>
    (window as unknown as { __patCanvas: { zoomExtents(): void } }).__patCanvas.zoomExtents(),
  );
  const n = (await objects(page))[0].geometry.pts!.length;
  const from = await at(page, 50, 10);
  const to = await at(page, 60, 10);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await objects(page))[0].geometry.pts!.length).toBe(n + 1);
  const ins = (await objects(page))[0].geometry.pts![1];
  expect(ins.x).toBeGreaterThan(55);
});

test('an unfinished manual trace survives a reload and can be resumed (rows 49, 93)', async ({ page }) => {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('t');
  for (const pt of ['0,0', '30,0', '30,20']) await typeOnCanvas(page, pt);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const w = window as unknown as {
          __pat: {
            db(): { drafts: { toArray(): Promise<{ key: string; state: { points: unknown[] } }[]> } };
          };
        };
        return (await w.__pat.db().drafts.toArray()).find((x) => x.key === 'tool:trace.manual')?.state.points
          .length;
      }),
    )
    .toBe(3);
  await page.reload();
  await expect(page.locator('[data-ready="true"]')).toBeVisible();
  await page.getByTestId('recent-projects').getByRole('button').first().click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByText('Unfinished trace recovered')).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.getByTestId('canvas').focus();
  await typeOnCanvas(page, '0,20');
  await page.keyboard.press('c');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  expect((await objects(page))[0].geometry).toEqual({
    type: 'polyline',
    pts: [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 20 },
      { x: 0, y: 20 },
    ],
    closed: true,
  });
});

test('ortho and grid snap constrain manual tracing (row 54)', async ({ page }) => {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('t');
  await typeOnCanvas(page, '0,0');
  await page.keyboard.press('F8'); // ortho
  // A click well off the horizontal is constrained onto it.
  await clickWorld(page, 30, 4);
  await page.keyboard.press('F8');
  await page.keyboard.press('F9'); // grid snap (1 m)
  await clickWorld(page, 30.3, 19.8);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  const pts = (await objects(page))[0].geometry.pts!;
  expect(pts[0]).toEqual({ x: 0, y: 0 });
  expect(pts[1].y).toBe(0);
  expect(pts[1].x).toBeCloseTo(30, 0);
  expect(pts[2]).toEqual({ x: 30, y: 20 });
});

test('raster aids: magnifier loupe and edge contrast toggles (row 54)', async ({ page }) => {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Alt+m');
  await page.getByRole('menubar').getByText('Trace').click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Magnifier loupe' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('menuitemcheckbox', { name: /Edge contrast/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __patCanvas: { renderer: { edgeContrast: number } | null } }).__patCanvas
            .renderer?.edgeContrast,
      ),
    )
    .toBe(1);
});
