# Plot Analysis Tool — Functional Design Requirements (FDR)

| Field | Value |
|---|---|
| Document | FDR-PAT-001 |
| Product | Plot Analysis Tool (working name) |
| Current product version | **0.1.4** |
| Target release | **1.0.0** |
| FDR revision | Rev G — 15 Oct 2026 |
| Document status | Draft for review |
| Owner | Abdullah |

---

## 0. How to use this document

This FDR is the single source of truth for scope and progress. Section 8 (Feature Register) lists every feature as a numbered row with a description, the version it ships in, and a status.

**Status values**

| Status | Meaning |
|---|---|
| Complete | Implemented, merged, automated tests pass, and the row's acceptance criteria are met against the reference drawing set (row 85). |
| Incomplete | Anything else — not started, in progress, or failing acceptance. |

**Versioning rules (SemVer, starting at 0.0.0)**

1. The product starts at **0.0.0** (specification only, no code).
2. Each milestone in Section 9 is a MINOR version (0.1.0, 0.2.0 … 0.9.0). The product version is raised to a milestone only when **every row targeted at that milestone and all earlier milestones is Complete**.
3. Fixes and small changes that add no new register rows bump the PATCH number (e.g. 0.4.0 → 0.4.1).
4. **1.0.0** is released only when every row in the register is Complete.
5. Rows are never renumbered. New scope gets the next free row number and a target version. Dropped scope is struck through with a one-line reason, never deleted.
6. Each Complete row should reference the PR/commit that closed it in the changelog.

---

## 1. Purpose and scope

### 1.1 Purpose
Give engineers a fast, private, offline tool to carry out spatial analysis on **plot plans** and drawings derived from them (area layouts, equipment layouts, key plans, hazardous-area drawings, fire & gas layouts, site plans, escape-route drawings). Typical analyses:

- Hazard / consequence zones around equipment (fire radiation, overpressure, toxic distances) drawn from tabular study results.
- Separation and safety distances (expand an equipment footprint, tank or boundary by a required distance).
- Area allocation, laydown, exclusion and buffer zones, highlighted and labelled.
- Measurements (distances, areas, radii) at a verified scale.
- Issuing a clean, scaled output with a legend that explains the analysis.

### 1.2 In scope for 1.0.0
- Import and view **DXF, DWG and PDF** drawings, fully in the browser.
- Annotate, highlight and label areas on separate analysis layers.
- Trace drawing geometry (manual and assisted).
- Offset (expand / contract) circles, arcs, boxes and polygons by a given distance.
- Scale awareness: read units from CAD files, or calibrate scale from measured distances, ratios or coordinates.
- Bulk contour import from tables, with instant re-binding of label and size columns.
- Export outcomes (PDF, PNG, SVG, DXF, CSV/XLSX) with a legend / key and title block.
- Continuous autosave with crash recovery, restore points and optional autosave to a project file, so no work is lost.
- 100% offline operation; no drawing or project data ever leaves the user's device.

### 1.3 Out of scope for 1.0.0
- Writing changes back into the source DWG/DXF/PDF (source drawings are read-only underlays).
- Consequence modelling calculations themselves (the tool displays results, it does not compute them).
- 3D, point clouds, and real-time multi-user collaboration.
- Any server-side processing, accounts or cloud storage.

---

## 2. Definitions

| Term | Definition |
|---|---|
| Plot plan | Overall site/unit layout drawing showing equipment, structures, roads and boundaries. |
| Sub-drawing | Any drawing produced as a subset of the plot plan (area layout, equipment layout, key plan, etc.). |
| Underlay | An imported source drawing (DXF/DWG/PDF). Always read-only. |
| Analysis object | Any geometry the user creates: shape, trace, offset, contour, label, measurement. |
| Analysis layer | A user-defined grouping of analysis objects with shared visibility, lock state and legend entry. |
| Drawing units | Native units of the underlay (CAD units, or PDF points). |
| World units | Real-world units used for all analysis (metres internally; display unit selectable). |
| Calibration | The transform that maps drawing units to world units (scale, and optionally rotation/translation). |
| Contour | A closed shape (circle by default) of a given radius/diameter around a reference point, generated from a table row. |
| Contour dataset | An imported table plus its column mapping, style rules and display settings. |
| Anchor | A named reference point placed on the drawing (e.g. "P-101") that table rows can reference instead of coordinates. |
| Offset | A new geometry at a fixed perpendicular distance outward (expand, +d) or inward (contract, −d) from a source. |
| Snap | Locking the cursor to a precise point on geometry (endpoint, centre, intersection, etc.). |
| Journal | The local write-ahead log of every committed edit, written automatically as the user works. |
| Snapshot | A complete, checksummed copy of the project state; the journal is replayed on top of the latest one. |
| Restore point | A snapshot kept in the project's version history, created automatically or named by the user. |
| Draft | The saved state of an unfinished interaction (e.g. a half-traced polyline or an open mapping dialog). |

---

## 3. Users and key workflows

**Primary users:** process safety / loss-prevention engineers, layout and piping engineers, HSE engineers, project engineers and reviewers.

| ID | Workflow | Steps (happy path) |
|---|---|---|
| W1 | Consequence contours on a plot plan | Import PDF/DWG plot plan → calibrate scale → place anchors on release points → import results table → choose size column(s) and label column → style by scenario → export A1 PDF with legend. |
| W2 | Separation-distance check | Trace or pick equipment footprint → offset by required distance (e.g. +15 m, round corners) → highlight and label zone → measure to nearest item → export. |
| W3 | Area allocation / laydown | Highlight areas with fills and labels → areas auto-computed → export drawing plus area schedule (XLSX). |
| W4 | Sub-drawing on plot plan | Import plot plan and an area layout → align the area layout onto the plot plan by two points → analyse across both → export. |

---

## 4. Core constraints (non-negotiable)

### 4.1 Offline and privacy
- **C1** — After the application is loaded once (or unpacked from the offline bundle), every feature works with the network disconnected.
- **C2** — Drawings, tables and projects are processed only in the browser (File API, Web Workers, WebAssembly). Nothing is uploaded, ever — including in hosted mode, where the server only serves static app files.
- **C3** — No telemetry, analytics, crash reporting, remote fonts, CDNs or runtime downloads. Every asset (fonts, icons, WASM, PDF.js worker, CMaps, CAD fonts) is bundled.
- **C4** — The guarantee is enforced technically (Content Security Policy) and verified automatically (an end-to-end test fails on any request to a non-origin host). See rows 7 and 88.

### 4.2 UI library
- **C5** — UI chrome is built with **shadcn/ui** (Radix primitives + Tailwind CSS). shadcn components are copied into the repository (`src/components/ui`), so no runtime dependency on any registry or CDN.

