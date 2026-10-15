import type { Page } from '@playwright/test';

import { PLOT_PLAN, importDrawing, type Pt } from './drawing-helpers';
import { createProject, expect, openApp, test } from './fixtures';
import { decodePng } from './png';

/**
 * Curves at high zoom (rows 14, 27): arcs and circles are drawn as smooth as a CAD viewer draws
 * them, so a point snapped on a circle sits on the drawn line. Before 0.1.6 a circle was drawn with
 * the same chords at every zoom: on the reference plot plan, up to 0.8 mm (16 px at 0.05 mm per
 * pixel) inside the true circle.
 */

const TANK: Pt = { x: 600_200, y: 2_500_150 }; // tank T-101 shell, radius 15 m
const R = 15;

interface Hooks {
  __pat: { project(): { drawings: { id: string }[] } | null };
  __patCanvas: {
    frame(): { toScreen(p: Pt): Pt; width: number };
    setView(v: { cx: number; cy: number; scale: number; rotation: number }): void;
    detailWindows(): Record<string, unknown>;
  };
}

/** Radial offsets (device px) of the drawn shell from the true circle near angle `theta`. */
async function shellOffsets(page: Page, theta: number, scale: number): Promise<number[]> {
  const at = (a: number): Pt => ({ x: TANK.x + R * Math.cos(a), y: TANK.y + R * Math.sin(a) });
  await page.evaluate(
    ([c, s]) => (window as unknown as Hooks).__patCanvas.setView({ cx: c.x, cy: c.y, scale: s, rotation: 0 }),
    [at(theta), scale] as const,
  );
  await page.waitForTimeout(250);
  const shot = decodePng(await page.getByTestId('canvas-container').screenshot());
  const angles = [-200, 0, 200].map((u) => theta + u / (scale * R));
  const { pts, w } = await page.evaluate((ps) => {
    const f = (window as unknown as Hooks).__patCanvas.frame();
    return { pts: ps.map((p) => f.toScreen(p)), w: f.width };
  }, angles.map(at));
  const k = shot.width / w;
  const bg = shot.px(5, 5);
  const ink = (x: number, y: number) => {
    const p = shot.px(Math.floor(x), Math.floor(y));
    return Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
  };
  return angles.map((a, i) => {
    // Outward radial direction on screen (y down).
    const n = { x: Math.cos(a), y: -Math.sin(a) };
    let sum = 0;
    let weight = 0;
    for (let o = -40; o <= 40; o += 0.5) {
      const v = ink(pts[i].x * k + n.x * o, pts[i].y * k + n.y * o);
      sum += v * o;
      weight += v;
    }
    expect(weight, `the shell is drawn near ${a.toFixed(4)} rad`).toBeGreaterThan(100);
    return sum / weight;
  });
}

test('a tank shell stays a circle at high zoom: drawn where it snaps (rows 14, 27)', async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Curves');
  await importDrawing(page, PLOT_PLAN);
  const id = await page.evaluate(() => (window as unknown as Hooks).__pat.project()!.drawings[0].id);
  // Across one chord of the full build's tessellation (296 per circle on this plan), so one of the
  // views lands where those chords are farthest from the circle: 1.6 px at 2 000 px/m and 4.9 px at
  // 6 000 px/m before (a zoom where float32 precision alone would not switch to detail batches).
  for (const scale of [2_000, 6_000, 20_000]) {
    for (let j = 0; j < 8; j++) {
      const offsets = await shellOffsets(page, 0.8 + (j * (2 * Math.PI)) / 296 / 8, scale);
      expect(
        await page.evaluate(() => Object.keys((window as unknown as Hooks).__patCanvas.detailWindows())),
      ).toEqual([id]);
      for (const o of offsets) expect(Math.abs(o)).toBeLessThan(1);
    }
  }
});
