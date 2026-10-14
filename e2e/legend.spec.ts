import type { Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';
import {
  addObjects,
  chooseFormat,
  forceDownloads,
  openExport,
  project,
  runExport,
  waitPreview,
} from './export-helpers';

/**
 * Legend builder (row 75) and the calibration statement on outputs (row 32): entries for every
 * visible styled item, editable titles / order / grouping / hide-show, reflected in the export.
 */

async function addDataset(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __pat: { store(): { commit(l: string, fn: (d: { datasets: unknown[] }) => void): boolean } };
    };
    w.__pat.store().commit('Add dataset', (d) => {
      d.datasets.push({
        id: 'ds_fire',
        name: 'Fire results',
        visible: true,
        table: {
          columns: ['Tag', 'X', 'Y', 'R1', 'R2'],
          rows: [
            ['P-101', 0, 0, 10, 20],
            ['P-102', 60, 0, 15, 30],
          ],
        },
        mapping: {
          position: { mode: 'xy', x: 'X', y: 'Y' },
          sizeColumns: ['R1', 'R2'],
          sizeMode: 'radius',
          sizeUnit: 'm',
          label: 'Tag',
        },
        sizeStyles: [
          {
            column: 'R1',
            visible: true,
            color: '#dc2626',
            dash: 'solid',
            fillOpacity: 0.1,
            strokeWidth: 0.35,
          },
          {
            column: 'R2',
            visible: true,
            color: '#2563eb',
            dash: 'dash',
            fillOpacity: 0.05,
            strokeWidth: 0.25,
            legendLabel: '4 kW/m²',
          },
        ],
        styleRules: [],
        labelTemplate: '{label}',
        labelPlacement: 'top',
        envelope: false,
        order: 0,
      });
    });
  });
}

async function legendKeys(page: Page): Promise<{ key: string; hidden: string | null }[]> {
  return page
    .getByTestId('legend-entry')
    .evaluateAll((els) =>
      els.map((e) => ({ key: e.getAttribute('data-key') ?? '', hidden: e.getAttribute('data-hidden') })),
    );
}

test.beforeEach(async ({ page }) => {
  await forceDownloads(page);
  await openApp(page);
  await createProject(page, 'Legend E2E');
  await addObjects(page, [
    { name: 'Zone A', geometry: { type: 'circle', c: { x: 0, y: 0 }, r: 10 } },
    { name: 'Zone B', geometry: { type: 'circle', c: { x: 30, y: 0 }, r: 10 } },
    {
      name: 'Keep out',
      category: 'Exclusion',
      geometry: { type: 'rect', c: { x: 0, y: 40 }, w: 20, h: 10, rot: 0 },
      style: { fill: '#16a34a', stroke: '#16a34a', hatch: 'cross' },
    },
    {
      name: 'Laydown 1',
      layer: 'Laydown',
      geometry: { type: 'rect', c: { x: 60, y: 40 }, w: 30, h: 20, rot: 0 },
    },
    { name: 'Secret', layer: 'Hidden', geometry: { type: 'circle', c: { x: 90, y: 0 }, r: 5 } },
  ]);
  await page.evaluate(() => {
    const w = window as unknown as {
      __pat: {
        store(): {
          commit(l: string, fn: (d: { layers: { name: string; visible: boolean }[] }) => void): boolean;
        };
      };
    };
    w.__pat.store().commit('Hide layer', (d) => {
      const l = d.layers.find((x) => x.name === 'Hidden');
      if (l) l.visible = false;
    });
  });
  await addDataset(page);
});