### 4.3 Inputs
- **C6** — Must accept **.dxf, .dwg and .pdf**. Native .dwg support is required (not "convert to DXF first"), with DXF/PDF as fallback paths when a specific DWG cannot be parsed.

### 4.4 No lost work
- **C7** — Every change is saved locally and automatically, with no save action needed, and survives a tab crash, browser crash, accidental close or reload within the NFR-9 window. Every editing tool in every milestone must commit its changes through the autosave journal and register its in-progress draft state (rows 90–93). A tool's register row cannot be marked Complete until it does.

---

## 5. Architecture and technology baseline

### 5.1 Recommended stack

| Concern | Recommendation | Notes |
|---|---|---|
| Build / language | Vite, React, TypeScript (strict) | Static output only. |
| UI | shadcn/ui, Tailwind CSS v4, Radix, lucide-react icons | Tailwind v4 uses the `@tailwindcss/vite` plugin and CSS-first config. |
| State | Zustand + Immer; command pattern for undo/redo | Derived geometry via memoised selectors. |
| DXF + DWG data model | `@mlightcad/realdwg-web` (MIT) data model for both formats | One entity model for DXF and DWG. |
| DWG parsing | `@mlightcad/libredwg-converter` / `libredwg-web` (LibreDWG compiled to WASM) | **GPL-3.0**; runs in its own Web Worker bundle. See decision D-1. Rebuilt from source without run-time code generation so the strict CSP applies (`vendor/libredwg-web`). |
| DXF parsing | realdwg-web's DXF reader, or `dxf-parser` as fallback | ASCII DXF required. |
| PDF | `pdfjs-dist` with worker, CMaps and standard fonts bundled locally | Vector paths read from `getOperatorList()` for snapping/tracing. |
| Rendering | Underlay: WebGL (Three.js orthographic camera, batched lines). Overlay: Canvas 2D | See decision D-2. |
| Spatial index | flatbush / rbush | Snapping, hit-testing, boundary detection. |
| Offsetting & booleans | Clipper2 TypeScript port (`@countertype/clipper2-ts`, BSL-1.0) or `clipper2-wasm` | Exact analytic offsets for circles/arcs; Clipper2 for polygons. |
| Tables | Papa Parse (CSV/TSV); XLSX library per D-5; TanStack Table (shadcn Data Table) | |
| Persistence and autosave | IndexedDB (Dexie) for journal, snapshots, drafts and restore points; Origin Private File System (OPFS) for large source drawings; File System Access API with download fallback; Web Locks + BroadcastChannel for multi-tab safety | See Section 5.5. |
| Export | pdf-lib (vector PDF, embeds source PDF pages as vectors); custom DXF writer; canvas → PNG; SVG serialiser | |
| Offline | `vite-plugin-pwa` (Workbox) precache; strict CSP | |
| Testing | Vitest (unit/geometry), Playwright (E2E, offline and zero-egress tests) | |

### 5.2 Coordinate model
- All analysis geometry is stored in **world metres as float64**.
- Each underlay has a **placement transform** (from its calibration and optional alignment) that maps drawing units → world metres.
- Rendering uses a **local origin** near the view centre so large plant/UTM coordinates (e.g. 600 000 / 2 500 000) do not jitter in 32-bit GPU precision.

### 5.3 Threads
- Main thread: UI, interaction, overlay rendering.
- Workers: DXF parse, DWG parse (isolated GPL bundle), PDF render and vector extraction, heavy geometry (unions, boundary detection), export generation.

### 5.4 Data model (sketch)

```ts
type Units = 'mm' | 'cm' | 'm' | 'km' | 'in' | 'ft';
type Pt = { x: number; y: number };                      // world metres (float64)
type Vertex = Pt & { bulge?: number };                    // DXF-style bulge for arc segments
type Affine2D = [number, number, number, number, number, number];

interface Project {
  schemaVersion: number;
  id: string; name: string; createdAt: string; updatedAt: string;
  display: { units: Units; precision: number };
  drawings: Drawing[];
  layers: AnalysisLayer[];
  objects: AnalysisObject[];
  anchors: Anchor[];
  datasets: ContourDataset[];
  legend: LegendConfig;
  exportProfiles: ExportProfile[];
}

interface Drawing {
  id: string; name: string;
  source: { kind: 'dxf' | 'dwg' | 'pdf'; fileName: string; sha256: string; blobKey: string };
  page?: number;                                           // PDF page
  calibration?: Calibration;
  alignment?: Affine2D;                                    // sub-drawing → plot plan
  opacity: number;
  hiddenSourceLayers: string[];
}

interface Calibration {
  method: 'cad-units' | 'two-point' | 'multi-point' | 'ratio' | 'coordinates';
  transform: Affine2D;                                     // drawing units → world metres
  references: { drawing: Pt; world: Pt | null; distance?: number }[];
  residualRms?: number;                                    // metres, multi-point only
}

type Geometry =
  | { type: 'circle'; c: Pt; r: number }
  | { type: 'arc'; c: Pt; r: number; a0: number; a1: number }
  | { type: 'rect'; c: Pt; w: number; h: number; rot: number }
  | { type: 'polyline'; pts: Vertex[]; closed: boolean }
  | { type: 'multipolygon'; rings: Vertex[][] };           // results of unions/offsets with holes

interface AnalysisObject {
  id: string; layerId: string; name: string;
  geometry: Geometry; style: StyleRef; label?: LabelSpec;
  attributes: Record<string, string | number>;
  derived?: { kind: 'offset'; sourceId: string; distance: number; join: 'round' | 'miter' | 'square' };
}

interface ContourDataset {
  id: string; name: string; visible: boolean;
  table: { columns: string[]; rows: (string | number | null)[][] };
  mapping: {
    position: { mode: 'xy' | 'plant' | 'anchor'; x?: string; y?: string; anchor?: string };
    sizeColumns: string[]; sizeMode: 'radius' | 'diameter'; sizeUnit: Units;
    label?: string; group?: string; color?: string; shape?: string;
  };
  styleRules: StyleRule[]; labelTemplate: string; filter?: string;
}

// Autosave stores (IndexedDB)
interface JournalEntry { projectId: string; seq: number; at: string; command: SerializedCommand }
interface Snapshot {
  projectId: string; id: string; seq: number; at: string;
  kind: 'checkpoint' | 'auto-restore-point' | 'named'; label?: string;
  sha256: string; data: Blob;                                // serialised Project
}
interface Draft { projectId: string; tool: string; at: string; state: unknown }
```

### 5.5 Autosave and persistence design

