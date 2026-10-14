import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { createProject, expect, launchPersistent, openApp, test } from './fixtures';

/**
 * Performance budget (row 82). Runs in the `perf` Playwright project (`npm run e2e:perf`).
 *
 * Budgets are the FDR targets for the reference machine (8 GB laptop, integrated GPU). CI runners
 * render WebGL in software (SwiftShader) and are slower, so unless PAT_PERF_STRICT=1 the frame-rate
 * budget is relaxed by PAT_PERF_FACTOR (default 4×) for timing and fps; the measured values are
 * always written to test-results/perf.json so the reference-machine run can be compared.
 */

const STRICT = !!process.env.PAT_PERF_STRICT;
const FACTOR = STRICT ? 1 : Number(process.env.PAT_PERF_FACTOR ?? 4);
const results: Record<string, number> = {};
const OUT = path.resolve('test-results');

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path.join(OUT, 'perf.json'),
    JSON.stringify({ strict: STRICT, factor: FACTOR, results }, null, 2),
  );
  console.log('performance results', results);
});

function syntheticDxf(mb: number): string {
  const file = path.resolve('test-results', `perf-${mb}mb.dxf`);
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    execFileSync(process.execPath, ['scripts/fixtures/make-large-dxf.mjs', file, String(mb)]);
  }
  return file;
}

/** The WebGL renderer string; software renderers (SwiftShader, llvmpipe) make GPU timings meaningless. */
async function glRenderer(page: Page): Promise<{ name: string; software: boolean }> {
  const name = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  return { name, software: /swiftshader|llvmpipe|software|basic render/i.test(name) };
}

/** On software GL, measure the CPU path only (WebGL draw calls disabled) — see the file comment. */
async function disableGpuDrawsIfSoftware(page: Page) {
  const gl = await glRenderer(page);
  test.info().annotations.push({ type: 'webgl', description: gl.name });
  if (gl.software && !STRICT) {
    await page.evaluate(() => {
      const c = (window as unknown as { __patCanvas: { renderer: { render(): void } } }).__patCanvas;
      c.renderer.render = () => {};
    });
    test.info().annotations.push({ type: 'note', description: 'software WebGL: GPU draw time excluded' });
  }
  return gl;
}

async function installLongTaskObserver(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(e.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
}

const longTasks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);

async function importFile(page: Page, file: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+i');
  await (await chooser).setFiles(file);
}

const models = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __pat: { models(): { status: string; segments: number; error?: string }[] };
      }
    ).__pat.models(),
  );

test('NFR-2: 20 MB ASCII DXF parsed and displayed ≤ 10 s without main-thread blocks > 100 ms', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const file = syntheticDxf(20);
  await openApp(page);
  await createProject(page, 'Perf');
  await disableGpuDrawsIfSoftware(page);
  await installLongTaskObserver(page);
  const t0 = Date.now();
  await importFile(page, file);
  await expect
    .poll(async () => (await models(page))[0]?.status, { timeout: 120_000, intervals: [100] })
    .toBe('ready');
  // Displayed: wait for the next two frames after the model is ready.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const elapsed = (Date.now() - t0) / 1000;
  const tasks = await longTasks(page);
  const maxBlock = Math.max(0, ...tasks);
  results['nfr2.seconds'] = elapsed;
  results['nfr2.maxMainThreadBlockMs'] = maxBlock;
  results['nfr2.segments'] = (await models(page))[0].segments;
  expect(results['nfr2.segments']).toBeGreaterThan(200_000);
  expect(elapsed).toBeLessThanOrEqual(10 * FACTOR);
  expect(maxBlock).toBeLessThanOrEqual(STRICT ? 100 : 100 * 2);
});

test('NFR-4: pan and zoom ≥ 50 fps with 200 000 underlay segments', async ({ page }) => {
  test.setTimeout(180_000);
  const file = syntheticDxf(3.2);
  await openApp(page);
  await createProject(page, 'Perf');
  const gl = await glRenderer(page);
  await importFile(page, file);
  await expect.poll(async () => (await models(page))[0]?.status, { timeout: 120_000 }).toBe('ready');
  await page.keyboard.press('Home');
  // Animate pan + zoom for 3 s and count rendered frames.
  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const view = (
          window as unknown as {
            __pat: { view(): { view: { cx: number; cy: number; scale: number }; setView(v: object): void } };
          }
        ).__pat.view;
        const start = { ...view().view };
        let frames = 0;
        const t0 = performance.now();
        const step = (t: number) => {
          const k = (t - t0) / 1000;
          view().setView({
            cx: start.cx + Math.sin(k * 2) * 300,
            cy: start.cy + Math.cos(k * 2) * 200,
            scale: start.scale * (1.5 + Math.sin(k * 3)),
          });
          frames++;
          if (t - t0 < 3000) requestAnimationFrame(step);
          else resolve((frames * 1000) / (t - t0));
        };
        requestAnimationFrame(step);
      }),
  );
  results['nfr4.fps'] = fps;
  results['nfr4.segments'] = (await models(page))[0].segments;
  expect(results['nfr4.segments']).toBeGreaterThanOrEqual(200_000);
  if (gl.software && !STRICT) {
    // Software rasterisation cannot represent the reference machine's integrated GPU; report only.
    test
      .info()
      .annotations.push({ type: 'not-representative', description: `${gl.name}: ${fps.toFixed(1)} fps` });
    return;
  }
  expect(fps).toBeGreaterThanOrEqual(50 / FACTOR);
});

