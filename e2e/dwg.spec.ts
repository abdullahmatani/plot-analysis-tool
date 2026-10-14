import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/**
 * DWG import (rows 22, 23): every DWG either renders or explains what happened, with DXF/PDF
 * guidance — never a hang or a blank screen. When the page's Content-Security-Policy header forbids
 * LibreDWG's generated code (see docs/USER-DECISIONS.md, decision U-1) the explanation says so.
 */

async function importFile(page: Page, file: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+i');
  await (await chooser).setFiles(file);
}

const models = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __pat: { models(): { status: string; segments: number }[] } }).__pat.models(),
  );

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await createProject(page, 'DWG');
});

test('a 2018 DWG renders, or the reason it cannot is explained with DXF/PDF guidance', async ({ page }) => {
  await importFile(page, 'tests/fixtures/dwg/example_2018.dwg');
  const report = page.getByRole('dialog', { name: /Import report/ });
  await expect
    .poll(
      async () =>
        (await models(page))[0]?.status === 'ready' ? 'rendered' : (await report.isVisible()) ? 'report' : '',
      {
        timeout: 60_000,
      },
    )
    .not.toBe('');
  if ((await models(page))[0]?.status === 'ready') {
    expect((await models(page))[0].segments).toBeGreaterThan(1000);
  } else {
    await expect(report).toContainText(/DXF/);
    await expect(report).toContainText(/PDF/);
  }
});

test('a DWG newer than AutoCAD 2018 is refused with a clear message', async ({ page }) => {
  const dir = path.resolve('test-results', 'dwg');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'future.dwg');
  const bytes = new Uint8Array(4096);
  bytes.set(new TextEncoder().encode('AC1033'), 0);
  writeFileSync(file, bytes);
  await importFile(page, file);
  const report = page.getByRole('dialog', { name: /Import report/ });
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText(/newer than AutoCAD 2018/);
  await expect(report).toContainText(/DXF/);
});
