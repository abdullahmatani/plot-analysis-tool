# Changelog

Work up to 0.1.0 was done on branch `claude/youthful-mayer-flojae`, merged into `main` by pull
request #1; 0.1.1 is on branch `claude/determined-edison-4bv6xi`. Commit hashes are abbreviated;
merge commits group the commits made in parallel feature branches. Register rows refer to
`plot-analysis-tool-FDR.md` §8. The statuses below follow the FDR's definition of Complete; the
rows still Incomplete are listed under "Not complete" with the reason.

## Product version 0.1.1 — 14 Oct 2026

A patch release under the FDR's versioning rule (§0.3): no register rows were added, and the 0.2.0
milestone still waits for rows 17 and 21 (reference-machine performance run).

| Change                                                                                                                                                                                                                                                                     | Rows       | Commit  | Verified by                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted mode (Cloudflare): serve `dist/` with the app's CSP as a header (`_headers` generated from the same policy as the page) instead of the placeholder page; fixes `main`'s format check                                                                                | 6, 7, 8    | f8c91ed | `scripts/check-dist.mjs` (`_headers` matches the page policy); CI format check                                                                                                                                     |
| **Row 22 Complete.** DWG reader rebuilt from the libredwg-web 0.8.0 sources without run-time code generation (`vendor/libredwg-web`, reproducible bit for bit), so it runs under the strict CSP header (decision U-1, option 1); no eval exception left in the build audit | 22, 25, 88 | 28b0e1f | `src/import/dwg/read.test.ts` (reads a DWG with `Function` and `eval` blocked), `e2e/dwg.spec.ts` (CSP header; Chromium and Edge), `npm run test:bundle` (offline DWG import through every launcher), `check-dist` |
| NFR-3 performance test (10 MB DWG); `npm run perf:reference` for the reference machine on any OS, in a visible browser window, at the exact budgets (incl. NFR-5, NFR-6); performance results kept when a test fails                                                       | 17, 21, 82 | c335ccf | `e2e/perf.spec.ts` (NFR-3: 9.4 s here with GPU drawing excluded; budget 15 s)                                                                                                                                      |

CI run 29 (commit 28b0e1f) is green in every job.

## Product version 0.1.0 — 14 Oct 2026

Under the FDR's versioning rule (§0.2), the version moves to a milestone only when every row of
that milestone and all earlier ones is Complete. Every 0.1.0 row is Complete. Rows 17 and 21
(0.2.0) are implemented and tested, but they wait for performance verification on the reference
machine. Row 22 (0.3.0) waits for decision U-1. The version therefore stays at 0.1.0, even though
most rows of later milestones are Complete. See `docs/USER-DECISIONS.md`.

CI on commit 3e392a8 (run 23) is green in every job: lint, format, typecheck, unit tests with the
coverage gate, build audit, Chromium E2E, offline bundle (Node, Python and PowerShell launchers),
Firefox and WebKit smoke, Edge E2E, the 100-kill-point fault-injection suite and the performance
suite.

### 0.1.0 — Foundation, offline and autosave (rows 2–12, 90–102)

| Rows                                                                                                                                                                 | Commits                                                       | Verified by                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 2 scaffold, CI, static build without external URLs                                                                                                                   | 378e6b4, 0848d3c, 1a81b62                                     | CI lint/format/typecheck; `scripts/check-dist.mjs`                                                           |
| 3 shell, 4 palette/shortcuts, 5 theming                                                                                                                              | 378e6b4                                                       | `e2e/shell.spec.ts`; `e2e/a11y.spec.ts`                                                                      |
| 6 offline PWA, 7 zero egress                                                                                                                                         | 378e6b4, 0848d3c, 4e624b5                                     | `e2e/offline.spec.ts`; egress guard on every E2E test                                                        |
| 8 offline bundle                                                                                                                                                     | 0848d3c, 3e392a8 (Node launcher fix)                          | `npm run test:bundle` (Node, Python and PowerShell launchers)                                                |
| 9 local store, 10 project file, 11 undo/redo, 12 notifications and reports                                                                                           | 378e6b4, 1cb336c                                              | `src/persistence/persistence.test.ts`, `src/core/history.test.ts`, `e2e/autosave.spec.ts`, `e2e/dwg.spec.ts` |
| 90 journal, 91 snapshots, 92 lifecycle saves, 94 status, 95 recovery, 96 restore points, 97 persistent undo, 98 file autosave, 99 quota, 100 multi-tab, 101 settings | 378e6b4, 0848d3c, 0a19a84, 86f02bb, ff6b2cf, 301fe95, 4d16e52 | `src/persistence/*.test.ts` (incl. `mirror.test.ts`); `e2e/autosave.spec.ts` (incl. database loss)           |
| 93 drafts (and C7 for every tool)                                                                                                                                    | 378e6b4, 208f4ba, 1e72e25, ed98c92                            | `e2e/drafts.spec.ts` (nine tools crashed mid-operation and resumed)                                          |
| 102 fault injection (100 kill-points)                                                                                                                                | 0848d3c, 0a19a84, 301fe95, 4d16e52                            | `e2e/kill.spec.ts` (CI job)                                                                                  |