test('every visible styled item has a legend entry; edits are undoable and reach the export', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.getByRole('tab', { name: 'Legend' }).click();
  await expect(page.getByTestId('legend-panel')).toBeVisible();
  await expect(page.getByTestId('legend-preview')).toBeVisible();
  const p = await project<{ layers: { id: string; name: string }[] }>(page);
  const id = (name: string) => p.layers.find((l) => l.name === name)!.id;
  const keys = (await legendKeys(page)).map((k) => k.key);
  // Analysis layer, its green variant, the Laydown layer and both contour size columns; nothing for
  // the hidden layer.
  expect(keys).toEqual(
    expect.arrayContaining([
      `layer:${id('Analysis')}`,
      `layer:${id('Laydown')}`,
      'ds:ds_fire:size:R1',
      'ds:ds_fire:size:R2',
    ]),
  );
  expect(keys.some((k) => k.startsWith(`style:${id('Analysis')}:`))).toBe(true);
  expect(keys.some((k) => k.includes(id('Hidden')))).toBe(false);
  expect(keys).toHaveLength(5);

  // Rename Laydown, hide the Exclusion variant, move R2 above R1.
  const laydown = page.getByLabel('Legend title for Laydown');
  await laydown.fill('Laydown area');
  await laydown.press('Enter');
  await page.getByRole('button', { name: 'Hide Exclusion from legend' }).click();
  await page.getByRole('button', { name: 'Move 4 kW/m² up' }).click();
  await expect
    .poll(async () => (await legendKeys(page)).map((k) => k.key).indexOf('ds:ds_fire:size:R2'))
    .toBeLessThan((await legendKeys(page)).map((k) => k.key).indexOf('ds:ds_fire:size:R1'));
  const ov = (
    await project<{ legend: { overrides: { key: string; title?: string; hidden?: boolean }[] } }>(page)
  ).legend.overrides;
  expect(ov.find((o) => o.key === `layer:${id('Laydown')}`)?.title).toBe('Laydown area');
  expect(ov.some((o) => o.key.startsWith('style:') && o.hidden === true)).toBe(true);

  // The exported legend shows the edits.
  await openExport(page);
  await chooseFormat(page, 'svg');
  await waitPreview(page);
  const svg = (await runExport(page)).bytes.toString('utf8');
  const legend = svg.slice(svg.indexOf('inkscape:label="Legend"'));
  expect(legend).toContain('Laydown area');
  expect(legend).toContain('4 kW/m²');
  expect(legend).toContain('R1');
  expect(legend).not.toContain('Exclusion');
  expect(legend.indexOf('4 kW/m²')).toBeLessThan(legend.indexOf('>R1<'));
  await page.getByTestId('export-close').click();

  // Undo restores the last edit (one commit per edit).
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () =>
      (await project<{ legend: { overrides: { order?: number }[] } }>(page)).legend.overrides.some(
        (o) => o.order !== undefined,
      ),
    )
    .toBe(false);
});

test('the calibration statement is always on the output (row 32) and the legend can move', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.getByRole('tab', { name: 'Legend' }).click();
  await page.getByLabel('Legend position').click();
  await page.getByRole('option', { name: 'Bottom left' }).click();
  await page.getByRole('switch', { name: 'Show calibration statement' }).click();
  await expect
    .poll(
      async () => (await project<{ legend: { position: string; showCalibration: boolean } }>(page)).legend,
    )
    .toMatchObject({
      position: 'bottom-left',
      showCalibration: false,
    });
  await openExport(page);
  await chooseFormat(page, 'svg');
  await waitPreview(page);
  let svg = (await runExport(page)).bytes.toString('utf8');
  expect(svg).toContain('Calibration: no drawing');
  // Without title block and without the legend statement, a standalone note still carries it.
  await page.getByTestId('sheet-title-block').click();
  await waitPreview(page);
  svg = (await runExport(page)).bytes.toString('utf8');
  expect(svg).toContain('Calibration: no drawing');
  // DXF and tables carry it too.
  await chooseFormat(page, 'dxf');
  expect((await runExport(page)).bytes.toString('utf8')).toContain('Calibration: no drawing');
  await chooseFormat(page, 'csv');
  expect((await runExport(page)).bytes.toString('utf8')).toContain('# Calibration: no drawing');
});
