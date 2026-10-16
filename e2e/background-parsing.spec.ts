import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/**
 * Background parsing with progress and cancel (row 21): drawings and tables are parsed in Web
 * Workers, so the UI stays usable during a large import, shows its progress, and stops the parse at
 * once when cancelled. Main-thread blocking is measured by the performance suite (NFR-2, NFR-3).
 */

const OUT = path.resolve('test-results', 'background-parsing');

/** The 20 MB synthetic plot plan of the performance suite (parses for a few seconds). */
function largeDxf(): string {
  const file = path.resolve('test-results', 'perf-20mb.dxf');
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    execFileSync(process.execPath, ['scripts/fixtures/make-large-dxf.mjs', file, '20']);
  }
  return file;
}

/** A 200 000-row consequence results table (13 MB of CSV). */
function largeCsv(): string {
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'results-200k.csv');
  if (!existsSync(file)) {
    const lines = ['Tag,Scenario,Category,X,Y,R1,R2,R3,Label,Notes'];
    for (let i = 0; i < 200_000; i++)
      lines.push(
        `P-${i},S${i % 40},Jet fire,${600_000 + (i % 500)},${2_500_000 + Math.floor(i / 500)},${10 + (i % 7)},${20 + (i % 9)},${35 + (i % 5)},Release ${i},note ${i}`,
      );
    writeFileSync(file, lines.join('\n'));
  }
  return file;
}

type Hooks = {
  __pat: {
    project(): { drawings: { id: string; name: string }[] } | null;
    models(): { id: string; status: string; error?: string }[];
  };
};
const drawings = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).__pat.project()?.drawings.length ?? 0);
const models = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__pat.models());

async function chooseFile(page: Page, file: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+i');
  await (await chooser).setFiles(file);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Background parsing');
});

test('a large DXF import shows progress, leaves the UI usable, and Cancel stops it (row 21)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await chooseFile(page, largeDxf());
  const panel = page.getByTestId('import-progress');
  await expect(panel).toBeVisible();
  const bar = panel.getByRole('progressbar');
  await expect
    .poll(async () => Number(await bar.getAttribute('aria-valuenow')), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // The UI keeps working while the drawing is parsed: the command palette opens and filters.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog').getByRole('combobox');
  await palette.fill('Zoom extents');
  await expect(page.getByRole('option', { name: /Zoom extents/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel, 'still importing while the UI was used').toBeVisible();

  await panel.getByRole('button', { name: /^Cancel import of perf-20mb\.dxf/ }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'cancelled' })).toBeVisible();
  expect(await drawings(page)).toBe(0);
  expect(await models(page)).toEqual([]);
});

test('reopening a project re-parses its drawings; a cancelled load can be loaded again (row 21)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await chooseFile(page, largeDxf());
  await expect.poll(async () => (await models(page))[0]?.status, { timeout: 120_000 }).toBe('ready');
  await page.waitForTimeout(1000); // the import edit is durable (NFR-9)

  await page.reload();
  await expect(page.locator('[data-ready="true"]')).toBeVisible();
  await page.getByTestId('recent-projects').getByRole('button').first().click();
  const panel = page.getByTestId('import-progress');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: /^Cancel import of/ }).click();
  await expect(panel).toBeHidden();

  // Never stuck "loading": the drawing says it is not loaded and why, and offers to load it again.
  const notLoaded = page.getByTestId('drawing-not-loaded');
  await expect(notLoaded).toBeVisible();
  await expect(notLoaded).toHaveAttribute('title', 'Loading was cancelled.');
  expect((await models(page))[0]).toMatchObject({ status: 'error', error: 'Loading was cancelled.' });
  await page.getByRole('button', { name: /^Drawing options for / }).click();
  await page.getByRole('menuitem', { name: 'Load again' }).click();
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await models(page))[0]?.status, { timeout: 120_000 }).toBe('ready');
  await expect(notLoaded).toBeHidden();
});

test('a large table is read in the background and can be cancelled (rows 21, 62)', async ({ page }) => {
  test.setTimeout(120_000);
  const file = largeCsv();
  await chooseFile(page, file);
  const dialog = page.getByTestId('import-table-dialog');
  const reading = dialog.getByTestId('table-parsing');
  await expect(reading).toBeVisible();
  await reading.getByRole('button', { name: 'Cancel' }).click();
  await expect(reading).toBeHidden();
  await expect(dialog.getByTestId('import-preview')).toBeHidden();

  // Chosen again and left to finish: the whole table arrives, with its preview.
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await expect(reading).toBeVisible();
  await expect(dialog.getByTestId('import-preview')).toBeVisible({ timeout: 60_000 });
  await expect(dialog).toContainText('200000 rows × 10 columns');
  await expect(dialog.getByTestId('mapping-next')).toBeEnabled();
});
