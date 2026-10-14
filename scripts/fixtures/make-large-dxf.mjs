#!/usr/bin/env node
/**
 * Generates a large synthetic ASCII DXF plot plan for performance tests (NFR-2, NFR-4): a site of
 * ~2 km × 1.5 km in UTM-like coordinates with pipe racks, buildings, tanks, roads and text, about
 * 200 000 line segments and ~20 MB. Deterministic (seeded) so results are comparable between runs.
 *
 *   node scripts/fixtures/make-large-dxf.mjs <out.dxf> [targetMB=20]
 */
import { createWriteStream } from 'node:fs';

const out = process.argv[2];
const targetMB = Number(process.argv[3] ?? 20);
if (!out) {
  console.error('usage: make-large-dxf.mjs <out.dxf> [targetMB]');
  process.exit(2);
}

let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const X0 = 512000;
const Y0 = 2710000;
const f = (v) => v.toFixed(4);

const LAYERS = [
  ['0', 7],
  ['A-BLDG', 2],
  ['P-RACK', 4],
  ['M-EQPT', 3],
  ['C-ROAD', 8],
  ['G-TEXT', 7],
  ['T-TANK', 6],
  ['E-CABLE', 1],
];

const ws = createWriteStream(out);
let bytes = 0;
const w = (s) => {
  bytes += s.length;
  ws.write(s);
};
const pair = (code, value) => w(`${code}\n${value}\n`);

// Header, tables
pair(0, 'SECTION');
pair(2, 'HEADER');
pair(9, '$ACADVER');
pair(1, 'AC1015');
pair(9, '$INSUNITS');
pair(70, 6);
pair(0, 'ENDSEC');
pair(0, 'SECTION');
pair(2, 'TABLES');
pair(0, 'TABLE');
pair(2, 'LAYER');
pair(70, LAYERS.length);
for (const [name, color] of LAYERS) {
  pair(0, 'LAYER');
  pair(2, name);
  pair(70, 0);
  pair(62, color);
  pair(6, 'CONTINUOUS');
}
pair(0, 'ENDTAB');
pair(0, 'ENDSEC');
pair(0, 'SECTION');
pair(2, 'ENTITIES');

let segments = 0;
const line = (layer, x1, y1, x2, y2) => {
  pair(0, 'LINE');
  pair(8, layer);
  pair(10, f(X0 + x1));
  pair(20, f(Y0 + y1));
  pair(30, '0.0');
  pair(11, f(X0 + x2));
  pair(21, f(Y0 + y2));
  pair(31, '0.0');
  segments++;
};
const lwpoly = (layer, pts, closed) => {
  pair(0, 'LWPOLYLINE');
  pair(8, layer);
  pair(90, pts.length);
  pair(70, closed ? 1 : 0);
  for (const [x, y] of pts) {
    pair(10, f(X0 + x));
    pair(20, f(Y0 + y));
  }
  segments += closed ? pts.length : pts.length - 1;
};
const circle = (layer, x, y, r) => {
  pair(0, 'CIRCLE');
  pair(8, layer);
  pair(10, f(X0 + x));
  pair(20, f(Y0 + y));
  pair(30, '0.0');
  pair(40, f(r));
};
const text = (layer, x, y, h, s) => {
  pair(0, 'TEXT');
  pair(8, layer);
  pair(10, f(X0 + x));
  pair(20, f(Y0 + y));
  pair(30, '0.0');
  pair(40, f(h));
  pair(1, s);
};

const target = targetMB * 1024 * 1024;
let block = 0;
// Plot blocks of 100 m × 100 m on a 20 × 15 grid; repeat with offsets until the size target is met.
outer: for (let pass = 0; pass < 50; pass++) {
  for (let bx = 0; bx < 20; bx++) {
    for (let by = 0; by < 15; by++) {
      const ox = bx * 100 + pass * 0.37;
      const oy = by * 100 + pass * 0.21;
      block++;
      // Roads around the block.
      lwpoly(
        'C-ROAD',
        [
          [ox, oy],
          [ox + 100, oy],
          [ox + 100, oy + 100],
          [ox, oy + 100],
        ],
        true,
      );
      // Pipe rack: many parallel lines.
      for (let k = 0; k < 24; k++) line('P-RACK', ox + 5, oy + 10 + k * 0.6, ox + 95, oy + 10 + k * 0.6);
      // Buildings.
      for (let k = 0; k < 4; k++) {
        const x = ox + 10 + rnd() * 60;
        const y = oy + 35 + rnd() * 40;
        const wdt = 5 + rnd() * 15;
        const hgt = 5 + rnd() * 10;
        lwpoly(
          'A-BLDG',
          [
            [x, y],
            [x + wdt, y],
            [x + wdt, y + hgt],
            [x + wdt / 2, y + hgt + 2],
            [x, y + hgt],
          ],
          true,
        );
        text('G-TEXT', x + 0.5, y + 0.5, 1.2, `B-${block}-${k}`);
      }
      // Equipment and tanks.
      for (let k = 0; k < 6; k++) circle('M-EQPT', ox + 15 + k * 12, oy + 85, 1.5 + rnd() * 2);
      circle('T-TANK', ox + 80, oy + 55, 8 + rnd() * 4);
      // Cable trays as short segments.
      for (let k = 0; k < 40; k++) {
        const x = ox + rnd() * 100;
        const y = oy + rnd() * 100;
        line('E-CABLE', x, y, x + rnd() * 6 - 3, y + rnd() * 6 - 3);
      }
      if (bytes >= target) break outer;
    }
  }
}

pair(0, 'ENDSEC');
pair(0, 'EOF');
ws.end(() => console.log(`${out}: ${(bytes / 1048576).toFixed(1)} MB, ~${segments} segments`));
