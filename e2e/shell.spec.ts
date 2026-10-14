import { createProject, expect, openApp, test } from './fixtures';

test.describe('application shell @smoke', () => {
  test('start screen, new project and workspace layout', async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await createProject(page, 'Shell test');
    await expect(page.getByTestId('tool-rail')).toBeVisible();
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('status-bar')).toBeVisible();
    for (const m of ['File', 'Edit', 'View', 'Help'])
      await expect(page.getByRole('menuitem', { name: m, exact: true })).toBeVisible();
  });

  test('command palette lists commands and runs them', async ({ page }) => {
    await openApp(page);
    await createProject(page);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByPlaceholder('Type a command or tool…')).toBeVisible();
    await page.keyboard.type('keyboard shortcuts');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  });

  test('about dialog states the privacy guarantee and lists licences', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('About');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('privacy-statement')).toContainText('never leaves this device');
    await page.getByRole('tab', { name: 'Licences' }).click();
    await expect(page.getByTestId('licence-list')).toContainText('pdfjs-dist');
    await expect(page.getByTestId('licence-list')).toContainText('GPL-3.0');
  });

  test('panels collapse and layout persists across reloads', async ({ page }) => {
    await openApp(page);
    await createProject(page);
    await page.keyboard.press('Control+Alt+i');
    await expect(page.getByTestId('inspector')).toBeHidden();
    await page.reload();
    await expect(page.locator('[data-ready="true"]')).toBeVisible();
    await page.getByTestId('recent-projects').getByRole('button').first().click();
    await expect(page.getByTestId('workspace')).toBeVisible();
    await expect(page.getByTestId('inspector')).toBeHidden();
    await page.keyboard.press('Control+Alt+i');
    await expect(page.getByTestId('inspector')).toBeVisible();
  });

  test('theme switch applies dark class', async ({ page }) => {
    await openApp(page);
    await createProject(page);
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Light theme' }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });
});
