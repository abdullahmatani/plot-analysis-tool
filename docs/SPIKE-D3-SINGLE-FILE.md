# Spike: one self-contained HTML file (decision D-3, option c)

FDR §10, D-3 recommends "(a) + (b) for 1.0.0; spike (c) as it would allow double-click launch on
air-gapped PCs". This is that spike: can the app run as a single HTML file opened straight from disk
(`file://`), with no launcher?

**Decision (owner, 15 Oct 2026): keep options (a) and (b); option (c) is not adopted.**

**Recommendation: do not build option (c) for 1.0.0.** It is technically possible, but the browser
withholds two things the FDR treats as non-negotiable, and the goal it serves is already met:

1. **No backup copy (C7, §4.4).** Pages opened from disk cannot use the browser's private file system
   (OPFS). That is where the app keeps each project's backup copy and its drawing files. Chrome and
   Edge sometimes delete an origin's whole database after a crash (`docs/USER-DECISIONS.md` §D: 6 of
   300 hard kills in a stress test). From a launcher, the projects are rebuilt from the backup; from
   `file://` they would be lost, unless the user had linked the project to a file (row 98).
2. **No storage isolation (§4.1).** Every HTML file opened from disk in the same browser shares one
   storage area. Any other local HTML file (a downloaded report, an e-mail attachment saved to disk)
   could list and read every project the app has saved. From a launcher, the app's storage belongs
   to `http://localhost:8765` alone.
3. **Double-click launch already exists.** Option (b) ships `Start Plot Analysis Tool.cmd`, which
   starts the app with a double-click on Windows without installation or administrator rights.
   Option (c) would help only on PCs where Windows PowerShell cannot run at all. If that turns out
   to be the case on your target PCs, prefer a desktop wrapper (D-3 option d, backlog B-6) or a
   signed single-file local server over option (c).

## What was tested

`node scripts/spikes/single-file-probe.mjs` opens test pages from `file://` in a fresh browser
profile, under a strict Content-Security-Policy like the app's, and reports each feature the app
relies on. Results on 15 Oct 2026 (the Chromium of Playwright 1.56, Linux, headless):

| Feature the app relies on                               | From `file://`                               | Consequence                                                                                             |
| ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Module workers (how every worker of the app is started) | refused                                      | Workers would have to be rebuilt as classic scripts started from inline code (that works, see next row) |
| Classic workers from inline code, WebAssembly in them   | work, including a worker started by a worker | The DWG reader and PDF decoders could run if their WebAssembly were embedded and loaded from bytes      |
| Private file system (OPFS), in the page and in workers  | refused                                      | **No backup copy and no drawing-file store (C7)**; drawings would have to live in IndexedDB             |
| IndexedDB                                               | works, kept across a browser restart         | Projects and their journal would still autosave                                                         |
| Storage isolated from other local files                 | **not isolated**: another local file read it | **Privacy (§4.1)**                                                                                      |
| Web Locks (two tabs on one project, row 100)            | works                                        |                                                                                                         |
| File System Access (link a project to a file, row 98)   | allowed                                      | The only protection left against database loss, if every user links every project                       |
| Service worker (offline cache, install as an app)       | refused                                      | Not needed for a local file                                                                             |

Size and opening time, with every file of the current build (`dist/`, 24.7 MB: 10.8 MB of it the DWG
reader's WebAssembly) written into one page:

| Variant                                   | HTML size | Ready after (3 opens) | NFR-1: cold start ≤ 3 s                                      |
| ----------------------------------------- | --------- | --------------------- | ------------------------------------------------------------ |
| Files embedded as text and base64         | 30.1 MB   | 2.0–3.5 s             | over budget before the app itself starts (another 0.5–0.7 s) |
| All files gzip-compressed into one string | 11.4 MB   | 1.6–2.1 s             | 2.2–2.8 s with the app's start: at the limit on this machine |

The reference laptop is slower than the build container for this kind of work, so NFR-1 would need
lazy unpacking (for example the DWG reader only when a DWG is imported) and a measurement there.

## What option (c) would take, if chosen anyway

- A separate build that emits one HTML file: workers as classic scripts started from inline code,
  the DWG reader's and pdf.js's WebAssembly, fonts and character maps embedded and compressed, and
  a Content-Security-Policy that names the page's inline script by hash.
- Drawing files and the journal kept in IndexedDB only, and a prompt to link each project to a file
  (row 98) as soon as it is created, since nothing else would survive the database loss described
  above.
- A warning that other local HTML files can read the projects, which cannot be fixed from the page.
- Tests for all of the above from `file://` in Chrome and Edge, and NFR-1 measured on the reference
  laptop.

## Re-running it

On any machine with Node 22 and the project's dependencies:

```
npm run build
node scripts/spikes/single-file-probe.mjs                  # Playwright Chromium
node scripts/spikes/single-file-probe.mjs --channel=msedge # the installed Edge
```

Running it with Edge on one of the target PCs would confirm the results under that PC's policies.
