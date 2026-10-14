#!/usr/bin/env node
/**
 * Downloads the DWG test fixtures (tests/fixtures/dwg/) from the LibreDWG repository at a pinned
 * commit and verifies their SHA-256 sums. Files that are already present with the right sum are
 * kept. The fixtures are GPL-3.0 test data of LibreDWG and are used only by tests (see the README
 * in the fixture folder).
 *
 *   node scripts/fixtures/dwg-fetch.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'f860b0fb76d5f8effb5a70769a3389cb1e0308c8';
const BASE = `https://raw.githubusercontent.com/LibreDWG/libredwg/${COMMIT}/test/test-data/`;
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/dwg');

/** [local name, upstream path, sha256] */
const FILES = [
  [
    'example_2018.dwg',
    'example_2018.dwg',
    '7bc7721224003062b237845842b7a976e46771c37eba6833b9ed3712e7a5a65a',
  ],
  [
    'example_2013.dwg',
    'example_2013.dwg',
    'ce80953e4881899cde8c42b97919feb2697259554ca54dc4005b19068a12c18f',
  ],
  [
    'example_2007.dwg',
    'example_2007.dwg',
    'fe2d27229f67ae801b64cc01b50d4f7cdf53770de3e23640be9c24a14de5bc12',
  ],
  [
    'example_2004.dwg',
    'example_2004.dwg',
    'e72d5e86d5d36d64b08822fb25a46079f592fd895a6157b1b8d9b07775e06108',
  ],
  ['sample_2000.dwg', 'sample_2000.dwg', '4b8d9b1396a6d0decaa328dfc7cf17a09f2afa716ff8f40e9ca62ad1f1504ffa'],
  [
    '2000_entities-2d.dwg',
    '2000/entities-2d.dwg',
    '20db22c3e8b42d2630dab3ba4cb0bf5de417926861136d4e479a943798dcc753',
  ],
  [
    '2010_gh209_1.dwg',
    '2010/gh209_1.dwg',
    '4d3d81a0dd7b7a845368e3517ad745b763a9e338b0bae09e78e86c5bf2742e27',
  ],
  [
    '2013_gh109_1.dwg',
    '2013/gh109_1.dwg',
    '97156d13d70e04c4b3f7f379a6c4568ba24d384449d64127e743471b55bdfadf',
  ],
  ['2004_HatchG.dwg', '2004/HatchG.dwg', '9d03bcf4330ff5940a45e0fded1a4278810a626cc93cafe04b5ea0931a1ccc31'],
  ['2018_Leader.dwg', '2018/Leader.dwg', '1bf72f949bdf4bd6d7d4ab23275d4fc5ed358fcd0a3166d63fe5e03451732128'],
  ['r14_v.dwg', 'r14/v.dwg', 'e296ca50f237abb9eec1a8bdab77aa16fd59518e246df812aa4dd4f859bd12d3'],
  [
    'r11_entities-2d.dwg',
    'r11/entities-2d.dwg',
    'f9b372579812de9867961f12a842898c27a7dff763a71f41ea10335964b877d4',
  ],
  ['example_r14.dwg', 'example_r14.dwg', 'aec626c5680584c763418497495950089854ff9682af36076851fd793d9e2c0b'],
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(DIR, { recursive: true });
let failed = 0;
for (const [name, upstream, sum] of FILES) {
  const dest = path.join(DIR, name);
  if (existsSync(dest) && sha256(readFileSync(dest)) === sum) {
    console.log(`ok       ${name}`);
    continue;
  }
  try {
    const res = await fetch(BASE + upstream);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== sum) throw new Error('SHA-256 mismatch');
    writeFileSync(dest, buf);
    console.log(`fetched  ${name}`);
  } catch (e) {
    failed++;
    console.error(
      `FAILED   ${name}: ${e.message} — download it manually: curl -fL -o "${dest}" "${BASE + upstream}"`,
    );
  }
}
if (failed) {
  console.error(`${failed} fixture(s) missing; the DWG fixture tests skip files that are absent.`);
  process.exit(1);
}
