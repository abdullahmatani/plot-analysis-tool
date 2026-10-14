import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import type { Affine2D } from '@/core/types';
import { GK } from '@/underlay/entity-store';

import { extractPdfVectors, type PdfOps } from './extract';

const MM = 72 / 25.4;
const fixture = 'tests/fixtures/pdf/plot-plan-a1-1to500.pdf';
const exp = JSON.parse(readFileSync('tests/fixtures/pdf/expectations.json', 'utf8'))[
  'plot-plan-a1-1to500.pdf'
];

async function extractPage(n: number) {
  const data = new Uint8Array(readFileSync(fixture));
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false } as never)
    .promise;
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const vt = vp.transform as Affine2D;
  const pageTransform: Affine2D = [vt[0], -vt[1], vt[2], -vt[3], vt[4], vp.height - vt[5]];
  const opList = await page.getOperatorList();
  const r = extractPdfVectors(opList, {
    ops: pdfjs.OPS as unknown as PdfOps,
    pageTransform,
    width: vp.width,
    height: vp.height,
    rotation: vp.rotation,
    ocgs: [],
  });
  await doc.loadingTask.destroy();
  return r;
}

/** Page points → world metres for page 1 (1:500, origin at 100 mm / 100 mm). */
const toWorld = (x: number, y: number) => [((x / MM - 100) * 500) / 1000, ((y / MM - 100) * 500) / 1000];

describe('PDF vector extraction (row 16)', () => {
  it('extracts paths in page coordinates and detects circles drawn as Béziers', async () => {
    const r = await extractPage(1);
    expect(r.page?.raster).toBe(false);
    expect(r.page?.width).toBeCloseTo(exp.pageSizePt[0], 6);
    const s = r.store;
    const circles: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < s.count; i++) {
      if (s.geomKind[i] !== GK.CIRCLE) continue;
      const o = s.geomStart[i];
      const [x, y] = toWorld(s.geom[o], s.geom[o + 1]);
      circles.push({ x, y, r: (s.geom[o + 2] / MM) * 0.5 });
    }
    expect(circles).toHaveLength(exp.page1.tanks.length);
    for (const t of exp.page1.tanks) {
      const c = circles.find((k) => Math.hypot(k.x - t.x, k.y - t.y) < 0.01);
      expect(c, t.name).toBeTruthy();
      expect(c!.r).toBeCloseTo(t.r, 2);
    }
    // The 100 m reference dimension line is present with exact endpoints.
    let found = false;
    for (let i = 0; i < s.count; i++) {
      if (s.geomKind[i] !== GK.LINE) continue;
      const o = s.geomStart[i];
      const [x1, y1] = toWorld(s.geom[o], s.geom[o + 1]);
      const [x2, y2] = toWorld(s.geom[o + 2], s.geom[o + 3]);
      // pdf.js keeps path data as float32: ~1e-5 m at 1:500, well inside NFR-7 (1 mm).
      if (
        Math.abs(x1 - 100) < 1e-3 &&
        Math.abs(y1 - 5) < 1e-3 &&
        Math.abs(x2 - 200) < 1e-3 &&
        Math.abs(y2 - 5) < 1e-3
      )
        found = true;
    }
    expect(found).toBe(true);
  });

  it('flags scanned (raster-only) pages', async () => {
    const r = await extractPage(3);
    expect(r.page?.raster).toBe(true);
    expect(r.report.warnings.join(' ')).toMatch(/raster/i);
  });
});
