import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/** Bulk contour import (0.8.0, rows 62–74): import routes, mapping, re-binding, grid, validation. */

const FIX = path.resolve('tests/fixtures/tables');
const R4 = 'Radiation 4 kW/m2 (m)';
const R12 = 'Radiation 12.5 kW/m2 (m)';
const R37 = 'Radiation 37.5 kW/m2 (m)';

interface Dataset {
  id: string;
  name: string;
  visible: boolean;
  order: number;
  table: { columns: string[]; rows: (string | number | null)[][] };
  mapping: Record<string, unknown> & { sizeColumns: string[]; label?: string };
  sizeStyles: { column: string; visible: boolean; color: string }[];
  styleRules: { kind: string; column: string; categories?: { value: string; color: string }[] }[];
  labelTemplate: string;
  filter?: string;
  envelope: boolean;
}

interface Ring {
  row: number;
  sizeColumn: string;
  centre: { x: number; y: number };
  r: number;
  label: string;
}

type Hook = {
  rings(id: string): Ring[];
  validation(id: string): { counts: Record<string, number>; issues: { row: number; message: string }[] };
  envelopes(id: string): { sizeColumn: string; area: number }[];
  unionArea(id: string, col: string): number;
  legend(id: string): { entries: { label: string; kind: string }[] };
  ui(): { selection: { ds: string; rows: number[] } | null; hover: { ds: string; row: number } | null };
};

const datasets = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __pat: { project(): { datasets: Dataset[] } } }).__pat.project().datasets,
  );
const rings = (page: Page, id: string) =>
  page.evaluate((i) => (window as unknown as { __patContours: Hook }).__patContours.rings(i), id);
const undoDepth = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __pat: { store(): { history: { undo: unknown[] } } } }).__pat.store().history
        .undo.length,
  );

async function openImport(page: Page) {
  await page.getByRole('tab', { name: 'Data' }).click();
  await page.getByTestId('dataset-import-menu').click();
  await page.getByRole('menuitem', { name: /Import CSV/ }).click();
  await expect(page.getByTestId('import-table-dialog')).toBeVisible();
}

/** Import a fixture through the dialog's file input with the suggested mapping. */
async function importFixture(page: Page, name: string, setup?: () => Promise<void>) {
  await openImport(page);
  await page.getByTestId('table-file-input').setInputFiles(path.join(FIX, name));
  await expect(page.getByTestId('import-preview')).toBeVisible();
  await page.getByTestId('mapping-next').click();
  await expect(page.getByTestId('mapping-editor')).toBeVisible();
  await setup?.();
  await page.getByTestId('import-dataset').click();
  await expect(page.getByTestId('import-table-dialog')).toBeHidden();
}

async function dropFile(page: Page, file: string) {
  const b64 = readFileSync(file).toString('base64');
  await page.evaluate(
    ([data, name]) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name));
      const el = document.querySelector('[data-testid="canvas-container"]')!;
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [b64, path.basename(file)] as const,
  );
}

async function pick(page: Page, testId: string, option: string) {
  await page.getByTestId(testId).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Contours');
});

test('row 62: the same data via CSV, TSV (drag-and-drop), XLSX (File → Import) and clipboard gives identical datasets', async ({
  page,
}) => {
  // CSV through the dialog's file picker.
  await importFixture(page, 'consequences.csv');

  // TSV (UTF-16 "Unicode Text") dropped onto the canvas.
  await dropFile(page, path.join(FIX, 'consequences.tsv'));
  await expect(page.getByTestId('import-table-dialog')).toBeVisible();
  await expect(page.getByTestId('source-kind')).toHaveText('TSV');
  await page.getByTestId('mapping-next').click();
  await page.getByTestId('import-dataset').click();
  await expect(page.getByTestId('import-table-dialog')).toBeHidden();

  // XLSX through File → Import (Ctrl+I): routed by signature to the table dialog, sheet picker shown.
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+i');
  await (await chooser).setFiles(path.join(FIX, 'consequences.xlsx'));
  await expect(page.getByTestId('sheet-picker')).toBeVisible();
  await expect(page.getByTestId('header-row')).toContainText('row 3');
  await expect(page.getByTestId('preview-table')).toContainText('P-101 10 mm leak');
  await page.getByTestId('mapping-next').click();
  await page.getByTestId('import-dataset').click();
  await expect(page.getByTestId('import-table-dialog')).toBeHidden();

  // A copied Excel range pasted into the dialog (text/plain + text/html flavours).
  await page.getByTestId('dataset-import-menu').click();
  await page.getByRole('menuitem', { name: /Paste/ }).click();
  const text = readFileSync(path.join(FIX, 'consequences-clipboard.txt'), 'utf8');
  const html = readFileSync(path.join(FIX, 'consequences-clipboard.html'), 'utf8');
  await page.getByTestId('paste-target').focus();
  await page.evaluate(
    ([t, h]) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      dt.setData('text/html', h);
      document
        .querySelector('[data-testid="paste-target"]')!
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [text, html] as const,
  );
  await expect(page.getByTestId('source-kind')).toHaveText('CLIPBOARD');
  await page.getByTestId('mapping-next').click();
  await page.getByTestId('import-dataset').click();
  await expect(page.getByTestId('import-table-dialog')).toBeHidden();

  const ds = await datasets(page);
  expect(ds).toHaveLength(4);
  expect(ds[0].table.rows).toHaveLength(30);
  expect(ds[0].table.rows[0][8]).toBe('حريق نفاث عند P-101');
  for (const d of ds.slice(1)) {
    expect(d.table).toEqual(ds[0].table);
    expect(d.mapping).toEqual(ds[0].mapping);
    expect(d.sizeStyles.map((s) => s.column)).toEqual(ds[0].sizeStyles.map((s) => s.column));
  }
  expect(ds[0].mapping.sizeColumns).toEqual([R4, R12, R37]);
  // Each import is one undo step.
  expect(await undoDepth(page)).toBe(4);
});

