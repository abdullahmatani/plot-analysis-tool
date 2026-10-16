import { rmSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import {
  crashAndRelaunch,
  createProject,
  expect,
  firstPage,
  killBrowser,
  launchPersistent,
  openApp,
  test,
} from './fixtures';

/**
 * C7 / rows 87, 93: every multi-step tool keeps its in-progress state as a draft. After a crash
 * the recovery dialog counts it, and the unfinished operation can be resumed where it was.
 */

interface ToolCase {
  id: string;
  /** Key press, or a command palette title. */
  start: { key: string } | { palette: string };
  points: string[];
}

const TOOLS: ToolCase[] = [
  { id: 'draw.polyline', start: { key: 'p' }, points: ['0,0', '10,0'] },
  { id: 'draw.polygon', start: { key: 'g' }, points: ['0,0', '10,0'] },
  { id: 'draw.rect', start: { key: 'r' }, points: ['0,0'] },
  { id: 'draw.circle', start: { key: 'c' }, points: ['5,5'] },
  { id: 'draw.arc3', start: { key: 'a' }, points: ['0,0', '5,5'] },
  { id: 'trace.manual', start: { key: 't' }, points: ['0,0', '20,0'] },
  { id: 'measure.distance', start: { key: 'd' }, points: ['0,0'] },
  { id: 'measure.area', start: { palette: 'Measure area and perimeter' }, points: ['0,0', '10,0'] },
  { id: 'annotate.callout', start: { key: 'Shift+X' }, points: ['0,0'] },
];

const activeTool = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __pat: { view(): { activeTool: string } } }).__pat.view().activeTool,
  );

async function typeOnCanvas(page: Page, text: string) {
  for (const ch of text) await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
}

/**
 * After a crash the recovery dialog lists the project. Chromium sometimes deletes the whole database
 * on the next start instead (docs/USER-DECISIONS.md §D); the project is then rebuilt from its backup
 * copy, drafts included, with a notice. Either way the unfinished operation must be resumable.
 */
async function reopenAfterCrash(page: Page) {
  const dialog = page.getByTestId('recovery-dialog');
  const restored = page.getByText(/was restored from its backup copy/);
  await expect(dialog.or(restored).first()).toBeVisible();
  if (await dialog.isVisible()) {
    await expect(dialog).toContainText(/unfinished/);
    await page.getByTestId('recovery-apply').click();
  } else {
    await page.getByTestId('recent-projects').getByRole('button').first().click();
  }
  await expect(page.getByTestId('workspace')).toBeVisible();
}

for (const t of TOOLS) {
  test(`an unfinished ${t.id} survives a crash and can be resumed`, async ({ baseURL }) => {
    const before = await launchPersistent(baseURL!);
    const page = await firstPage(before.context);
    await openApp(page);
    await createProject(page, `Draft ${t.id}`);
    await page.getByTestId('canvas').focus();
    if ('key' in t.start) await page.keyboard.press(t.start.key);
    else {
      await page.keyboard.press('Control+k');
      await page.getByRole('dialog').getByRole('combobox').fill(t.start.palette);
      await page.keyboard.press('Enter');
      await page.getByTestId('canvas').focus();
    }
    await expect.poll(() => activeTool(page)).toBe(t.id);
    for (const p of t.points) await typeOnCanvas(page, p);
    await page.waitForTimeout(1500); // drafts are written within 1 s (row 93)

    const after = await crashAndRelaunch(baseURL!, before);
    try {
      const page2 = await firstPage(after.context);
      await openApp(page2);
      await reopenAfterCrash(page2);
      const resume = page2.getByRole('button', { name: 'Resume' });
      await expect(resume.first()).toBeVisible();
      await resume.first().click();
      await expect.poll(() => activeTool(page2)).toBe(t.id);
      // The restored points are the ones placed before the crash: the hint asks for the next one.
      await expect(page2.getByTestId('tool-hint')).toContainText(/Backspace/);
      expect(after.violations).toEqual([]);
    } finally {
      await after.context.close();
    }
  });
}

test('an unfinished trace survives the browser deleting its database after a crash (C7, row 93)', async ({
  baseURL,
}) => {
  const before = await launchPersistent(baseURL!);
  const page = await firstPage(before.context);
  await openApp(page);
  await createProject(page, 'Draft after database loss');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('t');
  await expect.poll(() => activeTool(page)).toBe('trace.manual');
  for (const p of ['0,0', '20,0', '20,15']) await typeOnCanvas(page, p);
  await page.waitForTimeout(1500); // drafts, and their backup copy, are written within 1 s (row 93)
  expect(before.violations).toEqual([]);
  expect(killBrowser(before.userDataDir)).toBeGreaterThan(0);
  await before.context.close().catch(() => {});
  // What Chromium does to a store it finds damaged after a crash (docs/USER-DECISIONS.md §D).
  rmSync(path.join(before.userDataDir, 'Default', 'IndexedDB'), { recursive: true, force: true });

  const after = await launchPersistent(baseURL!, before.userDataDir);
  try {
    const page2 = await firstPage(after.context);
    await openApp(page2);
    await expect(
      page2.getByText('Project “Draft after database loss” was restored from its backup copy'),
    ).toBeVisible();
    await reopenAfterCrash(page2);
    const resume = page2.getByRole('button', { name: 'Resume' });
    await expect(resume.first()).toBeVisible();
    await resume.first().click();
    await expect.poll(() => activeTool(page2)).toBe('trace.manual');
    await expect(page2.getByTestId('tool-hint')).toContainText(/Backspace/);
    // All three vertices are back: the trace closes into a triangle of the original size.
    await page2.getByTestId('canvas').focus();
    await page2.keyboard.press('c');
    await expect
      .poll(() =>
        page2.evaluate(
          () =>
            (
              window as unknown as {
                __pat: { project(): { objects: { geometry: { pts?: { x: number; y: number }[] } }[] } };
              }
            ).__pat.project().objects[0]?.geometry.pts?.length ?? 0,
        ),
      )
      .toBe(3);
    expect(after.violations).toEqual([]);
  } finally {
    await after.context.close();
  }
});