```
user edit ─► command (row 11) ─► in-memory state ─► UI
                   │
                   ├─► journal entry ─► IndexedDB (batched, ≤ 1 s)                 rows 90, 97
                   │
every 50 entries / 60 s idle / tab hidden / before export
                   └─► snapshot (worker, SHA-256) ─► IndexedDB ─► journal compacted   row 91
every 10 min of editing / before high-impact operations ─► restore point            row 96
unfinished tool state ─► draft (≤ 1 s)                                              row 93
linked project file (optional) ─► written every 60 s and on hide/close              row 98
source drawings ─► stored once per SHA-256 (OPFS for large files)                   row 99
```

- **Recovery** loads the latest valid snapshot, then replays every journal entry with a higher sequence number. Any entry that fails to apply is skipped and listed in the recovery report.
- **Why a journal rather than only periodic saves:** browsers do not guarantee that asynchronous writes started while a tab is closing will finish. Writing each edit as it happens keeps the at-risk window to about one second, however the tab ends.
- **Single writer:** a Web Lock per project ensures only one tab writes to a project at a time (row 100).
- **Privacy:** autosave is entirely local to the device and never uses the network (C2).

---

## 6. User interface (shadcn/ui)

### 6.1 Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Menubar: File  Edit  View  Draw  Trace  Offset  Data  Export  Help   [⌘K]   │
├────┬──────────────────────────────────────────────────────────┬─────────────┤
│Tool│                                                          │ Inspector   │
│rail│                 Canvas                                   │ [Props]     │
│    │   (underlay WebGL + analysis overlay)                    │ [Layers]    │
│ ↖  │                                                          │ [Data]      │
│ ✎  │                                                          │ [Legend]    │
│ ⌀  │                                                          │             │
│ ⇲  │                                                          │             │
├────┴──────────────────────────────────────────────────────────┴─────────────┤
│ X 612 345.120  Y 2 534 210.004 m │ 1:1000 ✓ │ Snap ● │ 125% │ Saved ✓ 09:46 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Component mapping

| UI element | shadcn component(s) |
|---|---|
| Top menu | Menubar |
| Tool rail | ToggleGroup, Tooltip |
| Panels | Resizable, Tabs, ScrollArea |
| Command palette | Command (Ctrl/⌘+K) |
| Dialogs (import, calibration, export) | Dialog, Form (react-hook-form + zod), Input, Select, RadioGroup |
| Data grid | Data Table (TanStack Table) |
| Layer list | Checkbox, Switch, DropdownMenu, ContextMenu |
| Style controls | Popover, Slider, Select (colour picker via a small bundled library) |
| Feedback | Sonner (toasts), Progress, Badge, Alert |
| Confirmations | AlertDialog |
| Autosave status, recovery and history | Badge + Tooltip (save status), AlertDialog (crash recovery), Sheet (restore points list), Alert (storage warnings) |

---

## 7. Non-functional targets

Reference machine: mid-range laptop, 8 GB RAM, integrated GPU, current Chrome/Edge. Targets are initial and confirmed against the reference drawing set (row 85).

| ID | Target |
|---|---|
| NFR-1 | Offline cold start from cache ≤ 3 s. |
| NFR-2 | 20 MB ASCII DXF parsed and displayed ≤ 10 s; UI responsive throughout (no main-thread block > 100 ms). |
| NFR-3 | 10 MB DWG parsed and displayed ≤ 15 s. |
| NFR-4 | Pan/zoom ≥ 50 fps with 200 000 underlay segments. |
| NFR-5 | Contour re-binding (label/size column change) ≤ 100 ms for 5 000 rows × 3 size columns. |
| NFR-6 | Offset of a 1 000-vertex polygon ≤ 50 ms. |
| NFR-7 | Geometric accuracy: offsets and measurements within 1 mm at site extents up to 10 km. |
| NFR-8 | Zero network requests to any non-origin host, at any time. |
| NFR-9 | Autosave recovery point: no committed edit older than 1 s is lost on tab crash, browser crash, forced close or reload. The same applies after an OS crash or power loss where the browser supports strict (durable) storage commits. |
| NFR-10 | Autosave adds no main-thread block > 16 ms while editing; crash recovery reaches an editable state ≤ 5 s for the reference project. |

---

## 8. Feature register

Columns: **#** row number · **Feature** · **Description and acceptance** · **Target** version · **Status**.

### 8.1 Baseline — 0.0.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 1 | Functional design requirements | This document: scope, constraints, architecture baseline, feature register and roadmap. Accept: drafted and placed under version control as the project's spec. | 0.0.0 | Complete |

### 8.2 Foundation and offline — 0.1.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 2 | Project scaffold | Vite + React + TypeScript (strict) + Tailwind v4 + shadcn/ui; components vendored in `src/components/ui`; ESLint/Prettier; CI builds and runs tests. Accept: clean build produces a static `dist/` with no external URLs in any file. | 0.1.0 | Complete |
| 3 | Application shell | Menubar, tool rail, resizable canvas area, inspector tabs (Properties, Layers, Data, Legend) and status bar per Section 6. Accept: panels resize and collapse; layout persists between sessions. | 0.1.0 | Complete |
| 4 | Command palette and shortcuts | Ctrl/⌘+K palette listing every command; configurable shortcut map; shortcut cheat-sheet dialog. Accept: every tool reachable from keyboard and palette. | 0.1.0 | Complete |
| 5 | Theming and self-hosted assets | Light/dark themes; dark and light canvas backgrounds independent of UI theme; fonts and icons bundled. Accept: no font or icon request leaves the origin. | 0.1.0 | Complete |
| 6 | Offline PWA | Service worker precaches all assets including WASM, workers, PDF.js CMaps and standard fonts; app is installable; update prompt appears when a new version is cached (update check fails silently offline). Accept: with network disabled after first load, every feature in the register works. | 0.1.0 | Complete |
| 7 | Zero-egress guarantee | Strict CSP (`connect-src 'self'`, no remote `script-src`/`font-src`/`img-src`); no telemetry; files read only via File API; About dialog states the privacy guarantee. Accept: Playwright test loads drawings, runs all tools and exports while failing on any non-origin request. | 0.1.0 | Complete |
| 8 | Offline distribution bundle | Zipped static build plus a one-line local launch instruction (browsers restrict workers, WASM and service workers on `file://`). Packaging option per decision D-3. Accept: on an air-gapped PC, unzip → launch → full functionality. | 0.1.0 | Complete |
| 9 | Local project store | Projects stored in IndexedDB with a recent-projects list on the start screen; source drawing bytes stored with the project (deduplicated, see row 99). Automatic saving is specified in rows 90–102. Accept: a project reopens identically after the browser is restarted. | 0.1.0 | Complete |
| 10 | Project file save/open | Portable project file (zip of project JSON + original drawings) saved/opened via File System Access API, with download/upload fallback; schema version recorded. Accept: a project saved on one PC opens identically on another. | 0.1.0 | Complete |
| 11 | Undo/redo | Command-pattern history for every edit (including calibration, imports and mapping changes); ≥ 200 steps; Ctrl+Z / Ctrl+Shift+Z. Accept: undo of any action restores exact prior state. | 0.1.0 | Complete |
| 12 | Notifications and error reporting | Toasts for success/warnings; import reports listing skipped/unsupported entities with counts; no silent failures. Accept: a malformed file produces a readable report, not a crash. | 0.1.0 | Complete |

