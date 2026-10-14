import { createProject, expect, openApp, test } from './fixtures';

/** Row 86: in-app help is available with the network disabled. */
test('help opens offline with quick start, search and a tool reference @smoke', async ({ page, context }) => {
  await openApp(page);
  await createProject(page, 'Help');
  await context.setOffline(true);
  await page.keyboard.press('F1');
  const help = page.getByTestId('help-dialog');
  await expect(help).toBeVisible();
  await expect(help).toContainText('Getting started');
  await help.getByLabel('Search help').fill('dwg');
  await expect(help).toContainText('A DWG does not open');
  await expect(help).not.toContainText('Getting started');
  await help.getByLabel('Search help').fill('');
  await help.getByRole('tab', { name: 'Tools and shortcuts' }).click();
  await expect(help.getByTestId('help-tool-reference')).toContainText('Circle');
});
