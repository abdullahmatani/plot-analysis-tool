# Test plan and reference drawing set (row 85)

Every suite runs offline: no test fetches anything from the network, and every E2E test fails if
the app makes a request to another host.

## 1. Suites

| Suite              | Command                                                                                                                     | Runs in CI                                 | What it covers                                                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit / integration | `npm test` (`npm run test:coverage` in CI)                                                                                  | yes                                        | geometry, offsets, calibration fits, parsers (DXF/DWG/PDF/tables), contour mapping, persistence and recovery, backup copy and restore after database loss, migrations, export scene and backends, licence list                     |
| Coverage gate      | `npm run test:coverage`                                                                                                     | yes                                        | ≥ 90 % statements, branches, functions and lines on `src/geometry` and `src/tracing` (enforced)                                                                                                                                    |
| Build audit        | `npm run build` (`scripts/check-dist.mjs`)                                                                                  | yes                                        | no loadable external URL, no eval or Function constructor, GPL code only in the DWG worker                                                                                                                                         |
| E2E (Chromium)     | `npm run e2e`                                                                                                               | yes                                        | every workflow through the UI, under the zero-egress guard                                                                                                                                                                         |
| Secondary browsers | `PAT_SECONDARY=1 npx playwright test --project=firefox --project=webkit`; `PAT_EDGE=1 npx playwright test --project=msedge` | yes                                        | `@smoke` subset on Firefox and WebKit; full E2E on Edge                                                                                                                                                                            |
| Fault injection    | `npm run e2e:faults` (`KILL_POINTS=100`, `KILL_SEED=n` to replay)                                                           | yes, own job                               | 100 random browser kills while editing, snapshotting and writing the linked file, offline; projects rebuilt from the backup copy when the browser deletes its database                                                             |
| Performance        | `npm run e2e:perf`; on the reference machine `npm run perf:reference` (exact budgets, visible window so WebGL uses the GPU) | yes, own job (report only for GPU timings) | NFR-1, NFR-2, NFR-3, NFR-4, NFR-10 (plus NFR-5 and NFR-6 at their exact budgets in the reference run); NFR-4's main-thread time per frame is enforced everywhere (≤ 10 ms); results and WebGL renderer in `test-results/perf.json` |
| Offline bundle     | `npm run bundle && npm run test:bundle`                                                                                     | yes                                        | Node, Python and PowerShell launchers serve the app on loopback only with the CSP as a header; offline, a DWG imports under that header                                                                                            |

Wall-clock budgets (the performance suite, the fault-injection 1 s bound, a few performance unit
tests) assume the machine is otherwise idle. Run them on their own: on an overloaded machine (for
example several browser test runs in parallel) they can fail because the browser is starved of
CPU, not because of a defect. CI runs them in separate jobs for this reason.

## 2. Reference drawing set

| Area             | Files (`tests/fixtures/`)                                                                                                                                                                                                                                     | Purpose                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| DXF              | `dxf/r12_entities.dxf` (+ binary), `r2000_cp1256.dxf`, `r2010_blocks.dxf`, `r2018_plotplan.dxf` (+ binary), `mm_flange.dxf`, `malformed.dxf`, `r2018_trace_site.dxf`; generator `scripts/fixtures/make_dxf_fixtures.py`, expectations `dxf/expectations.json` | entity coverage, encodings, nested blocks, UTM coordinates, units, error reporting, tracing |
| DWG              | `dwg/*.dwg`: R11, R14, 2000, 2004, 2007, 2010, 2013, 2018 (LibreDWG test data, GPL-3.0, tests only)                                                                                                                                                           | version coverage, compared entity by entity with AutoCAD's DXF of the same drawings         |
| PDF              | `pdf/plot-plan-a1-1to500.pdf`: A1 vector plot plan at 1:500, area layout at 1:200, scanned (raster) copy                                                                                                                                                      | true-scale measurement, vector extraction, raster tracing                                   |
| Sub-drawing pair | `dxf/area_layout_local_mm.dxf`, `dxf/area_layout_plant_mm_header.dxf` (`subdrawings.json`)                                                                                                                                                                    | two-point and shared-coordinate alignment                                                   |
| Large plot plan  | generated: `scripts/fixtures/make-large-dxf.mjs <out> 20` (20 MB, ~1.3 M segments) and `3.2` (~200 000 segments); `dwg/perf/plot-plan-10mb.dwg.br` (10 MB DWG of the same plot plan, `scripts/fixtures/make-large-dwg.sh`)                                    | NFR-2, NFR-3, NFR-4                                                                         |
| Contour tables   | `tables/consequences.{csv,tsv,xlsx}`, semicolon and CP1256 CSVs, clipboard HTML/TXT, `consequences-errors.csv`                                                                                                                                                | every import route, validation                                                              |
| Projects         | `projects/schema0-draft.patproj`, `projects/schema1-0x-all-features.patproj`                                                                                                                                                                                  | files saved by earlier builds open (row 87)                                                 |

The set is synthetic or taken from open test data. Before release, add a sample of **real project
drawings** (with permission) to confirm the results on your own drawings. See
`docs/USER-DECISIONS.md`.

## 3. Accuracy targets

- **NFR-7 (vector):** measurements and offsets within 1 mm at site extents up to 10 km. Covered by
  geometry unit tests (UTM-coordinate cases), calibration E2E (re-measured dimensions, 1:500 PDF
  within 1 mm), alignment (features coincide within 1 mm) and offset tests.
- **Raster tracing (row 54):** on a scanned page, (a) the rendered scan lies within **one scan
  pixel** of its calibrated position, and (b) a vertex placed on a feature of the scan, at a zoom
  where one scan pixel spans several screen pixels (as with the loupe), lies within one scan pixel
  diagonal of the feature's true position. For the reference scan (2 px per paper mm at 1:500), one
  scan pixel is 0.25 m. Verified by `e2e/raster-accuracy.spec.ts`, which reads the rendered pixels
  back from a screenshot.
- **Snapping (row 27, row 49):** snapped picks equal source coordinates exactly (bit for bit, no
  tolerance).

## 4. Acceptance traceability

Each register row's acceptance criterion maps to named tests. See `CHANGELOG.md`, which lists for
every row the commit that delivered it and the tests that verify it.