### 8.2.1 Autosave and data-loss protection — 0.1.0

Rows 90–102 were added in Rev B. They take the next free numbers (rows are never renumbered) but belong to the 0.1.0 milestone, so that autosave is in place before any editing tool is built.

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 90 | Continuous autosave journal | Every committed edit (each undoable command from row 11, including imports, calibration, mapping and style changes) is appended to a write-ahead journal in IndexedDB automatically, with no save action needed. Writes are batched at most every 1 s, kept off the main thread where possible, and use strict transaction durability where the browser supports it. Accept: NFR-9 met; killing the browser process at a random moment loses no edit committed more than 1 s earlier. | 0.1.0 | Complete |
| 91 | Snapshot checkpoints and integrity | Full project snapshots are serialised in a worker and written atomically every 50 journal entries, after 60 s of idle and on lifecycle events (row 92); the journal is then compacted. Each snapshot carries a sequence number and SHA-256 checksum, and the last 3 good snapshots are kept. A corrupt snapshot or journal entry is skipped and reported, and the previous good snapshot is used. Accept: a deliberately corrupted latest snapshot opens from the previous one plus the journal, with no further loss. | 0.1.0 | Complete |
| 92 | Lifecycle and pre-operation saves | Pending journal entries are flushed and a checkpoint taken when the tab is hidden or closed (`visibilitychange`, `pagehide`), before closing or switching projects, and before export. Before any high-impact operation (recalibration, dataset re-import, bulk delete, applying a restore point, schema migration) an automatic restore point (row 96) is created first. Accept: each listed operation can be reversed by restoring the point created just before it. | 0.1.0 | Complete |
| 93 | In-progress work drafts | Unfinished interactions are saved as drafts within 1 s: a half-drawn shape or trace (vertices so far), open import, column-mapping or calibration dialogs with their entered values, and unsaved label text. After recovery the user is offered to resume the draft. The mechanism is delivered here; every later tool row must register its draft state (C7). Accept: a tab crash after placing 20 trace vertices resumes with all 20. | 0.1.0 | Complete |
| 94 | Save status indicator | Status bar badge showing "Saved locally · hh:mm:ss", "Saving…", "Saved to file" (row 98) or "Not saved — action needed" with the reason; tooltip shows last snapshot time and storage used. Accept: the indicator never shows "Saved" while unflushed changes exist (verified by test hook). | 0.1.0 | Complete |
| 95 | Unclean-shutdown recovery | A session marker detects crashes, forced closes and power loss. On next launch a recovery dialog lists affected projects with last-change time and a summary of recovered edits; options are Restore (default), Open last checkpoint only, or Discard. Discarded recovery data is kept in a recovery bin for 7 days. Accept: NFR-10 recovery time met for the reference project. | 0.1.0 | Complete |
| 96 | Restore points (version history) | Automatic restore points every 10 min of active editing and before high-impact operations (row 92), plus user-named checkpoints (Ctrl+Shift+S). A history panel lists them with time, label and change summary; each can be previewed read-only, restored (itself undoable) or restored as a copy. Default retention: all named points, the last 30 automatic points, and one per day for 30 days; configurable. Accept: restoring any point reproduces the project exactly, verified by snapshot hash. | 0.1.0 | Complete |
| 97 | Persistent undo history | The undo/redo stack is rebuilt from the journal after reload or recovery, so the last 200 steps stay undoable across sessions. Accept: draw a shape, reload, press Ctrl+Z, and the shape is removed. | 0.1.0 | Complete |
| 98 | Autosave to linked project file | When a project is saved to or opened from a file (row 10) in a browser with the File System Access API, the user can turn on autosave to that file: written every 60 s while changed and on tab hide/close, through the API's write-then-commit stream so a failed write never corrupts the existing file. Browsers without the API show a reminder to download a backup after 30 min (configurable) of work not saved to file. Accept: killing the tab during a file write leaves the previous file intact and openable. | 0.1.0 | Complete |
| 99 | Storage persistence, quota and failure handling | Requests persistent storage (`navigator.storage.persist()`) when the first project is created and shows whether it was granted. Monitors `navigator.storage.estimate()` and warns at 80% of quota. On quota-exceeded or storage errors: retry with back-off, keep changes in memory, show a blocking alert and offer "Save project to file" so nothing is lost. If storage is unavailable (e.g. some private-browsing modes), a persistent banner says autosave is off and prompts for file saving. Source drawings stored once per SHA-256 (OPFS for large files). Accept: filling the quota in a test triggers the alert, and saving to file succeeds with no edit lost. | 0.1.0 | Complete |
| 100 | Multi-tab write protection | The same project open in two tabs or windows cannot overwrite itself: Web Locks give one tab write access; others open read-only with a "Take over editing" option, which flushes and releases the first tab. BroadcastChannel keeps read-only tabs up to date. Accept: editing in two tabs never produces a lost or interleaved change. | 0.1.0 | Complete |
| 101 | Autosave settings and local data controls | Settings for restore-point interval and retention, file-autosave interval and backup-reminder interval. Local journalling itself cannot be switched off. "Clear local data" for shared PCs, with confirmation and a prompt to export projects first. Accept: settings persist and take effect without reload. | 0.1.0 | Complete |
| 102 | Autosave fault-injection tests | Automated suite that kills the browser at random points during editing, snapshotting and file writes; corrupts snapshots and journal entries; fills the storage quota; edits in two tabs; and runs offline throughout. Accept: zero lost edits beyond NFR-9 across 100 randomised kill-points per CI run. | 0.1.0 | Complete |

