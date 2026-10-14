import { fileURLToPath } from 'node:url';

import { expect, type Page } from '@playwright/test';

/** Helpers for specs that import drawings and pick points on the canvas (rows 26–36). */

export const FIXTURES = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
export const PDF_A1 = `${FIXTURES}pdf/plot-plan-a1-1to500.pdf`;
export const PLOT_PLAN = `${FIXTURES}dxf/r2018_plotplan.dxf`;
export const AREA_LOCAL = `${FIXTURES}dxf/area_layout_local_mm.dxf`;
export const AREA_PLANT_MM = `${FIXTURES}dxf/area_layout_plant_mm_header.dxf`;

export interface Pt {
  x: number;
  y: number;
}

interface PatWindow {
  __pat: { project(): ProjectLike | null; store(): { undo(): boolean } };
  __patCanvas: {
    frame(): { toScreen(p: Pt): Pt; scale: number };
    zoomToBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, margin?: number): void;
    contentBounds(): unknown;
    setView(v: { cx: number; cy: number; scale: number; rotation: number }): void;
  };
}

export interface DrawingLike {
  id: string;
  name: string;
  calibration?: {
    method: string;
    transform: number[];
    residualRms?: number;
    ratio?: number;
    references: { residual?: number }[];
  };
  alignment?: number[];
  unitsOverride?: string;
  verified?: { expected: number; measured: number };
}

export interface ProjectLike {
  drawings: DrawingLike[];
  objects: {
    id: string;
    kind: string;
    name: string;
    layerId: string;
    geometry: { type: string; c?: Pt; r?: number; pts?: Pt[] };
    measurement?: { mode: string; value?: number };
  }[];
  layers: { id: string; name: string }[];
  display: { units: string };
  north: { trueNorthAngle: number; arrow: string };
}

export const project = (page: Page) =>
  page.evaluate(() => (window as unknown as PatWindow).__pat.project()!) as Promise<ProjectLike>;

/** Imports a drawing through File → Import (Ctrl+I); for multi-page PDFs picks the given pages. */
export async function importDrawing(page: Page, file: string, pdfPages?: number[]) {
  const before = (await project(page)).drawings.length;
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+i');
  await (await chooser).setFiles(file);
  if (pdfPages) {
    const picker = page.getByTestId('pdf-page-picker');
    await expect(picker).toBeVisible();
    for (const p of pdfPages) if (p !== 1) await picker.getByText(`Page ${p}`, { exact: true }).click();
    await picker.getByRole('button', { name: /^Import \d+ page/ }).click();
  }
  const n = before + (pdfPages?.length ?? 1);
  await expect.poll(async () => (await project(page)).drawings.length).toBe(n);
  // Wait until the parsed model is installed (it contributes to the content bounds).
  await expect
    .poll(() => page.evaluate(() => !!(window as unknown as PatWindow).__patCanvas.contentBounds()))
    .toBe(true);
  await page.waitForTimeout(300);
}

/**
 * Zooms so that `b` fills the right half of the canvas: the floating panels (calibration, measure
 * results) sit at the top left and must not cover the points a test clicks.
 */
export async function zoomTo(page: Page, b: { minX: number; minY: number; maxX: number; maxY: number }) {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const padded = {
    minX: b.minX - 1.1 * w,
    minY: b.minY - 0.15 * h,
    maxX: b.maxX + 0.05 * w,
    maxY: b.maxY + 0.15 * h,
  };
  await page.evaluate((b) => (window as unknown as PatWindow).__patCanvas.zoomToBounds(b, 40), padded);
  await page.waitForTimeout(150);
}

export const around = (p: Pt, r: number) => ({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r });

/** Page coordinates of a world point. */
export async function screenOf(page: Page, world: Pt): Promise<Pt> {
  const box = (await page.getByTestId('canvas').boundingBox())!;
  const s = await page.evaluate(
    (w) => (window as unknown as PatWindow).__patCanvas.frame().toScreen(w),
    world,
  );
  return { x: box.x + s.x, y: box.y + s.y };
}

/** Moves to and clicks a world point (the tool snaps it to the exact source coordinate). */
export async function clickWorld(page: Page, world: Pt) {
  const s = await screenOf(page, world);
  await page.mouse.move(s.x + 3, s.y + 2);
  await page.mouse.move(s.x, s.y);
  await page.waitForTimeout(50);
  await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(50);
}

export async function hoverWorld(page: Page, world: Pt) {
  const s = await screenOf(page, world);
  await page.mouse.move(s.x + 3, s.y + 2);
  await page.mouse.move(s.x + 1, s.y + 1);
  await page.waitForTimeout(150);
}

export async function menu(page: Page, group: string, item: string | RegExp) {
  await page.getByRole('menuitem', { name: group, exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Clicks a checkable (toggle) menu command. */
export async function menuToggle(page: Page, group: string, item: string | RegExp) {
  await page.getByRole('menuitem', { name: group, exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: item }).click();
}

/** Opens the calibration panel of a drawing from its Drawings menu. */
export async function openCalibration(page: Page, drawingName: string) {
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByRole('button', { name: `Drawing options for ${drawingName}` }).click();
  await page.getByRole('menuitem', { name: 'Calibrate scale…' }).click();
  await expect(page.getByTestId('calibration-panel')).toBeVisible();
}

export function applyAffine(m: number[], p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** World point of a drawing point under the drawing's current placement (alignment ∘ calibration). */
export function placeOf(d: DrawingLike, p: Pt, defaultScale: number): Pt {
  const base = d.calibration?.transform ?? [defaultScale, 0, 0, defaultScale, 0, 0];
  const w = applyAffine(base, p);
  return d.alignment ? applyAffine(d.alignment, w) : w;
}

export const MM_PT = 72 / 25.4;
/** World point (metres) of a site point on page 1 of the 1:500 A1 PDF fixture, uncalibrated (paper 1:1). */
export const paperOf = (x: number, y: number): Pt => ({ x: (100 + 2 * x) / 1000, y: (100 + 2 * y) / 1000 });
/** Same point after a 1:500 calibration. */
export const siteOf = (x: number, y: number): Pt => ({ x: (100 + 2 * x) * 0.5, y: (100 + 2 * y) * 0.5 });
