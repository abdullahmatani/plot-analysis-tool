# Decisions and checks that need you

These are items found while building the tool that only you can decide or verify. Each names the
FDR rows it affects and what happens until it is resolved. The first group blocks rows from being
Complete; the rest are product choices that were made provisionally and that you can confirm or
change.

## A. Blocking items

### U-2 — Performance on the reference machine (rows 17, 21, 82; NFR-1 to NFR-10)

The build and CI containers have no GPU; WebGL runs in software (SwiftShader). There, frame rates
and first-frame times say nothing about a laptop's integrated GPU. Measured here (GPU drawing
excluded):

- NFR-2 CPU side: a 20 MB DXF parses and loads in about 1.5–5 s; the longest main-thread block is
  under 100 ms.
- NFR-3 CPU side: a 10 MB DWG parses and loads in about 9.4 s (budget 15 s).
- NFR-1: cold start from cache in 0.5–0.7 s.
- NFR-10: autosave's longest synchronous step is about 1–14 ms; reopen takes 0.3–0.75 s.

**Needed:** on the reference machine (mid-range laptop, 8 GB RAM, integrated GPU, current
Chrome/Edge), plugged in and otherwise idle, run

```
npm ci
npx playwright install chromium
npm run build
npm run perf:reference
```

(`npm run perf:reference -- --channel=msedge` uses the installed Edge instead.) It works the same on
Windows, macOS and Linux, enforces the FDR budgets exactly, runs in a visible browser window so
WebGL uses the GPU, and prints every result next to its budget. It does not report success if the
browser rendered in software. If it passes, keep `test-results/perf.json`; rows 17, 21 and 82 can
then be marked Complete.

### U-3 — Security review sign-off (row 88)

`docs/SECURITY-REVIEW.md` is the checklist, and every item has an automated check behind it. With
U-1 resolved, no eval exception remains. A person must review it and sign it off.

### U-4 — D-1 licensing advice

Before distributing the app commercially, get legal advice on the GPL-3.0 obligations of the
LibreDWG worker. The FDR recommends this. The component is isolated in its own worker chunk, and
it is listed in About → Licences. The project now builds this component itself
(`vendor/libredwg-web`); its corresponding source is the upstream release recorded in
`vendor/libredwg-web/build-info.json` (unmodified) plus `scripts/libredwg/build.sh`. Ask whether
the offline bundle should also carry that source, or a written offer for it.

### U-5 — Release (row 89)

Tagging 1.0.0 requires every row to be Complete (U-2 and U-3 first). The offline bundle is built by
`npm run bundle` and uploaded by CI as the `offline-bundle` artifact. Publishing a release is your
decision. Nothing has been tagged or published.

### Resolved

- **U-1 — DWG reader vs. the Content-Security-Policy (rows 22, 88):** resolved with option 1. The
  reader is rebuilt from the libredwg-web 0.8.0 sources with `-sDYNAMIC_EXECUTION=0`
  (`vendor/libredwg-web`, reproducible with `scripts/libredwg/build.sh`), so it no longer needs
  `new Function`, and the strict policy applies everywhere unchanged. DWG import now works in the
  offline bundle, `vite preview` and hosted mode, verified in Chromium, Edge and through the bundle
  launchers. Updating `@mlightcad/libredwg-web` now means re-running the build script; the build
  refuses a mismatched version.
- **U-6 — Merging into `main`:** pull request #1 merged the integration branch into `main`. Later
  work arrives through pull requests the same way.
- **U-7 — Cloudflare deployment (hosted mode):** merging pull request #3 into `main` did not
  deploy, because the Cloudflare Workers and Pages GitHub app had not been given access to this
  repository (it was installed for selected repositories only), so Cloudflare never received the
  push. Access was granted on 15 Oct 2026. Every push to `main` now starts a Workers Build. The
  settings it needs (Workers & Pages → plot-analysis-tool → Settings → Build): repository
  `abdullahmatani/plot-analysis-tool`, production branch `main`, build command `npm run build`,
  deploy command `npx wrangler deploy`, root directory `/`. The Worker's name must match `name` in
  `wrangler.jsonc`. If a merge does not deploy, check the app's repository access first (GitHub →
  Settings → Applications → Cloudflare Workers and Pages → Configure), then the build log under
  the Worker's Deployments tab. Granting access does not replay pushes made before it.

## B. Recommended checks with your own material

These are covered by automated tests on the reference set (`docs/TEST-PLAN.md`), but confirmation
with your own drawings and tools is worthwhile:

- **Real drawings:** add a few of your plot plans (DXF, DWG, vector and scanned PDF) and check that
  they render the way your CAD viewer shows them (rows 14, 22, 24).
- **Air-gapped PC:** unzip the offline bundle on a Windows PC without network or admin rights and
  run `Start Plot Analysis Tool.cmd` (row 8). The PowerShell launcher is tested in CI on Linux
  PowerShell, not on Windows.
- **Print check:** print an exported A1 PDF at 100 % and measure it with a scale rule (row 77).
- **CAD round trip:** XREF an exported DXF at 0,0 in AutoCAD over the source drawing (row 79).
- **Excel:** open an exported XLSX in Excel. The XLSX writer is custom (see D-5 below) and is
  checked by tests, not by Excel itself.

