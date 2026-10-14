#!/usr/bin/env node
/**
 * Generates the PDF part of the reference drawing set (row 85):
 *  - plot-plan-a1-1to500.pdf: 3 pages — (1) vector A1 plot plan at 1:500 with tanks (circles drawn as
 *    Béziers), equipment, roads, a site boundary, grid lines and a 100 m reference dimension;
 *    (2) an area layout of part of the site at 1:200; (3) a scanned (raster-only) copy.
 *  - expectations.json: geometry facts used by the tests.
 * Deterministic output (fixed metadata dates).
 */
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { zlibSync } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';

const MM = 72 / 25.4;
const A1 = { w: 841 * MM, h: 594 * MM };
const out = 'tests/fixtures/pdf';
mkdirSync(out, { recursive: true });

/** World metres → page points for a sheet at 1:scale with the world origin at (ox, oy) mm on paper. */
const sheet = (scale, oxMm, oyMm) => (x, y) => [
  (oxMm + (x * 1000) / scale) * MM,
  (oyMm + (y * 1000) / scale) * MM,
];

const tanks = [
  { name: 'T-101', x: 60, y: 140, r: 15 },
  { name: 'T-102', x: 110, y: 140, r: 15 },
  { name: 'T-103', x: 160, y: 140, r: 12.5 },
];
const equipment = [
  { name: 'P-101', x: 70, y: 90, w: 6, h: 3 },
  { name: 'P-102', x: 90, y: 90, w: 6, h: 3 },
  { name: 'V-201', x: 200, y: 60, w: 10, h: 10 },
];

function drawPlan(page, font, xf, scale) {
  const line = (x1, y1, x2, y2, t = 0.35, c = rgb(0, 0, 0)) => {
    const [a, b] = xf(x1, y1);
    const [c2, d] = xf(x2, y2);
    page.drawLine({ start: { x: a, y: b }, end: { x: c2, y: d }, thickness: t * MM, color: c });
  };
  // Site boundary 300 m × 200 m.
  const boundary = [
    [0, 0],
    [300, 0],
    [300, 200],
    [0, 200],
  ];
  for (let i = 0; i < 4; i++) line(...boundary[i], ...boundary[(i + 1) % 4], 0.7);
  // Grid lines every 50 m with labels.
  for (let x = 0; x <= 300; x += 50) {
    line(x, -5, x, 205, 0.18, rgb(0.5, 0.5, 0.5));
    const [px, py] = xf(x, -12);
    page.drawText(`E ${600000 + x}`, { x: px - 12, y: py, size: 7, font, color: rgb(0.3, 0.3, 0.3) });
  }
  for (let y = 0; y <= 200; y += 50) line(-5, y, 305, y, 0.18, rgb(0.5, 0.5, 0.5));
  // Road 10 m wide along y = 20..30.
  line(0, 20, 300, 20, 0.35, rgb(0.4, 0.4, 0.4));
  line(0, 30, 300, 30, 0.35, rgb(0.4, 0.4, 0.4));
  // Tanks (pdf-lib draws circles/ellipses as 4 cubic Béziers).
  for (const t of tanks) {
    const [cx, cy] = xf(t.x, t.y);
    page.drawCircle({
      x: cx,
      y: cy,
      size: ((t.r * 1000) / scale) * MM,
      borderWidth: 0.5 * MM,
      borderColor: rgb(0, 0, 0.6),
    });
    page.drawText(t.name, { x: cx - 10, y: cy - 3, size: 8, font });
  }
  // Bund around the tanks (separate lines with small gaps, as drawn by hand).
  line(35, 115, 185.02, 115, 0.5);
  line(185, 115.03, 185, 165, 0.5);
  line(184.98, 165, 35, 165, 0.5);
  line(35, 164.97, 35, 115, 0.5);
  // Equipment footprints.
  for (const e of equipment) {
    const [x, y] = xf(e.x - e.w / 2, e.y - e.h / 2);
    page.drawRectangle({
      x,
      y,
      width: ((e.w * 1000) / scale) * MM,
      height: ((e.h * 1000) / scale) * MM,
      borderWidth: 0.35 * MM,
      borderColor: rgb(0.6, 0, 0),
    });
  }
  // Reference dimension 100 m from (100, 5) to (200, 5).
  line(100, 5, 200, 5, 0.25, rgb(0, 0.4, 0));
  line(100, 3, 100, 7, 0.25, rgb(0, 0.4, 0));
  line(200, 3, 200, 7, 0.25, rgb(0, 0.4, 0));
  const [dx, dy] = xf(145, 7);
  page.drawText('100 m', { x: dx, y: dy, size: 8, font, color: rgb(0, 0.4, 0) });
}