Notable fixes, both found by the fault-injection suite: the journal flush used to be debounced,
so continuous editing could delay a write beyond NFR-9's 1 s; it is now throttled (0a19a84). With
many layers, a busy main thread could still delay the write; the journal is now written by its own
worker, which keeps the delay near 0.1 s however busy the page is (301fe95). The crash tests kill
the whole browser, because CI runners ignore renderer-only crashes (ed98c92).

The suite also found that Chromium sometimes deletes the whole IndexedDB database at the start
after a crash (6 of 300 kills in a stress test that only wrote to IndexedDB; see
`docs/USER-DECISIONS.md` §D). Every project now has a backup copy in the browser's private file
system, written by the journal worker after each batch. When the database is found empty, the
projects are rebuilt from it at start-up with a notice (4d16e52).

### 0.2.0 — DXF and PDF viewing (rows 13–21)

| Rows                                                                                                                       | Commits                                                            | Verified by                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 13 import and detection, 14 DXF, 15 PDF tiles, 16 PDF vectors, 18 large coordinates, 19 source layers, 20 entity inspector | 1caef63, 1cb336c, 53f9bb7 (tile loop fix), 0a19a84                 | `src/import/dxf/*.test.ts`, `src/import/pdf/extract.test.ts`, `e2e/calibration.spec.ts`, `e2e/measure.spec.ts` |
| 17 navigation, 21 background parsing                                                                                       | 1cb336c, 0a19a84 (incremental GPU upload, culling, worker hashing) | `e2e/perf.spec.ts` — **waiting for the reference-machine run**                                                 |

### 0.3.0 — DWG support (rows 22–25)

| Rows                                | Commits                                  | Verified by                                                                                                            |
| ----------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 22 DWG import                       | f9b82e4, 28b0e1f (rebuilt reader, 0.1.1) | `src/import/dwg/*.test.ts` (entity-by-entity match with AutoCAD DXF exports), `e2e/dwg.spec.ts` (under the CSP header) |
| 23 fallback and diagnostics         | f9b82e4                                  | `e2e/dwg.spec.ts`                                                                                                      |
| 24 CAD fonts and substitution table | cf9540d                                  | `src/underlay/cad-fonts.test.ts`, `src/import/dxf/fonts.test.ts`                                                       |
| 25 licence isolation and notices    | f9b82e4                                  | `scripts/licences.test.ts`; `check-dist` GPL isolation                                                                 |

### 0.4.0 — Scale, units, snapping and measurement (rows 26–36)

| Rows                                                                                                                                                                                  | Commits                                           | Verified by                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 27 snapping                                                                                                                                                                           | 208f4ba                                           | `src/features/snap`, `e2e/objects.spec.ts`, `e2e/trace.spec.ts`                                        |
| 26, 28–36 units, calibration (two-point, multi-reference, ratio, plant coordinates), guard and Check distance, recalibration, alignment, measurement tools, scale bar and north arrow | 53f9bb7, 30616d4, 7a3ee65, merge 7bf1c85, 2485aa8 | `e2e/calibration.spec.ts`, `e2e/measure.spec.ts`, `src/features/{calibration,measure,units}/*.test.ts` |

### 0.5.0 — Annotation, highlighting and labels (rows 37–48)

| Rows                                                                                                                         | Commits                             | Verified by                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 37 layers, 38 shapes, 39 highlighting, 42 styles and presets, 43 selection and transforms, 44 numeric editing, 45 attributes | 208f4ba                             | `e2e/objects.spec.ts`                                                                                             |
| 40 labels, 41 text, callouts and numbered tags, 48 Unicode/RTL                                                               | b1e0aa9, fb3da58, 2485aa8 (exports) | `e2e/annotate.spec.ts`, `src/features/export/scene/annotations.test.ts`, `src/features/export/dxf-export.test.ts` |
| 46 objects table, 47 anchors                                                                                                 | 36257ae, merge eacff8f              | `e2e/objects-table.spec.ts`, `e2e/anchors.spec.ts`                                                                |

