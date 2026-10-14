import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { importDrawing, PLOT_PLAN } from './drawing-helpers';
import { createProject, expect, openApp, test } from './fixtures';

/**
 * Row 84: automated accessibility checks (axe-core, WCAG 2.1 A/AA) of the application chrome —
 * start screen, workspace panels and the main dialogs — in light and dark themes. Serious and
 * critical issues fail the test. The drawing canvas itself is a graphic; its non-visual
 * alternative is the Objects table (row 46), which is checked here too.
 */

async function expectAccessible(page: Page, what: string, only?: string) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  // Toasts are checked on their own once settled: stacked toasts fade behind the front one by design.
  builder = only
    ? builder.include(only)
    : builder.exclude('[data-testid="canvas"]').exclude('[data-sonner-toaster]');
  const results = await builder.analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} — ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    );
  expect(serious, `${what}: accessibility violations`).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test(`start screen and workspace (${theme})`, async ({ page }) => {
      await openApp(page);
      await expectAccessible(page, 'start screen');
      await createProject(page, 'A11y');
      await importDrawing(page, PLOT_PLAN);
      await expect(page.locator('[data-sonner-toast]').first()).toBeVisible();
      await page.waitForTimeout(800); // entry animation
      await expectAccessible(page, 'notification', '[data-sonner-toast][data-front="true"]');
      await expectAccessible(page, 'workspace with a drawing (Layers tab)');
      for (const tab of ['Properties', 'Data', 'Legend']) {
        await page.getByRole('tab', { name: tab }).click();
        await expectAccessible(page, `${tab} tab`);
      }
    });

    test(`dialogs (${theme})`, async ({ page }) => {
      await openApp(page);
      await createProject(page, 'A11y dialogs');
      const dialogs: [string, () => Promise<void>][] = [
        ['command palette', () => page.keyboard.press('Control+k')],
        ['help', () => page.keyboard.press('F1')],
        ['keyboard shortcuts', () => page.keyboard.press('Shift+?')],
        ['settings', () => page.keyboard.press('Control+,')],
        ['export', () => page.keyboard.press('Control+p')],
      ];
      for (const [name, open] of dialogs) {
        await open();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectAccessible(page, name);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toBeHidden();
      }
    });
  });
}