const doc = await PDFDocument.create();
doc.setTitle('Reference plot plan 1:500');
doc.setCreator('plot-analysis-tool fixtures');
doc.setProducer('pdf-lib');
doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
const font = await doc.embedFont(StandardFonts.Helvetica);

// Page 1: A1 plot plan at 1:500, world origin 100 mm / 100 mm from the sheet's bottom-left corner.
const p1 = doc.addPage([A1.w, A1.h]);
drawPlan(p1, font, sheet(500, 100, 100), 500);
p1.drawText('PLOT PLAN  SCALE 1:500 (A1)', { x: 600 * MM, y: 40 * MM, size: 14, font });

// Page 2: area layout of the tank farm at 1:200 (world (30,110) at 60 mm, 60 mm).
const p2 = doc.addPage([A1.w, A1.h]);
const xf2 = (x, y) => [(60 + ((x - 30) * 1000) / 200) * MM, (60 + ((y - 110) * 1000) / 200) * MM];
drawPlan(p2, font, xf2, 200);
p2.drawText('AREA LAYOUT - TANK FARM  SCALE 1:200 (A1)', { x: 500 * MM, y: 30 * MM, size: 14, font });

// Page 3: scanned copy (raster only) of page 1 at low resolution.
const W = 841 * 2;
const H = 594 * 2; // 2 px per mm
const px = new Uint8Array(W * H).fill(255);
const plot = (x, y) => {
  const ix = Math.round(x);
  const iy = Math.round(H - y);
  if (ix >= 0 && ix < W && iy >= 0 && iy < H) px[iy * W + ix] = 0;
};
const segment = (x1, y1, x2, y2) => {
  const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
  for (let i = 0; i <= n; i++) plot(x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n);
};
const toPx = (x, y) => [(100 + (x * 1000) / 500) * 2, (100 + (y * 1000) / 500) * 2];
const bnd = [
  [0, 0],
  [300, 0],
  [300, 200],
  [0, 200],
];
for (let i = 0; i < 4; i++) segment(...toPx(...bnd[i]), ...toPx(...bnd[(i + 1) % 4]));
for (const t of tanks) {
  const [cx, cy] = toPx(t.x, t.y);
  const r = ((t.r * 1000) / 500) * 2;
  for (let a = 0; a < 720; a++)
    plot(cx + r * Math.cos((a * Math.PI) / 360), cy + r * Math.sin((a * Math.PI) / 360));
}
segment(...toPx(100, 5), ...toPx(200, 5));
// Encode an 8-bit greyscale PNG.
const crc = (buf) => {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
};
const chunk = (type, data) => {
  const t = new TextEncoder().encode(type);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const body = new Uint8Array(t.length + data.length);
  body.set(t);
  body.set(data, t.length);
  const c = new Uint8Array(4);
  new DataView(c.buffer).setUint32(0, crc(body));
  return [len, body, c];
};
const ihdr = new Uint8Array(13);
const dv = new DataView(ihdr.buffer);
dv.setUint32(0, W);
dv.setUint32(4, H);
ihdr[8] = 8;
ihdr[9] = 0;
const raw = new Uint8Array((W + 1) * H);
for (let y = 0; y < H; y++) raw.set(px.subarray(y * W, (y + 1) * W), y * (W + 1) + 1);
const png = Buffer.concat(
  [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlibSync(raw)),
    ...chunk('IEND', new Uint8Array()),
  ].map((b) => Buffer.from(b)),
);
const img = await doc.embedPng(png);
const p3 = doc.addPage([A1.w, A1.h]);
p3.drawImage(img, { x: 0, y: 0, width: A1.w, height: A1.h });

writeFileSync(`${out}/plot-plan-a1-1to500.pdf`, await doc.save({ useObjectStreams: false }));
writeFileSync(
  `${out}/expectations.json`,
  JSON.stringify(
    {
      'plot-plan-a1-1to500.pdf': {
        pages: 3,
        paper: 'A1',
        pageSizePt: [A1.w, A1.h],
        page1: {
          scale: 500,
          worldOriginMm: [100, 100],
          tanks,
          equipment,
          referenceDimension: { from: [100, 5], to: [200, 5], metres: 100 },
        },
        page2: { scale: 200, worldAtMm: { world: [30, 110], mm: [60, 60] } },
        page3: { raster: true },
      },
    },
    null,
    2,
  ),
);
console.log('PDF fixtures written');