test('NFR-1: offline cold start from cache ≤ 3 s', async ({ baseURL }) => {
  const { context, violations } = await launchPersistent(baseURL!, undefined, { serviceWorkers: 'allow' });
  try {
    const page = await context.newPage();
    await openApp(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect(page.locator('[data-ready="true"]')).toBeVisible();
    await context.setOffline(true);
    const cold = await context.newPage();
    const t0 = Date.now();
    await cold.goto('/');
    await expect(cold.locator('[data-ready="true"]')).toBeVisible();
    results['nfr1.seconds'] = (Date.now() - t0) / 1000;
    expect(results['nfr1.seconds']).toBeLessThanOrEqual(3 * (STRICT ? 1 : 2));
    expect(violations).toEqual([]);
  } finally {
    await context.close();
  }
});

test('NFR-10: autosave adds no main-thread block > 16 ms while editing; recovery ≤ 5 s', async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Perf');
  type Hooks = {
    __pat: {
      store(): { commit(label: string, fn: (d: Record<string, unknown>) => void): boolean };
      session(): { engine: { checkpoint(reason: string): Promise<unknown>; flush(): Promise<void> } };
      autosaveTiming(reset?: boolean): {
        maxSyncMs: number;
        totalSyncMs: number;
        samples: number;
        maxByKind: Record<string, number>;
      };
    };
  };
  // A realistic project: 2 000 objects with labels, then a burst of 60 small edits with autosave
  // (journal flushes and a checkpoint snapshot of the full state incl. undo history).
  await page.evaluate(() => {
    const w = window as unknown as Hooks;
    w.__pat.store().commit('Seed', (d) => {
      const objects = d.objects as unknown[];
      for (let i = 0; i < 2000; i++)
        objects.push({
          id: `seed${i}`,
          layerId: d.activeLayerId,
          name: `Seed ${i}`,
          kind: 'shape',
          geometry: {
            type: 'polyline',
            closed: true,
            pts: Array.from({ length: 12 }, (_, k) => ({
              x: (i % 50) * 10 + 3 * Math.cos(k / 2),
              y: Math.floor(i / 50) * 10 + 3 * Math.sin(k / 2),
            })),
          },
          style: {},
          attributes: { tag: `T-${i}`, area_ref: i * 1.5 },
          createdAt: new Date().toISOString(),
          label: { template: '{name}', placement: 'centroid', visible: true },
        });
    });
  });
  await page.evaluate(() => (window as unknown as Hooks).__pat.session().engine.checkpoint('seed'));
  const timing = await page.evaluate(async () => {
    const w = window as unknown as Hooks;
    w.__pat.autosaveTiming(true);
    for (let i = 0; i < 60; i++) {
      w.__pat.store().commit(`Edit ${i}`, (d) => {
        const o = (d.objects as { geometry: { pts: { x: number }[] } }[])[i];
        o.geometry.pts[0].x += 0.5;
      });
      await new Promise((r) => setTimeout(r, 30));
    }
    await w.__pat.session().engine.flush();
    await w.__pat.session().engine.checkpoint('test');
    return w.__pat.autosaveTiming();
  });
  results['nfr10.autosaveMaxSyncMs'] = timing.maxSyncMs;
  results['nfr10.autosaveTotalSyncMs'] = timing.totalSyncMs;
  for (const [k, v] of Object.entries(timing.maxByKind)) results[`nfr10.max.${k}`] = v;
  // Every edit is sampled; journal writes and checkpoints run in workers, so they add none.
  expect(timing.samples).toBeGreaterThanOrEqual(60);
  expect(timing.maxSyncMs).toBeLessThanOrEqual(16 * (STRICT ? 1 : 2));
  // Recovery to an editable state: reload (crash recovery is covered by e2e/kill.spec.ts, which
  // records the same metric under SIGKILL) and time until the project is editable again.
  await page.reload();
  await expect(page.locator('[data-ready="true"]')).toBeVisible();
  const t0 = Date.now();
  await page.getByTestId('recent-projects').getByRole('button').first().click();
  await expect(page.getByTestId('workspace')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  results['nfr10.reopenSeconds'] = (Date.now() - t0) / 1000;
  expect(results['nfr10.reopenSeconds']).toBeLessThanOrEqual(5 * (STRICT ? 1 : 2));
});