### 8.3 Drawing import and viewer — 0.2.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 13 | Import entry points and type detection | Drag-and-drop onto canvas, File → Import, and Open dialog; accepts .dxf/.dwg/.pdf; type detected by file signature, not extension; warning above a configurable size. Accept: a mis-named file is still identified correctly or rejected clearly. | 0.2.0 | Complete |
| 14 | DXF import | ASCII DXF (binary DXF desirable). Entities: LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE, SPLINE (tessellated), POINT, SOLID, HATCH (boundary + fill), TEXT, MTEXT, INSERT (nested blocks with transforms), DIMENSION (as rendered block). Layers, colours, linetypes and lineweights honoured; `$INSUNITS` read to propose units; model space default, layouts selectable. Accept: reference DXF set renders matching a CAD viewer by visual comparison. | 0.2.0 | Complete |
| 15 | PDF import and rendering | pdfjs-dist with local worker; page picker for multi-page sets; resolution-adaptive tiled rendering so lines stay crisp when zoomed; optional-content (PDF layers) toggle when present. Accept: A0 vector PDF stays sharp at 1 600% zoom. | 0.2.0 | Complete |
| 16 | PDF vector extraction | Paths, rectangles and curves read from the page operator list, transformed to page coordinates and indexed for snapping and tracing; raster-only (scanned) pages detected and flagged ("raster — snapping unavailable"). Accept: endpoint/intersection snaps work on a vector PDF plot plan. | 0.2.0 | Complete |
| 17 | Viewer navigation | Pan (middle mouse, Space+drag, touch), zoom at cursor (wheel/pinch), zoom window, zoom extents, zoom to selection, saved views; view rotation in 90° steps and free angle. Accept: NFR-4 met. | 0.2.0 | Incomplete |
| 18 | Large-coordinate handling | float64 storage with local-origin rendering so plant/UTM-sized coordinates render without jitter. Accept: geometry at X 600 000 / Y 2 500 000 renders and snaps with no visible wobble at max zoom. | 0.2.0 | Complete |
| 19 | Source layer control and underlay dimming | Lists DXF/DWG layers and PDF optional-content groups; search, toggle, isolate; underlay opacity and greyscale ("ghost") mode so analysis stands out. Underlays are always read-only. Accept: hiding a layer removes it from view, snapping and export. | 0.2.0 | Complete |
| 20 | Entity inspector | Hover/click any underlay entity to see type, layer, length/radius/area (in world units once calibrated). Accept: values match CAD within NFR-7 tolerance. | 0.2.0 | Complete |
| 21 | Background parsing with progress | All parsing in Web Workers with progress bar and cancel. Accept: UI stays interactive during a large import (NFR-2). | 0.2.0 | Incomplete |

### 8.4 DWG support — 0.3.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 22 | DWG import | Native DWG via LibreDWG WASM in a dedicated worker, converted into the same entity model as DXF (row 14 entity coverage). Target formats up to the 2018 DWG format (AC1032); newer/unknown formats produce a clear message. Accept: reference DWG set renders matching a CAD viewer. | 0.3.0 | Complete |
| 23 | DWG fallback and diagnostics | On failure or partial parse: show what loaded, what was skipped, and guidance to supply DXF or PDF of the same drawing. Accept: no DWG causes a hang or blank screen without explanation. | 0.3.0 | Complete |
| 24 | CAD text fonts | Open-licence fallback fonts bundled for SHX/TTF text styles; font substitution table; never downloads fonts. Accept: text in reference drawings is legible and correctly positioned. | 0.3.0 | Complete |
| 25 | Licence isolation and notices | GPL-3.0 DWG parser shipped only in its own worker bundle; About → Licences lists every third-party component and licence. Accept: licence list generated at build time and matches the dependency tree. | 0.3.0 | Complete |

### 8.5 Scale, units, snapping and measurement — 0.4.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 26 | Units and precision | World display units (mm, m, km, in, ft) and decimal precision; CAD drawing units from file header with user override; PDF units handled as paper units. Accept: switching display units updates every readout and label instantly. | 0.4.0 | Complete |
| 27 | Snapping engine | Endpoint, midpoint, centre, quadrant, intersection, nearest, perpendicular and tangent snaps on vector underlays and analysis objects; ortho and polar tracking; snap glyph and tooltip; toggles in status bar. Accept: snapped picks equal source coordinates exactly. | 0.4.0 | Complete |
| 28 | Scale from a measured distance | Pick two points (with snapping) on a known dimension and enter its real length → scale computed. Accept: re-measuring the same dimension returns the entered value. | 0.4.0 | Complete |
| 29 | Multi-reference calibration | Three or more reference distances or points; least-squares fit; residual (RMS and per-reference) shown; option for separate X/Y scale for distorted scans. Accept: residual reported and worst reference highlighted. | 0.4.0 | Complete |
| 30 | Scale from ratio | Enter a stated scale (e.g. 1:500) for a PDF, using the PDF's true paper size; for CAD, confirm unit-to-metre factor. Accept: a 1:500 A1 PDF measures correctly without picking points. | 0.4.0 | Complete |
| 31 | Plant / grid coordinates | Pick two or more points with known plant coordinates (E/N) to define translation, rotation and scale; cursor readout and exports in plant coordinates; plant-north vs true-north angle. Accept: picking a grid intersection shows its labelled coordinate within NFR-7. | 0.4.0 | Complete |
| 32 | Calibration status and guard | Status bar badge (Uncalibrated / Calibrated / Verified); measurement, offset and contour tools warn on uncalibrated drawings; "Check distance" tool to verify against another known dimension. Accept: it is impossible to export distances without the calibration state shown on the output. | 0.4.0 | Complete |
| 33 | Recalibration behaviour | Changing a calibration asks whether existing analysis objects move with the drawing (apply delta transform) or stay in world position; undoable. Accept: both options behave as described. | 0.4.0 | Complete |
| 34 | Sub-drawing alignment | Place a sub-drawing onto the plot plan by two-point alignment (move/rotate/scale) or by shared coordinates; per-drawing opacity and draw order. Accept: matching features on both drawings coincide within NFR-7 after alignment. | 0.4.0 | Complete |
| 35 | Measurement tools | Distance, chained distance, polyline length, area and perimeter, radius/diameter, angle; results kept as optional measurement annotations. Accept: results match CAD measurements within NFR-7. | 0.4.0 | Complete |
| 36 | Scale bar and north arrow | On-canvas and export-ready scale bar (auto "nice" lengths) and north arrow (plant or true north). Accept: scale bar length is correct on exported true-scale PDF. | 0.4.0 | Complete |