## C. Provisional product decisions (confirm or change)

| #   | Decision taken                                                                                                                                                                                                                     | Alternative                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| D-2 | Rendering uses WebGL2 directly (instanced lines, fills, PDF tiles) plus a Canvas 2D overlay; Three.js is not used                                                                                                                  | Three.js, as the FDR suggested; it was not needed                  |
| D-3 | Packaging is a PWA plus a zipped static build with loopback-only launchers (PowerShell, Python, Node). The single-file HTML option was not built                                                                                   | Spike option (c) if double-click launch from `file://` is required |
| D-5 | XLSX is read and written with a small built-in OOXML reader/writer. ExcelJS uses `eval`; current SheetJS is not distributed on npm                                                                                                 | Vendor SheetJS CE                                                  |
| —   | "No external URLs in the build": inert URL strings inside bundled libraries (XML namespaces, licence texts, error-documentation links, pdf.js/core-js URL-parsing probes) are allow-listed one by one; nothing loadable is allowed | Stricter: strip them at build time                                 |
| —   | Each project has a backup copy in the browser's private file system (see D below). It holds the latest snapshot and every later edit, not restore points, unfinished-tool drafts or app settings                                   | Also back up restore points and settings                           |
| —   | Drawing files are always kept in the private file system when the browser supports it (before: only files over 8 MB), so they survive the database loss described in D                                                             | Keep small files in IndexedDB                                      |
| —   | Live offsets on a locked layer still update when their source changes                                                                                                                                                              | Freeze them while the layer is locked                              |
| —   | A live offset whose contraction collapses becomes a point at the source centroid. It stays linked and reappears when the source grows                                                                                              | Delete or detach it instead                                        |
| —   | Merged offset envelopes are static (not live)                                                                                                                                                                                      | Multi-source live derivation                                       |
| —   | Recalibrating with "move objects with the drawing" also moves objects on locked layers. With several drawings, only objects overlapping the recalibrated drawing move                                                              | Skip locked layers; ask per layer                                  |
| —   | CAD drawings show "Uncalibrated" until their header units are confirmed; the guard confirms them in one click                                                                                                                      | Treat `$INSUNITS` as calibrated                                    |
| —   | Contour shape comes only from a shape column; there is no dataset-wide "all squares" setting                                                                                                                                       | Add a dataset-level default shape                                  |
| —   | Exports leave out CAD layers marked "do not plot" (e.g. Defpoints), and white (ACI 7) prints black                                                                                                                                 | Print everything visible                                           |
| —   | The export dialog remembers format, DPI and region per project in browser storage; choosing a profile copies its sheet layout into the project (one undo step)                                                                     | Store them in the project                                          |
| —   | The rebuilt DWG reader (`vendor/libredwg-web`, 10.8 MB WebAssembly) and the 10 MB DWG performance fixture (3.4 MB compressed) are committed to the repository, so builds and CI need no Emscripten or LibreDWG toolchain           | Build them in CI (adds several minutes per run)                    |
| —   | Shortcuts chosen: trace T / Shift+T / Shift+C / B, offset O, loupe Alt+M, text X, callout Shift+X, numbered tag N, measure distance D, export Ctrl+P, export again Ctrl+Shift+E                                                    | All can be remapped in Help → Keyboard shortcuts                   |

## D. Findings and test-environment limitations (for information)

- **Chromium can delete the app's whole local database after a crash.** The fault-injection suite
  found that Chrome/Edge sometimes discard an origin's entire IndexedDB database on the next start
  after a crash in the middle of a write. In a stress test that only wrote to IndexedDB, 6 of 300
  hard kills of the browser lost the database. The cause is in the browser's storage engine
  (LevelDB reuses its log file after a crash; the damaged record left in the middle of the log is
  later treated as corruption). The app cannot prevent this, so it keeps a backup copy of every
  project in the browser's private file system, and rebuilds the projects from it at the next start
  with a notice (tested in `e2e/autosave.spec.ts` and by the fault-injection suite). Restore points,
  drafts and app settings are not in the backup. Linking a project to a file (row 98) remains the
  safest protection, because it also survives clearing the browser's site data.
- **Headless browsers render WebGL in software** even on machines with a GPU, so the reference
  performance run uses a visible window (`npm run perf:reference`).
- **`example_r14.dwg`**, a Release 14 file on which the published DWG reader crashed, now reads with
  the rebuilt reader. It matches the 2004 copy of the same drawing, except R14's own limits and one
  polyline that lacks its last vertex. The import report shows the reader's warning with the DXF/PDF
  advice, as for any file where the reader reports problems.
- Playwright cannot emulate offline navigation in Firefox or WebKit. The offline-start test runs in
  Chromium only; the CSP test runs on all engines.
- The File System Access API is unavailable in Firefox and Safari. Those browsers download project
  files instead, and the backup reminder applies.
- Wall-clock tests (fault injection, performance, a few performance unit tests) fail when the
  machine is heavily overloaded. Run them on an otherwise idle machine; CI gives them their own
  jobs.
