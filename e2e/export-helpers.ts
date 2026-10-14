import { readFileSync } from 'node:fs';

import type { Download, Page } from '@playwright/test';

import { expect } from './fixtures';

/** Helpers for the export / legend E2E specs (rows 75–81). */

export const DXF_FIXTURE = 'tests/fixtures/dxf/r2018_plotplan.dxf';
export const PDF_FIXTURE = 'tests/fixtures/pdf/plot-plan-a1-1to500.pdf';

/** Forces the download fallback (the File System Access save picker cannot be driven headlessly). */
export async function forceDownloads(page: Page) {
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
}

export async function importDrawing(page: Page, file: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+i');
  await (await chooser).setFiles(file);
  if (file.endsWith('.pdf')) {
    await expect(page.getByTestId('pdf-page-picker')).toBeVisible();
    await page.getByRole('button', { name: /^Import 1 page$/ }).click();
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as {
          __pat: { project(): { drawings: unknown[] } | null };
          __patExport: { modelsReady(): boolean };
        };
        return (w.__pat.project()?.drawings.length ?? 0) > 0 && w.__patExport.modelsReady();
      }),
    )
    .toBe(true);
}

export interface TestObject {
  name: string;
  geometry: Record<string, unknown>;
  style?: Record<string, unknown>;
  label?: Record<string, unknown>;
  attributes?: Record<string, string | number>;
  layer?: string;
  category?: string;
}

/** Adds objects through the normal commit path (one undoable step), creating layers by name. */
export async function addObjects(page: Page, objects: TestObject[]) {
  await page.evaluate((objs) => {
    type Draft = {
      layers: { id: string; name: string }[];
      activeLayerId: string;
      objects: unknown[];
    };
    const w = window as unknown as {
      __pat: { store(): { commit(label: string, fn: (d: Draft) => void): boolean } };
    };
    w.__pat.store().commit('Add test objects', (d) => {
      const template = d.layers[0] as unknown as Record<string, unknown>;
      for (const [i, o] of objs.entries()) {
        let layerId = d.activeLayerId;
        if (o.layer) {
          let l = d.layers.find((x) => x.name === o.layer);
          if (!l) {
            l = {
              ...structuredClone(template),
              id: `lyr_${o.layer}`,
              name: o.layer,
            } as unknown as { id: string; name: string };
            d.layers.push(l);
          }
          layerId = l.id;
        }
        d.objects.push({
          id: `obj_${Date.now()}_${i}`,
          layerId,
          name: o.name,
          kind: 'shape',
          geometry: o.geometry,
          style: o.style ?? {},
          attributes: o.attributes ?? {},
          ...(o.category ? { category: o.category } : {}),
          ...(o.label ? { label: o.label } : {}),
          createdAt: new Date().toISOString(),
        });
      }
    });
  }, objects);
}

export async function project<T = Record<string, unknown>>(page: Page): Promise<T> {
  return page.evaluate(
    () => (window as unknown as { __pat: { project(): unknown } }).__pat.project() as never,
  );
}

export async function openExport(page: Page) {
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+p');
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await waitPreview(page);
}

export async function waitPreview(page: Page) {
  await expect
    .poll(async () => page.getByTestId('export-preview').evaluate((c: HTMLCanvasElement) => c.width), {
      timeout: 30_000,
    })
    .toBeGreaterThan(100);
  await expect(page.getByTestId('export-preview')).toHaveAttribute('data-busy', 'false', { timeout: 30_000 });
}

export async function chooseFormat(page: Page, format: string) {
  await page.getByTestId('export-format').click();
  await page.getByTestId(`export-format-${format}`).click();
}

/** Clicks Export and returns the downloaded bytes. */
export async function runExport(page: Page, timeout = 120_000): Promise<{ bytes: Buffer; name: string }> {
  const dl = page.waitForEvent('download', { timeout });
  await page.getByTestId('export-run').click();
  const d: Download = await dl;
  const path = await d.path();
  return { bytes: readFileSync(path!), name: d.suggestedFilename() };
}

/** PNG header info. */
export function pngInfo(bytes: Buffer): { width: number; height: number; dpi?: number } {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const phys = bytes.indexOf('pHYs');
  const dpi = phys > 0 ? bytes.readUInt32BE(phys + 4) * 0.0254 : undefined;
  return { width, height, dpi };
}