test('row 63: the mapping dialog prevents saving with a required role unmapped', async ({ page }) => {
  await openImport(page);
  await page.getByTestId('table-file-input').setInputFiles(path.join(FIX, 'consequences.csv'));
  await page.getByTestId('mapping-next').click();
  const save = page.getByTestId('import-dataset');
  await expect(save).toBeEnabled();
  // Remove every size column.
  const sizes = page.getByTestId('map-sizes');
  for (const c of [R4, R12, R37]) await sizes.getByLabel(c, { exact: true }).click();
  await expect(save).toBeDisabled();
  await expect(page.getByTestId('mapping-errors')).toContainText('Map at least one size column.');
  await sizes.getByLabel(R4, { exact: true }).click();
  await expect(save).toBeEnabled();
  // Unmap X.
  await pick(page, 'map-x', '— None —');
  await expect(save).toBeDisabled();
  await expect(page.getByTestId('mapping-errors')).toContainText('Map the X column.');
  // Anchor mode needs the anchor column only.
  await page.getByTestId('mode-anchor').click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect
    .poll(async () => (await datasets(page))[0]?.mapping.position)
    .toMatchObject({
      mode: 'anchor',
      anchor: 'Tag',
    });
});

test('row 64: a row referencing anchor "P-101" draws its contour on P-101; unmatched anchors are listed', async ({
  page,
}) => {
  // Place anchor P-101 with typed coordinates.
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByTestId('anchor-place').click();
  await page.getByTestId('canvas').focus();
  for (const ch of '250,300') await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
  await page.getByLabel('Anchor name').fill('P-101');
  await page.getByRole('button', { name: 'OK' }).click();
  await page.keyboard.press('Escape');

  await importFixture(page, 'consequences.csv', async () => {
    await page.getByTestId('mode-anchor').click();
    await expect(page.getByTestId('mapping-unmatched')).toContainText('V-201');
  });
  const [ds] = await datasets(page);
  const rs = await rings(page, ds.id);
  const p101Rows = ds.table.rows.flatMap((r, i) => (r[0] === 'P-101' ? [i] : []));
  expect(p101Rows.length).toBe(3);
  expect(rs.length).toBeGreaterThan(0);
  expect(new Set(rs.map((r) => r.row))).toEqual(new Set(p101Rows));
  for (const r of rs) expect(r.centre).toEqual({ x: 250, y: 300 });
  await page.getByTestId('tab-issues').click();
  await expect(page.getByTestId('unmatched-anchors')).toContainText('V-201');
  await expect(page.getByTestId('unmatched-anchors')).toContainText('C-401');
});

test('row 65: toggling a size column shows/hides that ring set only', async ({ page }) => {
  await importFixture(page, 'consequences.csv');
  const [ds] = await datasets(page);
  const count = async () => {
    const rs = await rings(page, ds.id);
    return [R4, R12, R37].map((c) => rs.filter((r) => r.sizeColumn === c).length);
  };
  const before = await count();
  expect(before).toEqual([30, 30, 27]);
  await page.getByLabel(`Show rings for ${R12}`).click();
  await expect.poll(count).toEqual([30, 0, 27]);
  await page.getByLabel(`Show rings for ${R12}`).click();
  await expect.poll(count).toEqual(before);
  // Legend entries follow the displayed ring sets.
  await page.getByLabel(`Show rings for ${R37}`).click();
  const legend = await page.evaluate(
    (id) =>
      (window as unknown as { __patContours: Hook }).__patContours.legend(id).entries.map((e) => e.label),
    ds.id,
  );
  expect(legend).toEqual([R4, R12]);
});

