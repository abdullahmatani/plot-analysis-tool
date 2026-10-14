import type { BrowserContext, Page } from '@playwright/test';

import { createProject, expect, openApp, test } from './fixtures';

/**
 * C7 / rows 87, 93: every multi-step tool keeps its in-progress state as a draft. After a tab
 * crash the recovery dialog counts it, and the unfinished operation can be resumed where it was.
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

async function crash(context: BrowserContext, page: Page) {
  const sleep = (ms: number) => new Promise<false>((r) => setTimeout(() => r(false), ms));
  const crashed = new Promise<true>((r) => page.once('crash', () => r(true)));
  page.goto('chrome://crash').catch(() => {});
  if (!(await Promise.race([crashed, sleep(15_000)]))) {
    const cdp = await context.newCDPSession(page);
    cdp.send('Page.crash').catch(() => {});
    expect(await Promise.race([crashed, sleep(15_000)]), 'renderer crashed').toBe(true);
  }
}

for (const t of TOOLS) {
  test(`an unfinished ${t.id} survives a crash and can be resumed`, async ({ page, context }) => {
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
    await crash(context, page);

    const page2 = await context.newPage();
    await openApp(page2);
    const dialog = page2.getByTestId('recovery-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/unfinished/);
    await page2.getByTestId('recovery-apply').click();
    await expect(page2.getByTestId('workspace')).toBeVisible();
    const resume = page2.getByRole('button', { name: 'Resume' });
    await expect(resume.first()).toBeVisible();
    await resume.first().click();
    await expect.poll(() => activeTool(page2)).toBe(t.id);
    // The restored points are the ones placed before the crash: the hint asks for the next one.
    await expect(page2.getByTestId('tool-hint')).toContainText(/Backspace/);
  });
}
