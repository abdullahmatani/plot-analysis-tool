# Decisions and checks that need you

These are items found while building the tool that only you can decide or verify. Each names the
FDR rows it affects and what happens until it is resolved. The first group blocks rows from being
Complete; the rest are product choices that were made provisionally and that you can confirm or
change.

## A. Blocking items

### U-1 — DWG reader vs. the Content-Security-Policy (rows 22, 88; D-1)

**What happens now.** The DWG reader (LibreDWG, GPL-3.0, isolated in its own worker) uses
JavaScript generated at run time (`new Function`, emitted by Emscripten's embind). When the page is
served **with the CSP as an HTTP header**, the browser applies the policy to workers too and blocks
it; the offline bundle's launchers and `vite preview` do this. DWG import then stops with a clear
message telling the user to export DXF or PDF instead (tested in `e2e/dwg.spec.ts`). Where the CSP
is only the page's `<meta>` tag (static hosting without headers, the dev server), DWG import works.
The reference DWGs match AutoCAD's own DXF export entity for entity (1517 of 1519 and 1556 of 1558;
the differences are fit splines).

**Options.**

1. **Rebuild libredwg-web with `-sDYNAMIC_EXECUTION=0`** (recommended). Emscripten then emits
   glue without `new Function`, and the strict CSP stays unchanged everywhere. This needs the
   Emscripten SDK and the libredwg-web sources from GitHub. GitHub was not reachable from the build
   environment, so it could not be done here.
2. **Relax the CSP for the DWG worker only.** Serve `assets/libredwg.worker-*.js` with a policy
   that adds `'unsafe-eval'`. A worker's CSP comes from its own response, so the page keeps its strict
   policy, and `connect-src 'self'` still prevents any egress from the worker. This weakens row 88's
   "no eval" for that one worker.
3. **Patch the generated glue** to use Emscripten's own non-eval code paths (equivalent to option 1
   without recompiling). A working patch was written and then removed, because an automated safety
   check flagged it as working around a security control. It needs your explicit approval.
4. **Accept** that DWG import is unavailable in the offline bundle, and use DXF/PDF.

### U-2 — Performance on the reference machine (rows 17, 21, 82; NFR-1 to NFR-10)

The build and CI containers have no GPU; WebGL runs in software (SwiftShader). There, frame rates
and first-frame times say nothing about a laptop's integrated GPU. Measured here:

- NFR-2 CPU side: a 20 MB DXF parses and loads in about 3–5 s; the longest main-thread block is
  about 50–75 ms.
- NFR-1: cold start from cache in 0.5–0.7 s.
- NFR-10: autosave's longest synchronous step is about 14 ms; reopen takes 0.75 s.

**Needed:** on the reference machine (mid-range laptop, 8 GB RAM, integrated GPU, current
Chrome/Edge), run

```
npm ci && npm run build && PAT_PERF_STRICT=1 npm run e2e:perf
```

and keep `test-results/perf.json`. If it passes, rows 17, 21 and 82 can be marked Complete.

### U-3 — Security review sign-off (row 88)

`docs/SECURITY-REVIEW.md` is the checklist, and every item has an automated check behind it. A
person must review it, decide U-1, and sign it off.

### U-4 — D-1 licensing advice

Before distributing the app commercially, get legal advice on the GPL-3.0 obligations of the
LibreDWG worker. The FDR recommends this. The component is isolated in its own worker chunk, and
it is listed in About → Licences.

### U-5 — Release (row 89)

Tagging 1.0.0 requires every row to be Complete (U-1 to U-3 first, and U-6). The offline bundle is built by
`npm run bundle` and uploaded by CI as the `offline-bundle` artifact. Publishing a release and
choosing where to host the PWA are your decisions. Nothing has been tagged or published.

### U-6 — Merging into `main`

All work is on the branch `claude/youthful-mayer-flojae` (the parallel feature branches were merged
into it). It fast-forwards onto `main`, which holds only the FDR. No pull request was opened,
because none was requested. The FDR statuses count a row as merged once it is on this branch. Open
a pull request and merge it when you have reviewed it, so that `main` matches the FDR.

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
- Playwright cannot emulate offline navigation in Firefox or WebKit. The offline-start test runs in
  Chromium only; the CSP test runs on all engines.
- The File System Access API is unavailable in Firefox and Safari. Those browsers download project
  files instead, and the backup reminder applies.
- Wall-clock tests (fault injection, performance, a few performance unit tests) fail when the
  machine is heavily overloaded. Run them on an otherwise idle machine; CI gives them their own
  jobs.
