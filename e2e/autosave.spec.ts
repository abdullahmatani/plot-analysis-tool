import {
  commitEdit,
  crashAndRelaunch,
  createProject,
  expect,
  firstPage,
  launchPersistent,
  layerNames,
  openApp,
  test,
  waitSaved,
} from './fixtures';
import type { Page } from '@playwright/test';

async function openFirstRecent(page: Page) {
  await page.getByTestId('recent-projects').getByRole('button').first().click();
  await expect(page.getByTestId('workspace')).toBeVisible();
}

test.describe('autosave', () => {
  test('edits are saved automatically and survive a reload (rows 9, 90)', async ({ page }) => {
    await openApp(page);
    await createProject(page, 'Autosave A');
    for (let i = 0; i < 5; i++) await commitEdit(page, 'Add layer', `L${i}`);
    await waitSaved(page);
    await page.reload();
    await expect(page.locator('[data-ready="true"]')).toBeVisible();
    await openFirstRecent(page);
    expect(await layerNames(page)).toEqual(['Analysis', 'L0', 'L1', 'L2', 'L3', 'L4']);
  });

  test('undo history persists across reload (row 97)', async ({ page }) => {
    await openApp(page);
    await createProject(page, 'Undo persist');
    await commitEdit(page, 'Add layer', 'Shape');
    await waitSaved(page);
    await page.reload();
    await expect(page.locator('[data-ready="true"]')).toBeVisible();
    await openFirstRecent(page);
    expect(await layerNames(page)).toContain('Shape');
    await page.getByTestId('canvas').click();
    await page.keyboard.press('Control+z');
    await expect.poll(() => layerNames(page)).toEqual(['Analysis']);
  });

  test('status indicator never shows Saved while unflushed edits exist (row 94)', async ({ page }) => {
    await openApp(page);
    await createProject(page, 'Indicator');
    const violations = await page.evaluate(async () => {
      const w = window as unknown as {
        __pat: { addLayer(l: string, n: string): boolean; hasUnflushed(): boolean };
      };
      const badge = () => document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state');
      let violations = 0;
      let suspicious = 0;
      const sample = () => {
        if (badge() === 'saved' && w.__pat.hasUnflushed()) suspicious++;
        else suspicious = 0;
        // Allow one render frame of latency between the store update and the DOM.
        if (suspicious > 1) violations++;
      };
      const timer = setInterval(sample, 8);
      for (let i = 0; i < 60; i++) {
        w.__pat.addLayer('Add layer', `X${i}`);
        await new Promise((r) => setTimeout(r, Math.random() * 60));
      }
      await new Promise((r) => setTimeout(r, 1500));
      clearInterval(timer);
      return violations;
    });
    expect(violations).toBe(0);
    await waitSaved(page);
  });

  test('named restore point can be previewed and restored, and the restore is undoable (row 96)', async ({
    page,
  }) => {
    await openApp(page);
    await createProject(page, 'Restore points');
    await commitEdit(page, 'Add layer', 'Before');
    await page.keyboard.press('Control+Shift+S');
    await page.getByLabel('Name').fill('Baseline');
    await page.getByRole('button', { name: 'OK' }).click();
    await commitEdit(page, 'Add layer', 'After');
    await page.keyboard.press('Control+Alt+h');
    const list = page.getByTestId('restore-points');
    await expect(list).toContainText('Baseline');
    const item = list.locator('li', { hasText: 'Baseline' });
    await item.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(() => layerNames(page)).toEqual(['Analysis', 'Before']);
    await page.keyboard.press('Escape');
    await page.getByTestId('canvas').click();
    await page.keyboard.press('Control+z');
    await expect.poll(() => layerNames(page)).toEqual(['Analysis', 'Before', 'After']);
  });

  test('browser crash shows the recovery dialog and restores edits (row 95)', async ({ baseURL }) => {
    const before = await launchPersistent(baseURL!);
    const page = await firstPage(before.context);
    await openApp(page);
    await createProject(page, 'Crashy');
    for (let i = 0; i < 3; i++) await commitEdit(page, 'Add layer', `C${i}`);
    await waitSaved(page);
    const after = await test.step('crash the browser and start it again', () =>
      crashAndRelaunch(baseURL!, before));
    try {
      const page2 = await firstPage(after.context);
      await test.step('recovery dialog offers the crashed project', async () => {
        await openApp(page2);
        await expect(page2.getByTestId('recovery-dialog')).toBeVisible();
        await expect(page2.getByTestId('recovery-dialog')).toContainText('Crashy');
      });
      await test.step('recover', async () => {
        await page2.getByTestId('recovery-apply').click();
        await expect(page2.getByTestId('workspace')).toBeVisible();
        expect(await layerNames(page2)).toEqual(['Analysis', 'C0', 'C1', 'C2']);
      });
      expect(after.violations).toEqual([]);
    } finally {
      await after.context.close();
    }
  });

  test('second tab opens read-only, follows edits and can take over (row 100)', async ({ page, context }) => {
    await openApp(page);
    await createProject(page, 'Two tabs');
    await commitEdit(page, 'Add layer', 'A');
    await waitSaved(page);
    const page2 = await context.newPage();
    await openApp(page2);
    await openFirstRecent(page2);
    await expect(page2.getByTestId('readonly-banner')).toBeVisible();
    // Writes in the read-only tab are rejected.
    const r = await commitEdit(page2, 'Add layer', 'Nope');
    expect(r.ok).toBe(false);
    await commitEdit(page, 'Add layer', 'B');
    await expect.poll(() => layerNames(page2)).toEqual(['Analysis', 'A', 'B']);
    await page2.getByRole('button', { name: 'Take over editing' }).click();
    await expect(page2.getByTestId('readonly-banner')).toBeHidden();
    await expect(page.getByTestId('readonly-banner')).toBeVisible();
    await commitEdit(page2, 'Add layer', 'C');
    expect((await commitEdit(page, 'Add layer', 'Lost?')).ok).toBe(false);
    await expect.poll(() => layerNames(page)).toEqual(['Analysis', 'A', 'B', 'C']);
    await waitSaved(page2);
    await page2.close();
    await page.reload();
    await openFirstRecent(page);
    expect(await layerNames(page)).toEqual(['Analysis', 'A', 'B', 'C']);
  });

  test('settings persist and take effect without reload (row 101)', async ({ page }) => {
    await openApp(page);
    await createProject(page, 'Settings');
    await page.keyboard.press('Control+,');
    await page.getByLabel(/Automatic restore point every/).fill('3');
    await page.getByRole('button', { name: 'Save' }).click();
    // Applied to the running autosave engine without a reload (saving is asynchronous).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const w = window as unknown as {
            __pat: { session(): { engine: { settings: { restorePointIntervalMin: number } } } };
          };
          return w.__pat.session().engine.settings.restorePointIntervalMin;
        }),
      )
      .toBe(3);
    await page.reload();
    await openFirstRecent(page);
    await page.keyboard.press('Control+,');
    await expect(page.getByLabel(/Automatic restore point every/)).toHaveValue('3');
  });

  test('storage quota exhaustion shows a blocking alert and saving to file loses nothing (row 99)', async ({
    baseURL,
  }) => {
    // Quota is enforced for on-disk profiles; Chrome reads the overridden quota when the origin's
    // storage is first opened, so the override is applied before navigating. Service workers are
    // blocked so the precache does not consume the tiny quota.
    const { context, violations } = await launchPersistent(baseURL!, undefined, { serviceWorkers: 'block' });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('about:blank');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', {
      origin: new URL(baseURL!).origin,
      quotaSize: 250_000,
    });
    await openApp(page);
    await createProject(page, 'Quota');
    await commitEdit(page, 'Add layer', 'Q0');
    await waitSaved(page);
    // Large, incompressible edits exceed the quota.
    await page.evaluate(async () => {
      const w = window as unknown as {
        __pat: { store(): { commit(l: string, r: (d: { layers: object[] }) => void): boolean } };
      };
      for (let i = 0; i < 5; i++) {
        const bytes = new Uint8Array(60_000);
        crypto.getRandomValues(bytes);
        const noise = btoa(String.fromCharCode(...bytes));
        w.__pat.store().commit('Big edit', (d) => {
          d.layers.push({
            ...JSON.parse(JSON.stringify(d.layers[0])),
            id: `big${i}`,
            name: `Big${i} ${noise}`,
          });
        });
        await new Promise((r) => setTimeout(r, 300));
      }
    });
    await expect(page.getByTestId('quota-alert')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'error');
    // Fall back to download so the test does not need a native file picker.
    await page.evaluate(() => {
      (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
    });
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('quota-save').click();
    const download = await downloadPromise;
    const file = await download.path();
    const { readFileSync } = await import('node:fs');
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(readFileSync(file)));
    const json = JSON.parse(new TextDecoder().decode(files['project.json'])) as {
      project: { layers: { name: string }[] };
    };
    expect(json.project.layers.map((l) => l.name.slice(0, 4))).toEqual([
      'Anal',
      'Q0',
      'Big0',
      'Big1',
      'Big2',
      'Big3',
      'Big4',
    ]);
    await context.close();
    expect(violations).toEqual([]);
  });
});
