# Plot Analysis Tool — architecture guide

This guide is for contributors. It explains how the code is organised and the conventions every
feature follows. The requirements live in `plot-analysis-tool-FDR.md` (register rows are cited as
"row N").

## Commands

| Task           | Command                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| Dev server     | `npm run dev`                                                                              |
| Typecheck      | `npm run typecheck` (`tsc -b`; generates `src/generated/licences.json` first)              |
| Lint / format  | `npm run lint`, `npm run format:check` (`npx prettier --write <files>`)                    |
| Unit tests     | `npm test` (Vitest, Node environment, `fake-indexeddb`)                                    |
| Build          | `npm run build` (typecheck, Vite build, `scripts/check-dist.mjs` URL audit)                |
| E2E            | `npm run e2e` (Playwright; serves `dist/` with `vite preview` on `PAT_PORT`, default 4173) |
| Offline bundle | `npm run bundle`, `npm run test:bundle`                                                    |
| Release check  | `npm run release:check` (row 89; `docs/RELEASE-CHECKLIST.md`)                              |

Dependency changes: npm 10 has an arborist bug with this lockfile; use `npx -y npm@11 install …`.

## Hard rules (FDR §4)

- **No network.** Nothing may fetch from another origin. The CSP in the built `index.html` blocks
  it, `check-dist` fails the build on loadable external URLs, and every E2E test fails on any
  non-origin request (`e2e/fixtures.ts`). Bundle every asset (fonts, wasm, cmaps) locally.
- **No `eval` / `new Function`** (ESLint enforces; CSP has no `unsafe-eval`).
- **UI is shadcn/ui** — vendored in `src/components/ui`. Use those components, `lucide-react`
  icons, `sonner` toasts (`toast` from `sonner`), Tailwind v4 classes. No other UI kits.
- **No lost work.** Every project change goes through `commit()` (journaled within ~150 ms).
  Every multi-step tool saves an in-progress **draft** (`session.drafts.set`) within 1 s
  (C7, row 93). High-impact operations call `currentSession()?.beforeHighImpact(label)` first
  (automatic restore point, row 96).
- **Journal path.** Records go to the journal worker (`src/workers/journal.worker.ts`), which
  writes them to IndexedDB in 100 ms batches and then appends them to the project's **backup
  copy** in the Origin Private File System (`src/persistence/mirror-*.ts`). Chromium deletes an
  origin's whole IndexedDB database if it finds it damaged on opening, which a crash in the middle
  of a write can cause; at start-up `checkMirror()` rebuilds every project from the backup when the
  database turns out to be new. Drawing files are stored in the private file system too, so they
  survive with it, and so do drafts: after each change `DraftManager` sends the project's drafts
  to the journal worker, which rewrites `<projectId>.drafts` next to the backup. Anything that deletes projects must also remove their backup (`deleteProject`
  does, and "Clear local data" empties the private file system first).
- **Geometry is float64 world metres.** Never round stored geometry. Display formatting uses
  `src/core/units.ts` (`formatNumber`, `formatLength`, `parseLength`, area factors).
- **Large coordinates on the GPU (row 18).** Underlay batches hold float32 offsets from a batch
  origin and get a float64-derived transform each frame. float32 keeps about 7 digits, so a vertex
  far from its origin (any long line, every line on a 10 km site) is drawn off at high zoom: by up
  to 64 px at the maximum zoom on a 10 km site. When `batchErrorPx` (`src/render/detail.ts`)
  exceeds a quarter pixel, the canvas controller draws the drawing from **detail batches** instead:
  the float64 entities in a window three views wide, cut to it and stored relative to its centre
  (`buildDetailData`), rebuilt only when the view leaves the window. Anything new drawn by the GPU
  must keep its float32 values close to their origin in the same way.
- **Curves at high zoom (rows 14, 27).** The full batches tessellate arcs, circles, ellipses and
  polyline bulges once, at a chord tolerance of 2 × 10⁻⁶ of the drawing's diagonal. When those
  chords would stray more than half a pixel (`needsDetail`), detail batches take over and redraw
  the curves inside their window at 1/8 px (`FineCurves`; only the stretches of each arc inside the
  window are refined, see `arcIntervalsInRect`), so a curve looks as a CAD viewer draws it and arc
  snaps sit on the drawn line. Splines are tessellated at import and are not refined.
- **GPL isolation (D-1):** `@mlightcad/libredwg-web` is only imported from the DWG worker. Its
  WebAssembly and glue come from `vendor/libredwg-web`, the same release rebuilt without run-time
  code generation so the strict CSP applies to it (decision U-1); `vite.config.ts` redirects the
  package's glue import there, and `scripts/libredwg/build.sh` reproduces the build.

