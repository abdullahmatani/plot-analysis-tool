import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';

import { guardEgress, killBrowser } from './fixtures';

/**
 * Row 102: autosave fault-injection suite. The browser process is killed (SIGKILL) at random points
 * while editing, while a snapshot is being written and while the linked project file is being
 * written; the network is disconnected throughout (after the first load). After every kill the
 * project is recovered and checked:
 *   - no edit committed more than 1 s before the kill is lost (NFR-9),
 *   - recovered edits are an exact, in-order prefix of the committed sequence (nothing interleaved),
 *   - the linked project file is always a complete, readable project (never corrupted).
 * KILL_POINTS sets the number of kill-points (default 100).
 */

const KILL_POINTS = Number(process.env.KILL_POINTS ?? 100);
const SEED = Number(process.env.KILL_SEED ?? Date.now() % 100000);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Edit {
  name: string;
  at: number;
}

test('autosave survives 100 random kill-points with zero lost edits beyond NFR-9 (row 102)', async ({
  baseURL,
}) => {
  test.setTimeout(Math.max(10 * 60_000, KILL_POINTS * 15_000));
  const rand = rng(SEED);
  console.log(`fault-injection: ${KILL_POINTS} kill-points, seed ${SEED}`);
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'pat-kill-'));
  const confirmed: Edit[] = []; // every edit reported by the page, in commit order
  let killAt = 0;
  let projectReady = false;
  const stats = { editing: 0, snapshot: 0, 'file-write': 0, recovered: 0, maxRecoveryMs: 0 };

  for (let iter = 0; iter < KILL_POINTS; iter++) {
    const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
      baseURL,
      serviceWorkers: 'allow',
    });
    const violations = await guardEgress(context, baseURL!);
    const page: Page = context.pages()[0] ?? (await context.newPage());
    const reports: Edit[] = [];
    await page.exposeBinding('__reportEdit', (_src, name: string, at: number) => {
      reports.push({ name, at });
    });
    if (iter > 0) await context.setOffline(true);
    const t0 = Date.now();
    await page.goto('/');
    await page.waitForSelector('[data-ready="true"]');
    if (!projectReady) {
      // First load online: let the service worker finish precaching so later runs work offline.
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await page.getByTestId('new-project').click();
      await page.getByLabel('Project name').fill('Fault injection');
      await page.getByTestId('create-project').click();
      projectReady = true;
    } else {
      const dialog = page.getByTestId('recovery-dialog');
      const recent = page.getByTestId('recent-projects').getByRole('button').first();
      await expect(dialog.or(recent)).toBeVisible();
      if (await dialog.isVisible()) {
        await page.getByTestId('recovery-apply').click();
        stats.recovered++;
      } else {
        await recent.click();
      }
    }
    await page.waitForSelector('[data-testid="workspace"]');
    stats.maxRecoveryMs = Math.max(stats.maxRecoveryMs, Date.now() - t0);

    // --- verify the previous kill lost nothing older than 1 s, and the order is intact ---
    const names: string[] = await page.evaluate(() => {
      const w = window as unknown as { __pat: { project(): { layers: { name: string }[] } } };
      return w.__pat
        .project()
        .layers.map((l) => l.name)
        .slice(1);
    });
    const mustHave = confirmed.filter((e) => e.at < killAt - 1000).map((e) => e.name);
    expect(
      names.slice(0, mustHave.length),
      `iteration ${iter}: edits older than 1 s before the kill`,
    ).toEqual(mustHave);
    // Recovered sequence must be an in-order prefix of everything the page committed.
    expect(confirmed.slice(0, names.length).map((e) => e.name)).toEqual(
      names.slice(0, Math.min(names.length, confirmed.length)),
    );
    // Whatever was recovered becomes the new baseline.
    confirmed.length = 0;
    for (const n of names) confirmed.push({ name: n, at: 0 });

    // --- linked file must always be a complete project ---
    const fileBytes = await page.evaluate(() =>
      (window as unknown as { __pat: { readTestFile(): Promise<number[] | null> } }).__pat.readTestFile(),
    );
    if (fileBytes && fileBytes.length > 0) {
      const files = unzipSync(new Uint8Array(fileBytes));
      const json = JSON.parse(new TextDecoder().decode(files['project.json'])) as {
        project: { layers: unknown[] };
      };
      expect(Array.isArray(json.project.layers), `iteration ${iter}: linked file readable`).toBe(true);
    }
    expect(violations).toEqual([]);

    if (iter === KILL_POINTS - 1) {
      await context.close();
      break;
    }

    // --- next fault ---
    const phase = (['editing', 'snapshot', 'file-write'] as const)[Math.floor(rand() * 3)];
    stats[phase]++;
    if (phase === 'file-write') {
      await page.evaluate(() =>
        (window as unknown as { __pat: { linkTestFile(): Promise<boolean> } }).__pat.linkTestFile(),
      );
    }
    const editCount = 3 + Math.floor(rand() * 25);
    const gap = Math.floor(rand() * 80);
    const killDelay = 150 + Math.floor(rand() * 1800);
    if (process.env.KILL_VERBOSE)
      console.log(
        `iteration ${iter}: ${phase}, ${editCount} edits, gap ${gap} ms, kill after ${killDelay} ms`,
      );
    void page
      .evaluate(
        async ([iter, editCount, gap, phase]) => {
          const w = window as unknown as {
            __pat: {
              addLayer(l: string, n: string): boolean;
              session(): {
                engine: { checkpoint(r: string): Promise<unknown> };
                file: { write(): Promise<boolean> };
              };
            };
            __reportEdit(name: string, at: number): void;
          };
          for (let n = 0; n < editCount; n++) {
            const name = `K${iter}_${n}`;
            if (w.__pat.addLayer('Add layer', name)) w.__reportEdit(name, Date.now());
            if (phase === 'snapshot' && n === Math.floor(editCount / 2))
              void w.__pat.session().engine.checkpoint('test');
            if (phase === 'file-write' && n % 4 === 0) void w.__pat.session().file.write();
            await new Promise((r) => setTimeout(r, gap));
          }
        },
        [iter, editCount, gap, phase] as const,
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, killDelay));
    killAt = Date.now();
    const killed = killBrowser(userDataDir);
    expect(killed, 'browser processes killed').toBeGreaterThan(0);
    await context.close().catch(() => {});
    for (const r of reports) confirmed.push(r);
  }
  console.log(`fault-injection stats: ${JSON.stringify(stats)}`);
});
