import { writeFileSync } from 'node:fs';

import type { Page } from '@playwright/test';

import { importDrawing, type Pt } from './drawing-helpers';
import { createProject, expect, openApp, test } from './fixtures';

/**
 * Large-coordinate rendering at the maximum zoom (row 18), alongside e2e/large-site.spec.ts: lines
 * of several lengths and angles, the edges of large solid fills and the shared edge of two fill
 * triangles, at X 600 000 / Y 2 500 000. The WebGL canvas is read back while the view pans in
 * 0.1 px steps, and each line or fill edge is compared with its float64 position (averaged over 64
 * rows). These are the cases a float32 vertex path gets wrong: a quad built around ends far off
 * the canvas loses a diagonal line's width (the line vanishes), fill edges between far corners
 * land px away, and fill triangles cut separately by the GPU's clipper leave a seam.
 */

const MAX_SCALE = 2e5;
const X0 = 600_000;
const Y0 = 2_500_000;

interface Line {
  name: string;
  x: number;
  y: number;
  length: number;
  angle: number;
}

// Each line starts 500 m above the previous one, so no other line is near a probe point.
const LINES: Line[] = [
  { name: '20 m at 30°', x: X0 + 0.123, y: Y0 + 0.456, length: 20, angle: Math.PI / 6 },
  { name: '200 m at 45°', x: X0 + 0.789, y: Y0 + 500.321, length: 200, angle: Math.PI / 4 },
  { name: '1 km at 30°', x: X0 + 0.654, y: Y0 + 1000.987, length: 1000, angle: Math.PI / 6 },
  { name: '10 km at 30°', x: X0 + 0.111, y: Y0 + 1500.222, length: 10_000, angle: Math.PI / 6 },
  { name: '10 km at 80°', x: X0 + 9000.333, y: Y0 + 0.444, length: 10_000, angle: (80 * Math.PI) / 180 },
];

/**
 * Right-angled fills: legs along +x and +y (0.437 × as long) from the corner; the hypotenuse is
 * probed. Its slope makes successive rows cross the edge at different sub-pixel phases, which the
 * row average needs (at 45° every row would see the same antialiasing step).
 */
const FILLS = [20, 200, 1000, 5000].map((size, i) => ({
  name: `${size >= 1000 ? `${size / 1000} km` : `${size} m`} fill`,
  x: X0 + 0.321 + i * 6000,
  y: Y0 + 0.654,
  size,
}));
/** A 2 km square fill: drawn as two triangles whose shared diagonal must not show. */
const SQUARE = { x: X0 + 30_000.111, y: Y0 + 0.222, size: 2000 };

/** Stored as the DXF file writes it. */
const r6 = (p: Pt): Pt => ({ x: +p.x.toFixed(6), y: +p.y.toFixed(6) });

const lineEnds = (l: Line) =>
  [
    { x: l.x, y: l.y },
    { x: l.x + l.length * Math.cos(l.angle), y: l.y + l.length * Math.sin(l.angle) },
  ].map(r6);

/** A DXF of LINEs and SOLIDs (corners in the SOLID's 1-2-4-3 order). */
function dxf(lines: Pt[][], solids: Pt[][]): string {
  const out: (string | number)[] = [];
  const pair = (code: number, value: string | number) => out.push(code, value);
  for (const [c, v] of [
    [0, 'SECTION'],
    [2, 'HEADER'],
    [9, '$ACADVER'],
    [1, 'AC1015'],
    [9, '$INSUNITS'],
    [70, 6],
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'TABLES'],
    [0, 'TABLE'],
    [2, 'LAYER'],
    [70, 1],
    [0, 'LAYER'],
    [2, '0'],
    [70, 0],
    [62, 7],
    [6, 'CONTINUOUS'],
    [0, 'ENDTAB'],
    [0, 'ENDSEC'],
    [0, 'SECTION'],
    [2, 'ENTITIES'],
  ] as const)
    pair(c, v);
  for (const [a, b] of lines) {
    for (const [c, v] of [
      [0, 'LINE'],
      [8, '0'],
      [10, a.x],
      [20, a.y],
      [30, 0],
      [11, b.x],
      [21, b.y],
      [31, 0],
    ] as const)
      pair(c, typeof v === 'number' ? v.toFixed(6) : v);
  }
  for (const s of solids) {
    pair(0, 'SOLID');
    pair(8, '0');
    s.forEach((p, i) => {
      pair(10 + i, p.x.toFixed(6));
      pair(20 + i, p.y.toFixed(6));
      pair(30 + i, '0.0');
    });
  }
  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  return out.join('\n') + '\n';
}