## Source layout

```
src/core/         data model (types.ts), units, affine, ids, history (Immer patches), migrations
src/store/        zustand stores: project (history/commit/undo), view (camera, selection, snap,
                  active tool), ui (theme, panels, dialogs), app
src/persistence/  IndexedDB (Dexie) journal/snapshots/recovery/drafts/settings, .patproj files
src/app/          session (open/lock/autosave), commands registry, menus, features loader
src/components/   ui/ (shadcn), app/ (shell, dialogs), inspector/ (panels), canvas/, import/
src/render/       canvas controller (pointer/keys/overlays/tools), WebGL2 underlay renderer, view math
src/underlay/     EntityStore (typed arrays shared by DXF/DWG/PDF), models store, picking
src/import/       file detection, DXF/DWG/PDF parsers (in workers), import pipeline
src/geometry/     pure geometry: measure, convert, clipper (Clipper2), offset, boolean, calibration,
                  intersect, nearest, simplify, polyline-edit, hit
src/tracing/      chain tracer and boundary detection over underlay entities
src/tables/       CSV/TSV/XLSX/clipboard parsing, column suggestion, contour computation,
                  filters, style rules, label templates, validation, diff
src/export/       Scene model + PDF (pdf-lib), SVG, canvas/PNG, DXF writer, fonts, bidi shaping
src/features/     self-registering feature modules (see below)
src/workers/      module workers (snapshot, zip, cad, dwg, pdf-extract)
e2e/              Playwright specs; tests/fixtures/ reference files
```

## Feature modules

`src/app/features.ts` imports every `src/features/<name>/register.ts` at build time and calls its
`register()` (which may return an unregister function). A feature adds itself to shared registries
instead of editing shared components:

| Registry                             | Import from                                | Use                                                                                        |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `registerCommands([...])`            | `@/app/commands`                           | menu items, palette entries, shortcuts, tool-rail buttons (`rail: true`)                   |
| `registerTool(tool)` / `setTool(id)` | `@/tools/registry`                         | canvas tools                                                                               |
| `registerOverlay(z, draw)`           | `@/render/canvas-controller`               | Canvas2D overlay drawing each frame (objects z=20, labels z=30, selection z=60, snap z=90) |
| `registerExtentProvider(fn)`         | `@/render/canvas-controller`               | bounds included in Zoom extents                                                            |
| `kindRenderers[kind] = fn`           | `@/features/objects/render`                | custom drawing for an object kind (measurement, text, callout, tag…)                       |
| `propertySections`                   | `@/components/inspector/property-sections` | sections in the Properties tab                                                             |
| `layerSections`                      | `@/components/inspector/LayersPanel`       | sections in the Layers tab                                                                 |
| `dataPanels`, `legendPanels`         | `@/components/inspector/panels`            | Data / Legend tab content                                                                  |
| `extraDialogs`                       | `@/components/app/extra-dialogs`           | dialogs opened with `useUiStore.getState().openDialog(id)`                                 |
| `registerDerivation(fn)`             | `@/core/history`                           | derived data updated inside every commit, same undo step (live offsets)                    |
| `gripExtensions`                     | `@/features/objects/grips`                 | extra select-tool grips (e.g. segment midpoint "+" grips that insert a vertex)             |
| `exportKindRenderers[kind] = fn`     | `@/features/export/scene/objects`          | export drawing for an object kind (register from a module the export worker imports)       |
| `setContourExportProvider(fn)`       | `@/features/export/inputs`                 | contour items/envelopes used by exports and the legend (default: `computeContours`)        |

Overlays with z ≥ 100 draw after the active tool's preview (the magnifier loupe uses z=100).
`dragPreview()` (`@/features/objects/select-tool`) returns the geometry being dragged, for live
previews of dependent geometry.

Menus are `File, Edit, View, Draw, Trace, Offset, Data, Export, Help` (`MenuGroup`). Shortcut
strings look like `Mod+Shift+N`, `Alt+[`, `F3`, single letters (`C`). Check `allCommands()` for
collisions before choosing one.

## Project state and undo

- `getProject()` (non-reactive) and `useProject(selector)` (React) read the current project.
- `commit(label, draft => { … }, { coalesceKey? })` applies one undoable change (Immer recipe,
  mutate the draft). Returns `false` when read-only. One user action = one commit; consecutive
  commits with the same `coalesceKey` within 1.5 s merge (sliders, typing).
- Never keep project objects in component state across commits; re-read from the store.
- Undo/redo, journal, snapshots, multi-tab following and recovery are automatic.
- Non-project UI state: `useViewStore` (view `{cx, cy, scale px/m, rotation}`, `selection`,
  `activeTool`, snap settings), `useUiStore` (dialogs, inspector tab, theme).
