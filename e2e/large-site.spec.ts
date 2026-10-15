import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { importDrawing, type Pt } from './drawing-helpers';
import { createProject, expect, openApp, test } from './fixtures';
import { decodePng } from './png';

/**
 * Large-coordinate rendering on a 10 km site (row 18, NFR-7 extents): at the maximum zoom a long line
 * is drawn exactly where the app's own float64 screen mapping puts it, wherever along the line the
 * view is, and while the view pans. Before 0.1.5 the GPU's float32 offsets put such a line tens of
 * pixels off at this zoom.
 */

const X0 = 600_000;
const Y0 = 2_500_000;
const A: Pt = { x: X0 + 0.123, y: Y0 + 0.456 };
const B: Pt = { x: X0 + 9_999.211, y: Y0 + 9_700.321 };
const MAX_SCALE = 2e5; // px per metre (render/view.ts)

/** A 10 km × 10 km site in metres: a grid of short red-free marks and one red diagonal across it. */
function siteDxf(): string {
  const out = path.resolve('test-results', 'large-site', 'site-10km.dxf');
  mkdirSync(path.dirname(out), { recursive: true });
  // Group code / value pairs, one per line; $INSUNITS 6 = metres.
  const dxf = [
    '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n6\n0\nENDSEC',
    '0\nSECTION\n2\nENTITIES',
  ];
  const line = (a: Pt, b: Pt, colour: number) =>
    dxf.push(`0\nLINE\n8\n0\n62\n${colour}\n10\n${a.x}\n20\n${a.y}\n11\n${b.x}\n21\n${b.y}`);
  for (let i = 0; i <= 20; i++)
    for (let j = 0; j <= 20; j++) {
      const p = { x: X0 + i * 500, y: Y0 + j * 500 };
      line(p, { x: p.x + 4, y: p.y + 3 }, 3);
    }
  line(A, B, 1);
  dxf.push('0\nENDSEC\n0\nEOF');
  writeFileSync(out, dxf.join('\n'));
  return out;
}

interface Hooks {
  __pat: { project(): { drawings: { id: string }[] } | null };
  __patCanvas: {
    frame(): { toScreen(p: Pt): Pt; width: number; height: number };
    setView(v: { cx: number; cy: number; scale: number; rotation: number }): void;
    zoomExtents(): void;
    detailWindows(): Record<string, unknown>;
  };
}

const along = (t: number): Pt => ({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });

/**
 * Offsets (device px) of the drawn red line from where the app maps it, measured across the line at
 * several places on screen.
 */
async function lineOffsets(page: Page, centre: Pt): Promise<number[]> {
  await page.waitForTimeout(250);
  const shot = decodePng(await page.getByTestId('canvas-container').screenshot());
  const { s0, s1, w } = await page.evaluate(
    ([p, q]) => {
      const f = (window as unknown as Hooks).__patCanvas.frame();
      return { s0: f.toScreen(p), s1: f.toScreen(q), w: f.width };
    },
    [centre, { x: centre.x + (B.x - A.x) * 1e-7, y: centre.y + (B.y - A.y) * 1e-7 }] as const,
  );
  const k = shot.width / w; // device pixels per CSS pixel
  const len = Math.hypot(s1.x - s0.x, s1.y - s0.y);
  const d = { x: (s1.x - s0.x) / len, y: (s1.y - s0.y) / len };
  const n = { x: -d.y, y: d.x };
  const red = (x: number, y: number) => {
    const [r, gr, b] = shot.px(Math.floor(x), Math.floor(y));
    return r - Math.max(gr, b);
  };
  const offsets: number[] = [];
  for (const u of [-150, -50, 0, 50, 150]) {
    const c = { x: (s0.x + d.x * u) * k, y: (s0.y + d.y * u) * k };
    // The line's centre across it: the red-weighted mean offset within ±60 device px.
    let sum = 0;
    let weight = 0;
    for (let o = -60; o <= 60; o += 0.5) {
      const v = Math.max(0, red(c.x + n.x * o, c.y + n.y * o));
      sum += v * o;
      weight += v;
    }
    expect(weight, `the line is drawn near ${u} px along it`).toBeGreaterThan(100);
    offsets.push(Math.abs(sum / weight));
  }
  return offsets;
}

test('a long line on a 10 km site is drawn exactly where it is at the maximum zoom (row 18)', async ({
  page,
}) => {
  await openApp(page);
  await createProject(page, 'Large site');
  await importDrawing(page, siteDxf());
  const id = await page.evaluate(() => (window as unknown as Hooks).__pat.project()!.drawings[0].id);
  const windows = () =>
    page.evaluate(() => Object.keys((window as unknown as Hooks).__patCanvas.detailWindows()));
  await page.evaluate(() => (window as unknown as Hooks).__patCanvas.zoomExtents());
  await page.waitForTimeout(200);
  expect(await windows(), 'the whole site needs no detail batches').toEqual([]);

  for (const [t, rotation] of [
    [0.02, 0],
    [0.5, 0.7],
    [0.97, -2.2],
  ] as const) {
    const p = along(t);
    await page.evaluate(
      ([p, r, s]) =>
        (window as unknown as Hooks).__patCanvas.setView({ cx: p.x, cy: p.y, scale: s, rotation: r }),
      [p, rotation, MAX_SCALE] as const,
    );
    expect(await windows()).toEqual([id]);
    for (const off of await lineOffsets(page, p)) expect(off).toBeLessThan(1);
  }

  // Panning at the maximum zoom, across several detail windows: no visible wobble.
  for (let i = 0; i < 6; i++) {
    const p = along(0.9 + i * 4e-7); // 5.6 mm apart; the canvas shows about 6 mm
    await page.evaluate(
      ([p, s]) =>
        (window as unknown as Hooks).__patCanvas.setView({
          cx: p.x + 0.0002,
          cy: p.y - 0.0001,
          scale: s,
          rotation: 0.3,
        }),
      [p, MAX_SCALE] as const,
    );
    for (const off of await lineOffsets(page, p)) expect(off).toBeLessThan(1);
  }

  // Back to the whole site: the detail batches are dropped.
  await page.evaluate(() => (window as unknown as Hooks).__patCanvas.zoomExtents());
  await page.waitForTimeout(200);
  expect(await windows()).toEqual([]);
});