### 8.6 Annotation, highlighting and labels — 0.5.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 37 | Analysis layers | Create, rename, recolour, reorder, hide, lock and delete layers; every analysis object belongs to one layer; layers feed the legend. Accept: locked layers cannot be edited or selected. | 0.5.0 | Complete |
| 38 | Shape tools | Line, polyline, polygon, rectangle (axis-aligned and rotated), circle (centre-radius, centre-diameter, 3-point), arc (3-point, centre-start-end), ellipse, revision cloud; dimensions typed during drawing. Accept: a circle typed as Ø 30 m measures 30 m. | 0.5.0 | Complete |
| 39 | Area highlighting | Fill closed shapes with colour and opacity, or hatch (solid, diagonal, cross, dots); border style; area and perimeter computed live. Accept: overlapping highlights remain distinguishable and draw order is controllable. | 0.5.0 | Complete |
| 40 | Object labels | Label attached to any object, placed at centroid, on boundary, or via leader; template fields such as `{name}`, `{area}`, `{perimeter}`, `{radius}`, `{diameter}`, `{layer}` and custom attributes; size in paper or world units; text halo. Accept: editing a shape updates its label values immediately. | 0.5.0 | Complete |
| 41 | Callouts, text and numbered tags | Free text, leader callouts and auto-numbered bubble tags (sequence per layer, renumbering). Accept: deleting a tag offers renumbering of the sequence. | 0.5.0 | Complete |
| 42 | Style editor and presets | Stroke colour/width/dash, fill colour/opacity/pattern, label font/size/colour; save and apply style presets; style by layer or per object. Accept: applying a preset to a selection updates all selected objects in one undo step. | 0.5.0 | Complete |
| 43 | Selection and transform | Click, window/crossing and lasso selection; move, rotate, scale, copy, mirror, delete; grip editing of vertices and radius handles. Accept: all transforms respect snapping and typed values. | 0.5.0 | Complete |
| 44 | Numeric property editing | Inspector shows editable centre X/Y, radius/diameter, width/height, rotation and vertex list in world units. Accept: typing a value moves the object exactly. | 0.5.0 | Complete |
| 45 | Object attributes | Name, category, notes and custom key-value attributes per object; available to labels, legend and exports. Accept: attributes appear as columns in the tabular export. | 0.5.0 | Complete |
| 46 | Objects table | Searchable, filterable Data Table of all analysis objects (layer, type, area, perimeter, radius); click a row to select and zoom. Accept: selection is synchronised both ways between table and canvas. | 0.5.0 | Complete |
| 47 | Anchors (named reference points) | Place named points on the drawing (snapped to equipment centres, nozzles, etc.); bulk-create from picked circle centres. Used by contour import (row 64). Accept: renaming an anchor updates every dataset row referencing it. | 0.5.0 | Complete |
| 48 | Unicode and right-to-left text | Labels and annotations support any Unicode text including Arabic (RTL shaping) in canvas and all exports. Accept: Arabic label renders correctly in canvas, PDF, SVG and DXF export. | 0.5.0 | Complete |

### 8.7 Tracing — 0.6.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 49 | Manual trace | Click-by-click polyline/polygon tracing over the underlay with snapping, straight and arc segments (3-point and tangent), close-to-polygon, Backspace to remove the last vertex. Accept: traced polygon vertices equal snapped source points. | 0.6.0 | Complete |
| 50 | Pick-trace from entity | Click any vector underlay entity (line, polyline, circle, arc, ellipse, hatch boundary, block outline) to copy its exact geometry into an analysis object. Accept: a picked circle has the source centre and radius exactly. | 0.6.0 | Complete |
| 51 | Chain trace (auto-follow) | Click a vector path to auto-follow connected segments within a gap tolerance until closure or a junction; Tab cycles direction at junctions. Accept: a building outline drawn as separate lines is traced into one closed polygon in one click plus junction choices. | 0.6.0 | Complete |
| 52 | Boundary pick | Click inside a region enclosed by vector geometry to detect the closed boundary (with gap tolerance and island/hole detection), like a CAD hatch pick-point. Runs in a worker on visible geometry. Accept: picking inside a bunded area returns the bund outline. | 0.6.0 | Complete |
| 53 | Trace editing and cleanup | Add/remove/move vertices, join, split, reverse, close/open, remove duplicates, simplify with tolerance, convert segment line ↔ arc. Accept: simplify never moves a vertex beyond the set tolerance. | 0.6.0 | Complete |
| 54 | Precision aids for raster drawings | For scanned PDFs: magnifier loupe, ortho/polar constraints, grid snap and edge-contrast enhancement to support accurate manual tracing. Accept: tracing on a raster reference page achieves the accuracy stated in the test plan. | 0.6.0 | Complete |

### 8.8 Offset (expand / contract) — 0.7.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 55 | Circle and arc offset | Enter a distance in world units, positive to expand and negative to contract; result is exact (r ± d), concentric, arcs keep their angular span; contraction to r ≤ 0 is rejected with a message. Accept: analytic result within floating-point tolerance. | 0.7.0 | Complete |
| 56 | Box (rectangle) offset | Expand or contract rectangles, including rotated ones, with corner style: round (true distance, default per D-4), mitred (square box) or bevel. Accept: round-corner result equals the exact Minkowski sum within NFR-7. | 0.7.0 | Complete |
| 57 | Polygon and polyline offset | Clipper2 inflate/deflate with join type round/miter/square, miter limit and arc tolerance; open polylines produce a corridor with round/butt/square caps; holes and self-intersections handled; collapse on contraction yields a warning. Accept: test suite of convex, concave and holed polygons passes. | 0.7.0 | Complete |
| 58 | Multi-ring offset | Generate several rings from one source at a list of distances (e.g. 10, 25, 50 m) or a fixed interval; each ring auto-labelled with its distance and styled from a ramp. Accept: rings are created on one layer and appear as one legend group. | 0.7.0 | Complete |
| 59 | Parametric (live) offset | Offsets keep a link to their source and distance; changing the distance or editing the source updates the result instantly; "Detach" converts to static geometry. Accept: moving a source vertex updates the offset in real time. | 0.7.0 | Complete |
| 60 | Batch offset and merge | Apply one offset to a selection; option to merge overlapping results into a single envelope (union). Accept: merged envelope area equals the boolean union area. | 0.7.0 | Complete |
| 61 | Offset accuracy | Integer scaling for Clipper2 chosen to keep ≤ 1 mm precision at 10 km extents; arc tessellation chord tolerance user-set (default 5 mm). Accept: NFR-6 and NFR-7 met in automated tests. | 0.7.0 | Complete |

