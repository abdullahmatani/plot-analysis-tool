import { chromium, test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Records every request leaving the app origin. Requests to other hosts are aborted and fail the test. */
export async function guardEgress(context: BrowserContext, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const violations: string[] = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    let o: string;
    try {
      o = new URL(url).origin;
    } catch {
      return route.continue();
    }
    if (o !== origin) {
      violations.push(url);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  context.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('chrome-extension:')) return;
    try {
      if (new URL(url).origin !== origin) violations.push(url);
    } catch {
      /* ignore */
    }
  });
  return violations;
}

export const test = base.extend<{ egress: string[] }>({
  egress: [
    async ({ context, baseURL }, use) => {
      const violations = await guardEgress(context, baseURL!);
      await use(violations);
      expect(violations, 'requests to non-origin hosts (zero-egress guarantee)').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-ready="true"]')).toBeVisible();
}

export async function createProject(page: Page, name = 'E2E project') {
  await page.getByTestId('new-project').click();
  const input = page.getByLabel('Project name');
  await input.fill(name);
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('workspace')).toBeVisible();
}

/** Commits an edit through the app's command store (same path as every UI tool). */
export async function commitEdit(page: Page, label: string, layerName: string) {
  return page.evaluate(
    ([l, n]) => {
      const w = window as unknown as { __pat: { addLayer(label: string, name: string): boolean } };
      const ok = w.__pat.addLayer(l, n);
      return { ok, at: Date.now() };
    },
    [label, layerName] as const,
  );
}

export async function layerNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __pat: { project(): { layers: { name: string }[] } | null } };
    return w.__pat.project()?.layers.map((l) => l.name) ?? [];
  });
}

export async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}

/** A persistent (on-disk) browser profile, as a real user has, with the egress guard installed. */
export async function launchPersistent(
  baseURL: string,
  userDataDir = mkdtempSync(path.join(tmpdir(), 'pat-profile-')),
  opts: { serviceWorkers?: 'allow' | 'block'; offline?: boolean } = {},
) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    baseURL,
    serviceWorkers: opts.serviceWorkers ?? 'allow',
  });
  const violations = await guardEgress(context, baseURL);
  return { context, userDataDir, violations };
}

export type PersistentBrowser = Awaited<ReturnType<typeof launchPersistent>>;

/** Kills (SIGKILL) every process of the browser running on this profile. Returns how many. */
export function killBrowser(userDataDir: string) {
  const out = execSync('ps -eo pid=,args=', { encoding: 'utf8' });
  const pids = out
    .split('\n')
    .filter((l) => l.includes(`--user-data-dir=${userDataDir}`))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((p) => p > 0);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return pids.length;
}

/**
 * Simulates a crash: the browser is killed with no chance to save or unload, then started again on
 * the same profile. Renderer-only crashes (chrome://crash, DevTools Page.crash) are not used because
 * some CI runners ignore them.
 */
export async function crashAndRelaunch(baseURL: string, browser: PersistentBrowser) {
  expect(browser.violations, 'requests to non-origin hosts (zero-egress guarantee)').toEqual([]);
  expect(killBrowser(browser.userDataDir), 'browser processes killed').toBeGreaterThan(0);
  await browser.context.close().catch(() => {});
  return launchPersistent(baseURL, browser.userDataDir);
}

export async function firstPage(context: BrowserContext) {
  return context.pages()[0] ?? (await context.newPage());
}