### 0.6.0 — Tracing (rows 49–54)

| Rows                                                                | Commits                                  | Verified by                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| 49–53 manual, pick, chain and boundary tracing; editing and cleanup | df56179, 985159f, 63b25c5, merge c030302 | `e2e/trace.spec.ts`, `src/features/trace/*.test.ts`, `src/tracing/*.test.ts` |
| 54 raster aids                                                      | 985159f, 107ce77                         | `e2e/trace.spec.ts`, `e2e/raster-accuracy.spec.ts` (test plan §3)            |

### 0.7.0 — Offset (rows 55–61)

| Rows                                                                                 | Commits                                                                        | Verified by                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 55–61 circle/arc, box, polygon/polyline, multi-ring, live, batch and merge, accuracy | ace221b, 6887443, 3623a2d, ec48736, merge c030302, 2485aa8 (calibration guard) | `e2e/offset.spec.ts`, `src/features/offset/*.test.ts`, `src/geometry/offset.test.ts`, `src/core/derivation.test.ts` |

### 0.8.0 — Bulk contour import (rows 62–74)

| Rows                                                                                                                                                                         | Commits                                                    | Verified by                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 62–74 table import, mapping, positioning, size columns, re-binding (NFR-5), style rules, data grid, validation, labels, datasets and filters, re-import, templates, envelope | 87d6a93, 36257ae, 311b42e, 9858248, merge eacff8f, 2485aa8 | `e2e/contours.spec.ts`, `src/features/contours/*.test.ts`, `src/tables/*.test.ts` |

### 0.9.0 — Legend and export (rows 75–81)

| Rows                                                                                                      | Commits                                                                                                                          | Verified by                                                                                            |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 75–81 legend, sheet and title block, vector PDF at true scale, PNG/SVG, DXF, tables, preview and profiles | 6db24b9, 6cfeae2, 3e3dcf0, 80f096c, 1449842, 8b48515, 51ab96d, aadba0c, merge 6639d55, 2485aa8, ad2a2cb (cancel while preparing) | `e2e/export.spec.ts`, `e2e/legend.spec.ts`, `src/features/export/**/*.test.ts`, `src/export/*.test.ts` |

### 1.0.0 — Hardening (rows 82–89)

| Rows                                   | Commits                            | Verified by                                                                                                                     |
| -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 83 browser support                     | 0848d3c, 4e624b5, ff6b2cf          | CI: Chromium and Edge E2E, Firefox and WebKit smoke                                                                             |
| 84 accessibility                       | f0b02e9                            | `e2e/a11y.spec.ts` (axe, WCAG 2.1 A/AA, light and dark)                                                                         |
| 85 test suite, reference set, coverage | 41272bb, 107ce77, e80dde3, aafabb6 | `docs/TEST-PLAN.md`; coverage gate ≥ 90 %                                                                                       |
| 86 in-app help                         | 812b638, 6352d42                   | `e2e/help.spec.ts` (offline)                                                                                                    |
| 87 recovery regression and migrations  | 86f02bb, 1e72e25                   | `e2e/drafts.spec.ts`, `e2e/projects.spec.ts`, `src/persistence/project-fixtures.test.ts`, `src/persistence/persistence.test.ts` |

### Not complete

| Row                           | Reason                                                                                                                                                                                                                                      | What is needed                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 17, 21 (NFR-4, NFR-2 display) | The CI and build containers render WebGL in software, so frame rates there cannot represent the reference machine. The CPU side is measured and within budget: a 20 MB DXF imports in about 1.5–5 s, with no main-thread block over 100 ms. | Run `npm run perf:reference` on the reference machine (decision U-2) |
| 82                            | Same as 17 and 21, for NFR-1–NFR-10 (NFR-3 is now tested: 9.4 s here for a 10 MB DWG, GPU drawing excluded)                                                                                                                                 | Reference-machine run                                                |
| 88                            | The checklist is ready (`docs/SECURITY-REVIEW.md`); U-1 is resolved                                                                                                                                                                         | Reviewer sign-off; D-1 legal advice                                  |
| 89                            | Depends on every other row                                                                                                                                                                                                                  | Release decision                                                     |