### 8.9 Bulk contour import — 0.8.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 62 | Table import | CSV, TSV, XLSX (sheet picker) and paste-from-clipboard (copied Excel range); header-row detection; preview of the first 50 rows; UTF-8 including Arabic. Accept: the same data imported by each route produces identical datasets. | 0.8.0 | Complete |
| 63 | Column mapping | Map columns to roles: position (X/Y, plant E/N, or anchor ID), one or more size columns, size mode (radius or diameter), size unit, label, group/category, colour, shape (circle default; square or W×H rectangle), rotation. Accept: mapping dialog prevents saving with a required role unmapped. | 0.8.0 | Complete |
| 64 | Positioning modes | Rows positioned by drawing coordinates, plant coordinates (needs row 31) or anchor names (row 47); unmatched anchors listed. Accept: a row referencing anchor "P-101" draws its contour on P-101. | 0.8.0 | Complete |
| 65 | Multiple size columns | Several size columns per row (e.g. three radiation levels) produce concentric contour sets, each with its own style and legend entry; user chooses which columns are displayed. Accept: toggling a size column shows/hides that ring set only. | 0.8.0 | Complete |
| 66 | Instant re-binding | Changing the label column, size column(s), radius/diameter mode, units, filter or style rule updates every contour without reload, flicker or loss of styling; each change is one undo step. Accept: NFR-5 met; no stale labels or contours after rapid repeated changes. | 0.8.0 | Complete |
| 67 | Style rules | Colour by category column (categorical palette) or by value (graduated ramp with class breaks); line style and fill opacity per group; legend entries generated from rules. Accept: adding a new category value in the data gets a colour and a legend entry automatically. | 0.8.0 | Complete |
| 68 | Live data grid | Dataset shown in a Data Table; inline cell editing, add/delete rows, sort and filter; row ↔ contour cross-highlighting. Accept: editing a radius cell updates its contour immediately. | 0.8.0 | Complete |
| 69 | Row validation | Flags non-numeric or negative sizes, missing positions, unknown anchors and points outside the drawing extent; invalid rows skipped and listed with reasons; summary badge on the dataset. Accept: a table with deliberate errors reports each one by row number. | 0.8.0 | Complete |
| 70 | Contour labels | Label from the mapped label column or a template (e.g. `{label} – {radius} m`); placement at top of ring, centre or via leader; collision avoidance between neighbouring labels. Accept: changing the label column updates all labels in one step (NFR-5). | 0.8.0 | Complete |
| 71 | Dataset management and filters | Multiple datasets per project; visibility, draw order, legend group per dataset; row filter expressions (e.g. `category = "Jet fire" AND radius > 20`). Accept: filters apply live and are reflected in the legend and export. | 0.8.0 | Complete |
| 72 | Re-import and change summary | Replace a dataset's data with a newer file while keeping mapping and styles; summary of added, removed and changed rows. Accept: re-import of an updated results file needs no remapping when headers are unchanged. | 0.8.0 | Complete |
| 73 | Mapping templates | Save column mapping, style rules and label template as a reusable template; auto-suggest a template when headers match. Accept: importing a file with known headers applies the template in one click. | 0.8.0 | Complete |
| 74 | Envelope option | Optional union of all visible contours in a set into one envelope (per size column), shown as its own legend entry. Accept: envelope area equals boolean union area. | 0.8.0 | Complete |

### 8.10 Legend and export — 0.9.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 75 | Legend builder | Legend auto-built from analysis layers, styles, contour datasets and style rules; editable titles, order, grouping and hide/show per entry; position and size on sheet. Accept: every visible styled item on the export has a legend entry unless deliberately hidden. | 0.9.0 | Complete |
| 76 | Sheet layout and title block | Paper size (A4–A0, ANSI A–E, custom), orientation, margins, viewport window, title block fields (title, project, drawing no., revision, date, prepared/checked by, notes), scale statement, scale bar, north arrow and calibration state. Accept: layout preview matches export exactly. | 0.9.0 | Complete |
| 77 | Vector PDF export at true scale | Underlay plus analysis plus legend plus title block; selected print scale honoured on paper; source PDF pages embedded as vectors; CAD underlays drawn as vectors; raster only for raster sources; analysis layers as PDF optional-content layers. Accept: measuring the printed PDF with a scale rule matches world distances. | 0.9.0 | Complete |
| 78 | PNG and SVG export | Export current view, window or sheet at chosen DPI; SVG keeps analysis layers as groups. Accept: 300 DPI A1 PNG export succeeds within memory limits on the reference machine. | 0.9.0 | Complete |
| 79 | DXF export of analysis | Analysis objects, labels and optionally legend written to DXF in the original drawing (or plant) coordinates on named layers, so the result can be referenced back into CAD. Accept: exported DXF overlays the source drawing exactly when XREF'd at 0,0. | 0.9.0 | Complete |
| 80 | Tabular export | CSV/XLSX of analysis objects (name, layer, type, area, perimeter, centroid, radii, attributes) and of contour datasets with computed fields; calibration details in a header sheet. Accept: totals match on-screen values. | 0.9.0 | Complete |
| 81 | Export preview and profiles | WYSIWYG preview dialog; save export settings as named profiles (e.g. "A1 client issue"). Accept: re-running a profile reproduces the same output. | 0.9.0 | Complete |

### 8.11 Release hardening — 1.0.0

| # | Feature | Description and acceptance | Target | Status |
|---|---|---|---|---|
| 82 | Performance budget | All NFR-1 to NFR-7, NFR-9 and NFR-10 targets met on the reference machine and drawing set; performance tests in CI. Accept: CI performance job green. | 1.0.0 | Incomplete |
| 83 | Browser support | Primary: current Chrome and Edge. Secondary: current Firefox and Safari, with file-save fallbacks where File System Access API is unavailable. Accept: E2E suite passes on primary browsers; smoke suite on secondary. | 1.0.0 | Complete |
| 84 | Accessibility | Keyboard operation of all UI chrome, visible focus, Radix ARIA patterns, WCAG 2.1 AA contrast for UI; objects table (row 46) as non-visual alternative to the canvas. Accept: automated accessibility checks pass with no serious issues. | 1.0.0 | Complete |
| 85 | Test suite and reference drawing set | Unit tests (geometry, offsets, calibration, mapping), parser fixtures and a curated reference set (DXF, DWG of several versions, vector and scanned PDFs, large plot plan, sub-drawing pair, sample contour tables). Accept: suite runs offline in CI; coverage on geometry modules ≥ 90%. | 1.0.0 | Complete |
| 86 | In-app help | Offline quick-start, workflow guides (W1–W4), tool reference and shortcut sheet inside the app. Accept: help available with network disabled. | 1.0.0 | Complete |
| 87 | Recovery regression and migrations | Autosave fault-injection suite (row 102) re-run against every tool in the 1.0.0 feature set, including drafts for all tools (C7); project schema migrations tested from every earlier schema version, with an automatic restore point taken before migrating. Accept: suite green, and projects saved by any 0.x build open in 1.0.0. | 1.0.0 | Complete |
| 88 | Security and privacy review | CSP audit, dependency vulnerability audit, verification of zero egress (NFR-8), no `eval`, and review of third-party licences (incl. D-1 outcome). Accept: review checklist signed off. | 1.0.0 | Incomplete |
| 89 | Release 1.0.0 | All other register rows Complete; changelog, licence notices and offline bundle published; version tagged 1.0.0. Accept: release checklist complete. | 1.0.0 | Incomplete |

---

## 9. Release roadmap: 0.0.0 → 1.0.0

