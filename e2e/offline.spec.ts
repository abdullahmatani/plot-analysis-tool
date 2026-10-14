import { createProject, expect, openApp, test } from './fixtures';

test.describe('offline PWA (row 6) @smoke', () => {
  test('after one load, the app starts and works with the network disconnected', async ({
    page,
    context,
  }) => {
    await openApp(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // Reload so the page is controlled by the service worker, then go offline.
    await page.reload();
    await expect(page.locator('[data-ready="true"]')).toBeVisible();
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('[data-ready="true"]')).toBeVisible();
    await createProject(page, 'Offline project');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    // Every precached asset is served from the cache, including pdf.js assets and fonts.
    const assets = await page.evaluate(async () => {
      const keys = await caches.keys();
      const urls: string[] = [];
      for (const k of keys)
        for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
      return urls;
    });
    expect(assets.some((u) => u.includes('/pdfjs/cmaps/'))).toBe(true);
    expect(assets.some((u) => u.includes('/pdfjs/standard_fonts/'))).toBe(true);
    expect(assets.some((u) => u.endsWith('.wasm'))).toBe(true);
    expect(assets.some((u) => u.includes('/fonts/NotoSansArabic'))).toBe(true);
    await context.setOffline(false);
  });

  test('the production build carries a strict Content Security Policy', async ({ page }) => {
    await openApp(page);
    const csp = await page.evaluate(
      () =>
        document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
    );
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/https?:/);
    // A fetch to another host is refused by the browser (CSP), independently of the test's network guard.
    const blocked = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/');
        return false;
      } catch {
        return true;
      }
    });
    expect(blocked).toBe(true);
  });
});