test('rows 66, 70: changing the label column updates every label in one undo step', async ({ page }) => {
  await importFixture(page, 'consequences.csv');
  const [ds] = await datasets(page);
  const labels = async () => (await rings(page, ds.id)).filter((r) => r.label).map((r) => [r.row, r.label]);
  const before = await labels();
  expect(before).toHaveLength(30); // one label per row, on its outermost ring
  expect(before[0]).toEqual([0, 'P-101 10 mm leak']);
  const depth = await undoDepth(page);
  await pick(page, 'bind-label', 'Tag');
  await expect.poll(labels).toEqual(before.map(([row]) => [row, ds.table.rows[row as number][0]]));
  expect(await undoDepth(page)).toBe(depth + 1);
  // Radius/diameter and units re-bind every contour without remapping.
  const r0 = (await rings(page, ds.id))[0].r;
  await page.getByTestId('bind-diameter').click();
  await expect.poll(async () => (await rings(page, ds.id))[0].r).toBeCloseTo(r0 / 2, 9);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(labels).toEqual(before);
});

test('row 68: editing a radius cell updates its contour immediately; rows and contours cross-highlight', async ({
  page,
}) => {
  await importFixture(page, 'consequences.csv');
  const [ds] = await datasets(page);
  await page.getByTestId('tab-rows').click();
  const grid = page.getByTestId('data-grid');
  const cell = grid.locator('tr[data-row="0"] td[data-col="5"]');
  await expect(cell).toHaveText('31');
  await cell.dblclick();
  await page.getByLabel(`Edit ${R4} of row 1`).fill('55.5');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await rings(page, ds.id)).find((r) => r.row === 0 && r.sizeColumn === R4)?.r)
    .toBe(55.5);
  expect((await datasets(page))[0].table.rows[0][5]).toBe(55.5);

  // Grid → canvas: hovering and selecting a row highlights its contour.
  await grid.locator('tr[data-row="2"] td[data-col="1"]').hover();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __patContours: Hook }).__patContours.ui().hover))
    .toEqual({ ds: ds.id, row: 2 });
  await grid.locator('tr[data-row="2"] td[data-col="1"]').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __patContours: Hook }).__patContours.ui().selection),
    )
    .toEqual({ ds: ds.id, rows: [2] });

  // Canvas → grid: clicking a ring outline selects its row.
  const ring = (await rings(page, ds.id)).find((r) => r.row === 7 && r.sizeColumn === R4)!;
  const at = await page.evaluate(
    ({ c, r }) => {
      const ctl = (
        window as unknown as {
          __patCanvas: { frame(): { toScreen(p: { x: number; y: number }): { x: number; y: number } } };
        }
      ).__patCanvas;
      return ctl.frame().toScreen({ x: c.x + r, y: c.y });
    },
    { c: ring.centre, r: ring.r },
  );
  const box = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.click(box.x + at.x, box.y + at.y);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __patContours: Hook }).__patContours.ui().selection),
    )
    .toEqual({ ds: ds.id, rows: [7] });
  await expect(grid.locator('tr[data-row="7"]')).toHaveAttribute('aria-selected', 'true');

  // Add and delete rows.
  await page.getByTestId('grid-add-row').click();
  await expect.poll(async () => (await datasets(page))[0].table.rows.length).toBe(31);
  await page.getByTestId('grid-delete-rows').click();
  await expect.poll(async () => (await datasets(page))[0].table.rows.length).toBe(30);
});