- Prompts: `promptText({title, label, defaultValue})`, `confirmAction({title, description,
destructive})` from `@/app/prompt` (never `window.prompt/confirm`).

## Coordinates

- **World** = metres, +Y up. For drawings calibrated with plant coordinates, world coordinates
  _are_ plant E/N.
- A drawing's entities are in **drawing units** (CAD units, or PDF points with origin at the page's
  bottom-left). `drawingPlacement(d)` (`@/underlay/pick`) = alignment ∘ (calibration.transform or
  the default unit scale) maps drawing units → world.
- Screen: `frame.toScreen(pt)` / `frame.toWorld(pt)`; `frame.scale` = px per metre.

## Tools

A `Tool` (`src/tools/types.ts`) receives pointer events with `world` (raw) and `pt` (snapped and
constrained) and draws previews in `render(g, frame)`. For point-collecting tools use
`createPickTool(spec)` from `@/features/draw/pick-tool`: it handles snapping bases, typed input
(`x,y`, `@dx,dy`, `@d<angle`, plain distance), Backspace/Esc/Enter/double-click, previews and
drafts. Tools that create objects set `creates: true` and finish with
`addObjects([{ kind, geometry, … }], 'Undo label')` from `@/features/objects/ops`.

Typed input is captured only while the canvas has focus; tools may allow extra leading characters
with `typedStart`.

## Analysis objects

`AnalysisObject` (`src/core/types.ts`) has a `kind`, a `geometry` (circle, arc, rect, ellipse,
polyline with bulges, multipolygon, point), a per-object `style` override on top of its layer
style (`resolveStyle`), an optional `label` (template fields via `labelText`), attributes,
`derived` (live offsets) and `measurement` info. Helpers: `@/features/objects/ops` (add, update
geometry, move/rotate/scale/mirror, delete, reorder), `labels.ts` (`measures(geometry)` →
area/perimeter/length/radius…), `pick.ts`, `grips.ts`.

## Exports

`src/features/export/scene/` turns the project into one backend-neutral `Scene` (paper mm): sheet
layout and true-scale world → paper transform, underlays, analysis objects, contours, legend
(`src/features/legend/legend-model.ts`), title block, scale bar, north arrow and the calibration
statement (always on the output, row 32). The export worker (`export.worker.ts`) renders it with
the PDF/SVG/canvas backends (PNG in strips with a streaming encoder) and writes DXF/CSV/XLSX; the
dialog preview is the same scene drawn by the canvas backend. Export settings are an
`ExportProfile` without id/name; the sheet layout lives in `Project.sheet`.

## Underlay access

`useModelsStore.getState().models[drawingId]` gives the parsed `EntityStore` (typed arrays: entity
types, layers, flags, geometry offsets), a Flatbush spatial index and text index.
`pickUnderlay(...)`, `entityToGeometry(store, i)` (exact geometry of an entity in drawing units;
transform with `drawingPlacement`), `entityTypeName`, `entityText`.

## Scale, units and measurement (0.4.0)

- **Calibration guard (row 32):** tools that work with distances (measure, offset, contours) start
  with `if (!(await warnIfUncalibrated('Offset'))) return;` (`@/features/calibration/guard`).
- **Placement changes:** change a drawing's calibration, unit override or alignment only through
  `applyPlacementChange(drawingId, label, mutate)` (`@/features/calibration/recalibrate`): it asks
  whether analysis objects move with the drawing (row 33), commits once and clears `verified`.
- **Exports:** put `calibrationStatement(project)` (`@/features/calibration/state`) on every output
  that shows distances; measurement annotations' text is `annotationLines(project, o)`
  (`@/features/measure/compute`); scale bars use `niceScaleBar` (`@/core/scale-bar`).
- **Display formatting:** `fmtLength`, `fmtArea`, `fmtAngle`, `fmtCoord`, `coordinateAxes(project)`
  (E/N with plant coordinates) from `@/features/units/format` follow `project.display`.
- **Canvas chrome:** non-modal panels and overlays render into the canvas with
  `<CanvasSlot name="top-left" | "top-right" | "bottom-left">` (`@/features/units/canvas-slot`);
  panels need `pointer-events-auto`.

## Testing conventions

- Unit tests next to the code (`*.test.ts`), Vitest, no DOM.
- E2E specs in `e2e/*.spec.ts` import `test, expect, openApp, createProject` from
  `./fixtures` (the egress guard is automatic). Prefer `data-testid` and accessible names.
  `window.__pat` exposes `project()`, `session()`, `store()` for assertions.
- Fixtures in `tests/fixtures/<kind>/`; generators in `scripts/fixtures/`.
