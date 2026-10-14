# Decisions and checks that need you

Items found while building the tool that only you can decide or verify. Each one names the
FDR rows it affects and what happens until it is resolved. (This file is updated as work
continues; the final list is summarised in the release notes.)

## U-1 — DWG reader vs. the Content-Security-Policy (rows 22, 23, 88; D-1)

**What happens now.** The DWG reader (LibreDWG, GPL-3.0, isolated in its own worker) uses
JavaScript generated at run time (`new Function`, emitted by Emscripten's embind). When the page is
served **with the CSP as an HTTP header** — the offline bundle's launchers and `vite preview` do
this — the browser applies the policy to workers too and blocks it. DWG import then stops with a
clear message telling the user to export DXF or PDF (tested in `e2e/dwg.spec.ts`). Where the
CSP is only in the page's `<meta>` tag (static hosting without headers, the dev server), DWG import
works: the reference DWGs match AutoCAD's own DXF export entity for entity (1517/1519 and
1556/1558; the differences are fit splines).

**Options.**

1. **Rebuild libredwg-web with `-sDYNAMIC_EXECUTION=0`** (recommended). Emscripten then emits
   glue without `new Function`, and the strict CSP stays unchanged everywhere. This needs the
   Emscripten SDK and the libredwg-web sources from GitHub. GitHub was unreachable from the build
   environment, so it could not be done here.
2. **Relax the CSP for the DWG worker only.** Serve `assets/libredwg.worker-*.js` with a policy
   that adds `'unsafe-eval'`. A worker's CSP comes from its own response, so the page keeps its strict
   policy and `connect-src 'self'` still prevents any egress from the worker. This weakens
   row 88's "no eval" for that one worker.
3. **Patch the generated glue** to use Emscripten's non-eval code paths (equivalent to option 1
   without recompiling). A working patch was written and then removed, because an automated safety
   check flagged it as working around a security control. It needs your explicit approval.
4. **Accept** that DWG import is unavailable in the offline bundle, and use DXF/PDF.

Also relevant to D-1: obtain licensing advice on distributing the GPL-3.0 component (the FDR
recommends this before commercial distribution).