test('row 69: a table with deliberate errors reports each one by row number', async ({ page }) => {
  await importFixture(page, 'consequences-errors.csv');
  const [ds] = await datasets(page);
  await expect(page.getByTestId('dataset-badge')).toContainText('5/11');
  await page.getByTestId('tab-issues').click();
  const table = page.getByTestId('issues-table');
  const expectIssue = async (row: number, text: string) =>
    expect(table.locator(`tr[data-row="${row}"]`).filter({ hasText: text })).toHaveCount(1);
  await expectIssue(2, 'Missing X coordinate');
  await expectIssue(3, 'Y coordinate "abc" is not a number');
  await expectIssue(4, 'Size is negative (-5)');
  await expectIssue(5, 'Size "twelve" is not a number');
  await expectIssue(6, 'Size is zero');
  await expectIssue(10, 'No size value');
  // Anchor mode: unknown and missing anchors are reported by row number too.
  await page.evaluate(() => {
    const w = window as unknown as {
      __pat: { store(): { commit(l: string, r: (d: { anchors: unknown[] }) => void): boolean } };
    };
    w.__pat.store().commit('anchors', (d) => {
      for (const n of ['P-101', 'P-102', 'P-103', 'P-104', 'P-105', 'P-106', 'P-107', 'P-110', 'P-111'])
        d.anchors.push({ id: n, name: n, p: { x: 0, y: 0 } });
    });
  });
  await page.getByRole('button', { name: `Dataset options for ${ds.name}` }).click();
  await page.getByRole('menuitem', { name: /Edit column mapping/ }).click();
  await page.getByTestId('edit-mapping-dialog').getByTestId('mode-anchor').click();
  await page.getByTestId('save-mapping').click();
  await expectIssue(8, 'Unknown anchor "P-999"');
  await expectIssue(9, 'Missing anchor name');
  const v = await page.evaluate(
    (id) => (window as unknown as { __patContours: Hook }).__patContours.validation(id),
    ds.id,
  );
  expect(v.issues.filter((i) => i.message.includes('anchor')).map((i) => i.row)).toEqual([8, 9]);
});

test('row 71: datasets have visibility, draw order and live filters reflected in the legend', async ({
  page,
}) => {
  await importFixture(page, 'consequences.csv');
  await importFixture(page, 'consequences-errors.csv');
  let ds = await datasets(page);
  expect(ds[1].order).toBeGreaterThan(ds[0].order);
  await page.getByRole('button', { name: `Hide dataset ${ds[1].name}` }).click();
  await expect.poll(async () => (await datasets(page))[1].visible).toBe(false);
  await page.getByRole('button', { name: `Dataset options for ${ds[1].name}` }).click();
  await page.getByRole('menuitem', { name: /Move down/ }).click();
  await expect
    .poll(async () => (await datasets(page))[1].order)
    .toBeLessThan((await datasets(page))[0].order);

  // Live filter on the first dataset.
  await page.getByRole('button', { name: ds[0].name, exact: true }).click();
  await page.getByTestId('dataset-filter').fill('category = "Jet fire" AND radius > 40');
  await expect
    .poll(async () => new Set((await rings(page, ds[0].id)).map((r) => r.row)).size)
    .toBe(ds[0].table.rows.filter((r) => r[2] === 'Jet fire' && (r[5] as number) > 40).length);
  ds = await datasets(page);
  expect(ds[0].filter).toBe('category = "Jet fire" AND radius > 40');
  // The legend reflects the filter: colour by category lists only the categories drawn.
  await page.getByRole('tab', { name: 'Style' }).click();
  await pick(page, 'colour-by', 'Category (palette)');
  const legend = () =>
    page.evaluate(
      (id) =>
        (window as unknown as { __patContours: Hook }).__patContours
          .legend(id)
          .entries.filter((e) => e.kind === 'rule')
          .map((e) => e.label),
      ds[0].id,
    );
  await expect.poll(legend).toEqual(['Jet fire']);
  await page.getByTestId('dataset-filter').fill('');
  await expect.poll(legend).toEqual(['Jet fire', 'Pool fire', 'Flash fire', 'Fireball']);
  // An invalid expression is reported and not applied.
  await page.getByTestId('dataset-filter').fill('category = ');
  await expect(page.getByTestId('filter-error')).toBeVisible();
  expect((await datasets(page))[0].filter).toBeUndefined();
});