| Version | Theme | Rows | Exit criteria |
|---|---|---|---|
| 0.0.0 | Specification baseline | 1 | FDR in version control. |
| 0.1.0 | Foundation, offline and autosave | 2–12, 90–102 | App shell runs installed and fully offline; zero-egress test green; autosave fault-injection suite green. |
| 0.2.0 | DXF and PDF viewing | 13–21 | Reference DXF and PDF sets view correctly; navigation meets NFR-4. |
| 0.3.0 | DWG support | 22–25 | Reference DWG set views correctly; fallbacks and licence notices in place. |
| 0.4.0 | Scale, snapping and measurement | 26–36 | All calibration methods verified; measurements within NFR-7. |
| 0.5.0 | Annotation, highlighting and labels | 37–48 | Layers, shapes, fills, labels and anchors complete. |
| 0.6.0 | Tracing | 49–54 | Manual, pick, chain and boundary tracing complete. |
| 0.7.0 | Offset | 55–61 | Exact circle/arc/box offsets and Clipper2 polygon offsets verified. |
| 0.8.0 | Bulk contour import | 62–74 | Instant re-binding meets NFR-5. |
| 0.9.0 | Legend and export | 75–81 | True-scale PDF and DXF exports verified. |
| 1.0.0 | Hardening and release | 82–89 | All 102 register rows Complete. |

---

## 10. Open decisions

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D-1 | DWG parsing engine | (a) LibreDWG WASM — free, GPL-3.0, worker-isolated; (b) ODA Drawings SDK compiled to WASM — commercial licence, generally higher fidelity. | (a) for 1.0.0 with DXF/PDF fallback. Obtain licensing advice on GPL-3.0 obligations before distributing commercially; keep the parser behind a converter interface so (b) can replace it. |
| D-2 | Rendering engine | (a) Three.js WebGL underlay + Canvas 2D overlay; (b) PixiJS for both; (c) Konva/Canvas 2D only. | (a): proven for browser CAD viewing at scale, while Canvas 2D keeps overlay interaction simple. Spike with the largest reference drawing before committing. |
| D-3 | Offline packaging | (a) Hosted PWA (install once, offline thereafter); (b) zipped static build run via a local static server; (c) single self-contained HTML file (inlined workers/WASM); (d) desktop wrapper (e.g. Tauri). | (a) + (b) for 1.0.0; spike (c) as it would allow double-click launch on air-gapped PCs; (d) post-1.0 if required. |
| D-4 | Default box offset corners | Round (true distance) vs mitred (square). | Round — it represents "everything within d metres"; mitred available per operation. |
| D-5 | XLSX library | SheetJS Community Edition (vendored) vs ExcelJS. | Decide on bundle size and licence; both are usable offline when vendored. |
| D-6 | World frame | Analysis stored in world metres with drawings placed by transforms (as Section 5.2) vs analysis stored per drawing. | World metres — required for sub-drawing alignment and multi-drawing analysis. |

---

## 11. Post-1.0 backlog (not part of 1.0.0)

| ID | Candidate |
|---|---|
| B-1 | Encroachment check — flag analysis objects or underlay entities inside an offset or contour zone, with a clash list. |
| B-2 | Non-circular contours from tables — ellipses/plumes from downwind distance, width and wind direction columns. |
| B-3 | Raster auto-vectorisation of scanned drawings. |
| B-4 | Georeferencing to UTM/WGS 84 with KML/GeoJSON export. |
| B-5 | Review mode — comments and markups exchanged via project files. |
| B-6 | Desktop wrapper (D-3 option d). |
| B-7 | Drawing revision compare — overlay two revisions of a plot plan and highlight differences. |

---

## 12. Revision history

| Rev | Date | Change |
|---|---|---|
| A | 13 Oct 2026 | First draft. Product at 0.0.0; row 1 Complete, rows 2–89 Incomplete. |
| B | 14 Oct 2026 | Added autosave and data-loss protection: constraint C7, NFR-9 and NFR-10, Section 5.5, definitions, and rows 90–102 (0.1.0). Revised rows 9, 82, 87 and 89, the status bar, and the 0.1.0 and 1.0.0 roadmap entries. Product remains at 0.0.0. |
| C | 14 Oct 2026 | Statuses updated after implementation: every row Complete except 17, 21 and 82 (GPU frame rates need the reference-machine performance run), 22 (DWG reader blocked by the CSP header, decision U-1), 88 (review sign-off) and 89 (release). Product version 0.1.0: rows 17, 21 and 22 keep 0.2.0 and later milestones open, although most of their rows are Complete. Row 54's accuracy target is defined in `docs/TEST-PLAN.md` §3. Autosave also keeps a backup copy outside IndexedDB, because Chromium can delete the database after a crash (found by row 102). "Merged" means merged into the integration branch `claude/youthful-mayer-flojae`, which fast-forwards onto `main` (decision U-6). Commit references per row are in `CHANGELOG.md`; open items are in `docs/USER-DECISIONS.md`. |
| D | 14 Oct 2026 | Row 22 Complete: the DWG reader is rebuilt from the libredwg-web 0.8.0 sources without run-time code generation (decision U-1, option 1), so DWG import works under the strict CSP header in the offline bundle, `vite preview` and hosted mode. NFR-3 now has a performance test (10 MB DWG), and `npm run perf:reference` runs the reference-machine check on any OS in a visible browser window. Hosted mode (Cloudflare) serves the built app with the app's CSP as a header. Still Incomplete: 17, 21 and 82 (reference-machine run, U-2), 88 (reviewer sign-off and D-1 legal advice) and 89 (release). Product version 0.1.1 (patch: no new rows; the 0.2.0 milestone still waits for rows 17 and 21). Statuses on a feature branch take effect when it is merged into `main`, which now holds the Rev C work (pull request #1). |
| E | 15 Oct 2026 | Row 17: every navigation feature it names is implemented and tested; zoom to selection and a saved views manager (go to, update, rename, delete) were added, and `e2e/navigation.spec.ts` covers wheel and pinch zoom, every pan method, zoom window, extents and selection, 90° and free rotation, and saved views. NFR-4's main-thread time per frame is now enforced in CI (≤ 10 ms; 1–3 ms measured). Row 17 stays Incomplete: its acceptance is NFR-4's frame rate, which needs the reference machine (U-2). Product version 0.1.2 (patch). |
| F | 15 Oct 2026 | Row 21: tables (CSV, TSV, XLSX, pasted ranges) are now parsed in a Web Worker as well; before, a 5 000-row XLSX blocked the UI for about 150 ms and a 200 000-row one for 2.5 s. A cancelled or failed reload of a stored drawing can be loaded again instead of staying "loading". Progress, cancel and UI use during a large import are tested (`e2e/background-parsing.spec.ts`); the performance suite measures no main-thread block over 50 ms while a 20 MB DXF, a 10 MB DWG or a 50 000-row table is read. Row 21 stays Incomplete until NFR-2 is confirmed on the reference machine (U-2). Product version 0.1.3 (patch). |
| G | 15 Oct 2026 | C7 / rows 87, 93, 102: unfinished-work drafts are now part of the backup copy outside IndexedDB, so they also survive the browser deleting its database after a crash (before, the project was restored without them). Found through an intermittent CI failure of the draft crash tests. No status changes; product version 0.1.4 (patch). |
