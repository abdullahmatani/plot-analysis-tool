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

test('workflow guides W1–W4 reference existing commands', async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Guides');
  await page.keyboard.press('F1');
  const help = page.getByTestId('help-dialog');
  await help.getByRole('tab', { name: 'Workflows' }).click();
  for (const w of ['W1', 'W2', 'W3', 'W4']) await expect(help).toContainText(w);
  // A guide step that names a missing command would show its raw id (e.g. "offset.offset").
  const text = (await help.textContent()) ?? '';
  expect(text.match(/\b[a-z]+\.[a-z][A-Za-z]+\b/g) ?? []).toEqual([]);
});