test('row 72: re-import of an updated file needs no remapping and summarises the changes', async ({
  page,
}, info) => {
  await importFixture(page, 'consequences.csv');
  const [before] = await datasets(page);
  // An updated results file: one radius changed, the last row removed, one row added.
  const rows = before.table.rows.map((r) => [...r]);
  rows[0][5] = 35;
  rows.pop();
  rows.push(['X-900', 'X-900 new', 'Jet fire', 10, 10, 20, 12, 6, null, null]);
  const q = (v: string | number | null) => (v === null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const csv = [before.table.columns, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
  const file = info.outputPath('results-v2.csv');
  writeFileSync(file, csv);

  await page.getByRole('button', { name: `Dataset options for ${before.name}` }).click();
  await page.getByRole('menuitem', { name: /Re-import data/ }).click();
  await page.getByTestId('table-file-input').setInputFiles(file);
  await expect(page.getByTestId('reimport-next')).toHaveText('Next: review changes');
  await page.getByTestId('reimport-next').click();
  await expect(page.getByTestId('reimport-summary')).toContainText('no remapping needed');
  await expect(page.getByTestId('diff-added')).toHaveText('1 added');
  await expect(page.getByTestId('diff-removed')).toHaveText('1 removed');
  await expect(page.getByTestId('diff-changed')).toHaveText('1 changed');
  await page.getByTestId('reimport-apply').click();
  await expect(page.getByTestId('import-table-dialog')).toBeHidden();
  const [after] = await datasets(page);
  expect(after.id).toBe(before.id);
  expect(after.mapping).toEqual(before.mapping);
  expect(after.sizeStyles).toEqual(before.sizeStyles);
  expect(after.table.rows.find((r) => r[0] === 'P-101')![5]).toBe(35);
  expect(after.table.rows.some((r) => r[0] === 'X-900')).toBe(true);
});

test('row 73: a mapping template saved once applies in one click to a file with known headers', async ({
  page,
}) => {
  await importFixture(page, 'consequences.csv');
  const [first] = await datasets(page);
  // Customise: label template, a categorical style rule and anchor-free mapping stays.
  await page.getByLabel('Label template').fill('{label} – {radius:0} m');
  await page.getByLabel('Label template').press('Enter');
  await page.getByRole('tab', { name: 'Style' }).click();
  await pick(page, 'colour-by', 'Category (palette)');
  await page.getByRole('button', { name: `Dataset options for ${first.name}` }).click();
  await page.getByRole('menuitem', { name: /Save as mapping template/ }).click();
  await page.getByLabel('Template name').fill('Consequence results');
  await page.getByRole('button', { name: 'OK' }).click();

  // Importing a file with the same headers offers the template; one click imports with it.
  await openImport(page);
  await page.getByTestId('table-file-input').setInputFiles(path.join(FIX, 'consequences-semicolon.csv'));
  await page.getByTestId('import-with-template').click();
  await expect(page.getByTestId('import-table-dialog')).toBeHidden();
  const [a, b] = await datasets(page);
  expect(b.mapping).toEqual(a.mapping);
  expect(b.labelTemplate).toBe('{label} – {radius:0} m');
  expect(b.styleRules[0]).toMatchObject({ kind: 'categorical', column: 'Category' });
  expect(b.styleRules[0].categories).toEqual(a.styleRules[0].categories);
  expect(b.sizeStyles).toEqual(a.sizeStyles);
});

test('row 74: envelope area equals the boolean union area of the visible rings', async ({ page }) => {
  await importFixture(page, 'consequences.csv');
  const [ds] = await datasets(page);
  await page.getByTestId('envelope-switch').click();
  await expect(page.getByTestId('envelope-areas')).toBeVisible();
  const env = await page.evaluate(
    (id) => (window as unknown as { __patContours: Hook }).__patContours.envelopes(id),
    ds.id,
  );
  expect(env.map((e) => e.sizeColumn)).toEqual([R4, R12, R37]);
  for (const e of env) {
    const union = await page.evaluate(
      ([id, col]) => (window as unknown as { __patContours: Hook }).__patContours.unionArea(id, col),
      [ds.id, e.sizeColumn] as const,
    );
    expect(Math.abs(e.area - union)).toBeLessThan(1e-6 * union);
    expect(e.area).toBeGreaterThan(0);
  }
  const legend = await page.evaluate(
    (id) => (window as unknown as { __patContours: Hook }).__patContours.legend(id).entries,
    ds.id,
  );
  expect(legend.filter((e) => e.kind === 'envelope')).toHaveLength(3);
});

test('C7 / row 93: an open import dialog is saved as a draft and resumes after a reload', async ({
  page,
}) => {
  await openImport(page);
  await page.getByTestId('table-file-input').setInputFiles(path.join(FIX, 'consequences.csv'));
  await page.getByTestId('mapping-next').click();
  await pick(page, 'map-label', 'Tag');
  await page.waitForTimeout(1200); // drafts are written within 1 s
  await page.reload();
  await expect(page.locator('[data-ready="true"]')).toBeVisible();
  await page.getByTestId('recent-projects').getByRole('button').first().click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByTestId('mapping-editor')).toBeVisible();
  await expect(page.getByTestId('map-label')).toHaveText('Tag');
  await page.getByTestId('import-dataset').click();
  await expect.poll(async () => (await datasets(page))[0]?.mapping.label).toBe('Tag');
  expect((await datasets(page))[0].table.rows).toHaveLength(30);
});
