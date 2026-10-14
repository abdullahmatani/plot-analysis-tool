# DWG test fixtures

Sample DWG files used only by the DWG importer tests (`src/import/dwg/*.test.ts`). They are **not**
part of the application bundle.

## Source and licence

All files come from the test data of the LibreDWG project
(<https://github.com/LibreDWG/libredwg>, directory `test/test-data/`), commit
`f860b0fb76d5f8effb5a70769a3389cb1e0308c8` (2026-10-13). LibreDWG, including its test data, is
distributed under the **GNU General Public License v3.0**; the files are used here unmodified,
for testing only. Folder names of the upstream paths are folded into the file names
(`2013/gh109_1.dwg` → `2013_gh109_1.dwg`).

`scripts/fixtures/dwg-fetch.mjs` downloads them again from that commit and checks the SHA-256 sums
below (`node scripts/fixtures/dwg-fetch.mjs`).

| File                   | Upstream path                   | Format         | Why it is here                                                                                           |
| ---------------------- | ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `example_2018.dwg`     | `example_2018.dwg`              | AC1032 (2018)  | Rich sample: blocks with attributes, arrays of inserts, mirrored/scaled insert, dimensions, pattern hatch, splines, MTEXT, 3D entities, layouts |
| `example_2013.dwg`     | `example_2013.dwg`              | AC1027 (2013)  | Same drawing, 2013 format                                                                                |
| `example_2007.dwg`     | `example_2007.dwg`              | AC1021 (2007)  | Same drawing, 2007 format (table graphics resolved by LibreDWG)                                          |
| `example_2004.dwg`     | `example_2004.dwg`              | AC1018 (2004)  | Same drawing, 2004 format                                                                                |
| `sample_2000.dwg`      | `sample_2000.dwg`               | AC1015 (2000)  | Small drawing                                                                                            |
| `2000_entities-2d.dwg` | `2000/entities-2d.dwg`          | AC1015 (2000)  | Basic 2D entities, blocks, attribute, dimension, shape                                                   |
| `2010_gh209_1.dwg`     | `2010/gh209_1.dwg`              | AC1024 (2010)  | Blocks with attributes, `$INSUNITS` = metres                                                             |
| `2013_gh109_1.dwg`     | `2013/gh109_1.dwg`              | AC1027 (2013)  | Chinese layer/layout names, `$LTSCALE` 1000, dashed linetypes, dimensions, custom (proxy) objects        |
| `2004_HatchG.dwg`      | `2004/HatchG.dwg`               | AC1018 (2004)  | Gradient hatches (rendered solid), true colour                                                           |
| `2018_Leader.dwg`      | `2018/Leader.dwg`               | AC1032 (2018)  | LEADER, MULTILEADER and IMAGE entities                                                                   |
| `r14_v.dwg`            | `r14/v.dwg`                     | AC1014 (R14)   | Release 14                                                                                               |
| `r11_entities-2d.dwg`  | `r11/entities-2d.dwg`           | AC1009 (R11)   | Pre-R13 format (limited support in LibreDWG)                                                             |
| `example_r14.dwg`      | `example_r14.dwg`               | AC1014 (R14)   | Same drawing in R14. The published libredwg-web 0.8.0 build crashed on it; the rebuilt reader reads it (one polyline short of its last vertex, with the reader warning). Corrupted copies test the readable-error path |

Damaged, truncated and newer-format inputs are derived from these files in memory by the tests.

## Performance fixture (NFR-3)

`perf/plot-plan-10mb.dwg.br` is a 10 MB AutoCAD 2000 DWG (Brotli-compressed to 3.4 MB) used by
`e2e/perf.spec.ts` for NFR-3. It is not LibreDWG test data: it is the project's synthetic plot plan
(`scripts/fixtures/make-large-dxf.mjs`, 17 MB of DXF, 187 840 entities in UTM-sized coordinates)
converted by LibreDWG's `dxf2dwg`. `scripts/fixtures/make-large-dwg.sh` regenerates it. Read back by
the app's DWG importer, it gives the same entities, extents and geometry as the DXF, bit for bit.

## Expectations

`expectations.json` holds what the tests assert. For the drawings that LibreDWG also ships as
AutoCAD-written DXF (`example_20xx.dxf`, `2000/entities-2d.dxf`, `2010/gh209_1.dxf`,
`2013/gh109_1.dxf`), the per-entity geometry, colours, layers, linetypes, lineweights and texts
(`entities`), the spline reference points (`splines`) and the hatch pattern segment counts
(`patternSegments`) were taken from AutoCAD's DXF export of the same drawing, parsed by the
project's DXF importer, and matched to the DWG entities by handle. The DWG importer reproduced all
of them exactly (splines within 4·10⁻⁴ of their size: DWG stores AutoCAD fit splines as fit points
only). Structural values (counts, skipped types, layouts, extents) were verified the same way; for
files without a reference DXF they are regression values checked by hand.

## SHA-256

```
7bc7721224003062b237845842b7a976e46771c37eba6833b9ed3712e7a5a65a  example_2018.dwg
ce80953e4881899cde8c42b97919feb2697259554ca54dc4005b19068a12c18f  example_2013.dwg
fe2d27229f67ae801b64cc01b50d4f7cdf53770de3e23640be9c24a14de5bc12  example_2007.dwg
e72d5e86d5d36d64b08822fb25a46079f592fd895a6157b1b8d9b07775e06108  example_2004.dwg
4b8d9b1396a6d0decaa328dfc7cf17a09f2afa716ff8f40e9ca62ad1f1504ffa  sample_2000.dwg
20db22c3e8b42d2630dab3ba4cb0bf5de417926861136d4e479a943798dcc753  2000_entities-2d.dwg
4d3d81a0dd7b7a845368e3517ad745b763a9e338b0bae09e78e86c5bf2742e27  2010_gh209_1.dwg
97156d13d70e04c4b3f7f379a6c4568ba24d384449d64127e743471b55bdfadf  2013_gh109_1.dwg
9d03bcf4330ff5940a45e0fded1a4278810a626cc93cafe04b5ea0931a1ccc31  2004_HatchG.dwg
1bf72f949bdf4bd6d7d4ab23275d4fc5ed358fcd0a3166d63fe5e03451732128  2018_Leader.dwg
e296ca50f237abb9eec1a8bdab77aa16fd59518e246df812aa4dd4f859bd12d3  r14_v.dwg
f9b372579812de9867961f12a842898c27a7dff763a71f41ea10335964b877d4  r11_entities-2d.dwg
aec626c5680584c763418497495950089854ff9682af36076851fd793d9e2c0b  example_r14.dwg
f2be3d928da5de33fc45baea19cd086bfb56bcec0e20af2d0849f1a1556edb37  perf/plot-plan-10mb.dwg (decompressed)
```
