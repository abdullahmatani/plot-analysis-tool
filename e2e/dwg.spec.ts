import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/**
 * DWG import (rows 22, 23): every DWG either renders or explains what happened, with DXF/PDF
 * guidance — never a hang or a blank screen. The E2E server (`vite preview`) sends the app's
 * Content-Security-Policy as a header, which also governs the DWG workers, so these tests run the
 * reader under the same policy as the offline bundle and hosted mode (decision U-1).
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

test('a 2018 DWG renders under the CSP header, which forbids eval (rows 22, 88)', async ({ page }) => {
  const csp = (await page.request.get('/')).headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).not.toMatch(/(^|[^-])'unsafe-eval'/);
  await importFile(page, 'tests/fixtures/dwg/example_2018.dwg');
  await expect.poll(async () => (await models(page))[0]?.status, { timeout: 60_000 }).toBe('ready');
  expect((await models(page))[0].segments).toBeGreaterThan(1000);
});

test('a damaged DWG is explained with DXF/PDF guidance (row 23)', async ({ page }) => {
  const dir = path.resolve('test-results', 'dwg');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'truncated.dwg');
  writeFileSync(file, readFileSync('tests/fixtures/dwg/example_2018.dwg').subarray(0, 60_000));
  await importFile(page, file);
  const report = page.getByRole('dialog', { name: /Import report/ });
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText(/DXF/);
  await expect(report).toContainText(/PDF/);
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
