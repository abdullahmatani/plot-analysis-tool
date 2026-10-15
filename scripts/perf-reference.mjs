#!/usr/bin/env node
/**
 * Performance run on the reference machine (FDR rows 17, 21, 82; docs/USER-DECISIONS.md U-2).
 *
 *   npm ci
 *   npx playwright install chromium        (or use the installed browser: --channel=msedge|chrome)
 *   npm run build
 *   npm run perf:reference [-- --channel=msedge]
 *
 * Works the same on Windows, macOS and Linux. Enforces the FDR budgets exactly (PAT_PERF_STRICT=1):
 * the browser suite (NFR-1, NFR-2, NFR-3, NFR-4, NFR-10) runs in a visible window so WebGL uses the
 * machine's GPU (headless browsers usually render in software), then the CPU timing tests (NFR-5,
 * NFR-6) run. Prints each measurement next to its budget. Keep the machine otherwise idle and plugged
 * in while it runs (a few minutes). Results: test-results/perf.json.
 *
 * NFR-7 (accuracy) does not depend on the machine and NFR-9 is verified by the fault-injection suite
 * in CI; both are covered by `npm test` and CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const channel = process.argv.find((a) => a.startsWith('--channel='))?.slice('--channel='.length);
if (!existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('dist/ not found: run `npm run build` first.');
  process.exit(2);
}
const env = {
  ...process.env,
  PAT_PERF_STRICT: '1',
  PAT_HEADED: '1',
  ...(channel ? { PAT_CHANNEL: channel } : {}),
};
const node = (args) => spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' }).status ?? 1;

console.log(`Browser suite (${channel ?? 'Playwright Chromium'}, visible window, FDR budgets enforced)…`);
const browserStatus = node([
  path.join(root, 'node_modules/@playwright/test/cli.js'),
  'test',
  '--project=perf',
]);
console.log('\nCPU timing tests (NFR-5, NFR-6)…');
const cpuStatus = node([
  path.join(root, 'node_modules/vitest/vitest.mjs'),
  'run',
  'src/geometry/offset.test.ts',
  'src/tables/contours.test.ts',
  'src/features/contours/compute.test.ts',
  '-t',
  'NFR|performance|within budget',
]);

const BUDGETS = [
  ['NFR-1', 'Offline cold start from cache', 'nfr1.seconds', '<=', 3, 's'],
  ['NFR-2', '20 MB DXF parsed and displayed', 'nfr2.seconds', '<=', 10, 's'],
  ['NFR-2', 'Longest main-thread block during that import', 'nfr2.maxMainThreadBlockMs', '<=', 100, 'ms'],
  ['NFR-3', '10 MB DWG parsed and displayed', 'nfr3.seconds', '<=', 15, 's'],
  ['NFR-4', 'Pan and zoom, 200 000 segments', 'nfr4.fps', '>=', 50, 'fps'],
  ['NFR-10', 'Longest autosave step while editing', 'nfr10.autosaveMaxSyncMs', '<=', 16, 'ms'],
  ['NFR-10', 'Reopen to an editable state', 'nfr10.reopenSeconds', '<=', 5, 's'],
];
let report = { environment: {}, results: {} };
try {
  report = JSON.parse(readFileSync(path.join(root, 'test-results', 'perf.json'), 'utf8'));
} catch {
  console.error('test-results/perf.json was not written.');
}
const { environment = {}, results = {} } = report;
console.log(`\nWebGL renderer: ${environment.renderer ?? 'unknown'}`);
if (environment.softwareRenderer)
  console.log(
    'WARNING: the browser rendered in software, so the GPU timings do not represent this machine. ' +
      'Check that hardware acceleration is on in the browser settings, or try --channel=msedge or --channel=chrome.',
  );
let missed = 0;
const rows = BUDGETS.map(([id, what, key, op, budget, unit]) => {
  const v = results[key];
  const ok = typeof v === 'number' && (op === '<=' ? v <= budget : v >= budget);
  if (!ok) missed++;
  const value = typeof v === 'number' ? `${v.toFixed(unit === 's' ? 2 : 1)} ${unit}` : 'not measured';
  return [ok ? 'PASS' : 'FAIL', id, what, value, `${op === '<=' ? '≤' : '≥'} ${budget} ${unit}`];
});
rows.push([
  cpuStatus === 0 ? 'PASS' : 'FAIL',
  'NFR-5/6',
  'Contour re-binding ≤ 100 ms; 1 000-vertex offset ≤ 50 ms',
  'see test output above',
  '',
]);
const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
for (const r of rows) console.log(r.map((cell, c) => cell.padEnd(widths[c])).join('  '));
const ok = browserStatus === 0 && cpuStatus === 0 && missed === 0 && !environment.softwareRenderer;
console.log(
  ok
    ? '\nAll budgets met on this machine. Keep test-results/perf.json with the release records (rows 17, 21, 82).'
    : '\nNot all budgets were met or measured on this machine; see above.',
);
process.exit(ok ? 0 : 1);