interface Sample {
  /** Distance of the drawn line or fill edge from its float64 position, device px (row mean). */
  error: number;
  /**
   * Line: least sum of alpha / 255 over the rows, the line's extent along a row (px).
   * Fill: least alpha (0–255) inside the canvas region read, which shows any seam.
   */
  coverage: number;
}

/** Rows read around the canvas centre; averaging over them evens out antialiasing steps. */
const ROWS = 64;

/**
 * Pans across the point at `at` (0–1) of the straight edge a–b at MAX_SCALE and finds it on the rows
 * around the centre: a line by the centroid of its alpha along each row; a fill edge by the extent
 * of the fill along each row (the fill must cover each row from the canvas's left side to the edge).
 * With `interior`, only checks that the fill covers every pixel read (no seam).
 */
async function probe(page: Page, a: Pt, b: Pt, kind: 'line' | 'fill' | 'interior', at = 0.37) {
  return page.evaluate(
    async ({ a, b, kind, at, scale, rows }) => {
      type Canvas = {
        renderer: {
          gl: WebGL2RenderingContext;
          drawings: Map<string, { pendingSegs?: unknown[]; pendingTris?: unknown[] }>;
        };
        setView(v: { cx: number; cy: number; scale: number; rotation: number }): void;
        frame(): { width: number; height: number; toScreen(p: Pt): Pt };
      };
      const c = (window as unknown as { __patCanvas: Canvas }).__patCanvas;
      const gl = c.renderer.gl;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      while ([...c.renderer.drawings.values()].some((d) => d.pendingSegs?.length || d.pendingTris?.length))
        await frame();
      const out: { error: number; coverage: number }[] = [];
      const px = a.x + (b.x - a.x) * at;
      const py = a.y + (b.y - a.y) * at;
      for (let k = 0; k < 10; k++) {
        c.setView({ cx: px + (0.3 + k * 0.1) / scale, cy: py - 0.2 / scale, scale, rotation: 0 });
        await frame();
        await frame();
        const W = gl.drawingBufferWidth;
        const H = gl.drawingBufferHeight;
        const f = c.frame();
        const top = Math.floor(H / 2) - rows / 2;
        const pixels = new Uint8Array(W * rows * 4);
        gl.readPixels(0, H - top - rows, W, rows, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        // The float64 edge on screen, in device px.
        const sa = f.toScreen(a);
        const sb = f.toScreen(b);
        const ax = (sa.x / f.width) * W;
        const ay = (sa.y / f.height) * H;
        const dx = ((sb.x - sa.x) / f.width) * W;
        const dy = ((sb.y - sa.y) / f.height) * H;
        const sin = Math.abs(dy) / Math.hypot(dx, dy);
        let error = 0;
        let coverage = Infinity;
        for (let r = 0; r < rows; r++) {
          // readPixels rows run bottom-up.
          const base = (rows - 1 - r) * W * 4;
          let sum = 0;
          let moment = 0;
          let max = 0;
          let min = 255;
          for (let x = 0; x < W; x++) {
            const alpha = pixels[base + x * 4 + 3];
            sum += alpha;
            moment += alpha * (x + 0.5);
            max = Math.max(max, alpha);
            min = Math.min(min, alpha);
          }
          const expected = ax + ((top + r + 0.5 - ay) * dx) / dy;
          if (kind === 'line') {
            coverage = Math.min(coverage, sum / 255);
            error += sum ? (moment / sum - expected) * sin : NaN;
          } else if (kind === 'fill') {
            coverage = Math.min(coverage, max);
            error += max ? (sum / max - expected) * sin : NaN;
          } else {
            coverage = Math.min(coverage, min);
          }
        }
        out.push({ error: error / rows, coverage });
      }
      return out;
    },
    { a, b, kind, at, scale: MAX_SCALE, rows: ROWS },
  );
}

function summarise(name: string, samples: Sample[]) {
  const errors = samples.map((s) => s.error);
  return {
    coverage: Math.min(...samples.map((s) => s.coverage)),
    worst: Math.max(...errors.map(Math.abs)),
    spread: Math.max(...errors) - Math.min(...errors),
    line(unit: string) {
      return `${name}: coverage ≥ ${this.coverage.toFixed(2)} ${unit}, error ≤ ${this.worst.toFixed(2)} px, spread ${this.spread.toFixed(2)} px`;
    },
  };
}

async function open(page: Page, file: string, lines: Pt[][], solids: Pt[][]) {
  writeFileSync(file, dxf(lines, solids));
  await openApp(page);
  await createProject(page, 'Large coordinates');
  await importDrawing(page, file);
}

test('long diagonal lines at UTM coordinates stay in place and visible at maximum zoom', async ({
  page,
}, info) => {
  await open(page, info.outputPath('diagonals.dxf'), LINES.map(lineEnds), []);
  const report: string[] = [];
  for (const l of LINES) {
    const [a, b] = lineEnds(l);
    const s = summarise(l.name, await probe(page, a, b, 'line'));
    report.push(s.line('px'));
    // A 1 px line crossing a row at angle θ covers about 1/sin θ px of it; nothing when it is lost.
    expect.soft(s.coverage, `${l.name}: visible on every row`).toBeGreaterThan(0.6);
    expect.soft(s.worst, `${l.name}: position`).toBeLessThanOrEqual(0.5);
    expect.soft(s.spread, `${l.name}: wobble while panning`).toBeLessThanOrEqual(0.25);
  }
  info.annotations.push({ type: 'measured', description: report.join('; ') });
  console.log(report.join('\n'));
});

test('large fills at UTM coordinates keep their edges in place and show no seams at maximum zoom', async ({
  page,
}, info) => {
  const triangles = FILLS.map(({ x, y, size }) =>
    [
      { x, y },
      { x: x + size, y },
      { x, y: y + size * 0.437 },
      { x, y: y + size * 0.437 },
    ].map(r6),
  );
  const { x, y, size } = SQUARE;
  const square = [
    { x, y },
    { x: x + size, y },
    { x, y: y + size },
    { x: x + size, y: y + size },
  ].map(r6);
  await open(page, info.outputPath('fills.dxf'), [], [...triangles, square]);
  const report: string[] = [];
  for (const [i, fill] of FILLS.entries()) {
    // The hypotenuse, from the corner on the x leg to the corner on the y leg; the fill is to its
    // left on screen, so it covers each row from the canvas's left side to the edge.
    const [, b, c] = triangles[i];
    const s = summarise(fill.name, await probe(page, b, c, 'fill'));
    report.push(s.line('alpha'));
    expect.soft(s.coverage, `${fill.name}: visible`).toBeGreaterThan(200);
    expect.soft(s.worst, `${fill.name}: edge position`).toBeLessThanOrEqual(0.5);
    expect.soft(s.spread, `${fill.name}: wobble while panning`).toBeLessThanOrEqual(0.25);
  }
  // The centre of the square lies on whichever diagonal the triangulation chose.
  const centre = await probe(page, square[0], square[3], 'interior', 0.5);
  const seam = Math.min(...centre.map((s) => s.coverage));
  report.push(`2 km square: least alpha on the diagonal ${seam}`);
  // A seam shows as partly transparent pixels along the diagonal (alpha 192 of 255 when it occurred).
  expect.soft(seam, '2 km square: no seam along the shared diagonal').toBeGreaterThanOrEqual(250);
  info.annotations.push({ type: 'measured', description: report.join('; ') });
  console.log(report.join('\n'));
});
