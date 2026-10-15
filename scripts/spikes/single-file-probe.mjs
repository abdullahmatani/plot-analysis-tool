#!/usr/bin/env node
/**
 * Spike for FDR decision D-3, option (c): can the app run as one self-contained HTML file opened
 * from disk (file://)? See docs/SPIKE-D3-SINGLE-FILE.md for the results and the recommendation.
 *
 *   npm run build                                        (for the size and load-time check)
 *   node scripts/spikes/single-file-probe.mjs [--channel=msedge|chrome] [--headed]
 *
 * Opens small test pages from file:// in a fresh browser profile and reports which browser features
 * the app relies on work there: workers created from inline code, WebAssembly, IndexedDB across a
 * browser restart, the private file system (OPFS, which holds the backup copy, C7), Web Locks, the
 * File System Access API, and whether another local HTML file can read the app's storage. Then it
 * writes every file of dist/ into one HTML page (binary files base64-encoded) and times opening it.
 * Nothing is sent over the network; the test pages and profile go to a temporary folder.
 */
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const channel = process.argv.find((a) => a.startsWith('--channel='))?.slice('--channel='.length);
const headless = !process.argv.includes('--headed');
const work = mkdtempSync(path.join(tmpdir(), 'pat-file-probe-'));
const profile = path.join(work, 'profile');
const launch = () => chromium.launchPersistentContext(profile, { headless, ...(channel ? { channel } : {}) });

/** A page with the app's kind of policy: only its own inline script (by hash), blob workers, WebAssembly. */
function page(file, script, { csp = true, module = true } = {}) {
  const hash = createHash('sha256').update(script).digest('base64');
  const meta = csp
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'wasm-unsafe-eval' 'sha256-${hash}'; worker-src blob:; connect-src 'none'">`
    : '';
  const f = path.join(work, file);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(
    f,
    `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body><button id="b">b</button><script${module ? ' type="module"' : ''}>${script}</script></body></html>`,
  );
  return `file://${f}`;
}

const workerBody = `self.onmessage = async () => {
  const r = {};
  try { await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); r.wasm = 'ok'; } catch (e) { r.wasm = 'ERR ' + e.message; }
  try { await navigator.storage.getDirectory(); r.opfs = 'ok'; } catch (e) { r.opfs = 'ERR ' + e.message; }
  try {
    const inner = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
    r.nested = await new Promise((res) => { inner.onmessage = () => res('ok'); inner.onerror = () => res('ERR error event'); setTimeout(() => res('timeout'), 3000); });
  } catch (e) { r.nested = 'ERR ' + e.message; }
  postMessage(r);
};`;
const probe = `
const out = {};
const step = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'ERR ' + (e && e.message || e); } };
for (const type of ['classic', 'module'])
  await step(type + 'Worker', () => new Promise((res) => {
    const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerBody)}], { type: 'text/javascript' })), { type });
    w.onmessage = (m) => res(m.data); w.onerror = () => res('ERR error event'); w.postMessage(0); setTimeout(() => res('timeout'), 8000);
  }));
await step('indexedDB', async () => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('probe', 1); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const before = await new Promise((res) => { const g = db.transaction('s').objectStore('s').get('k'); g.onsuccess = () => res(g.result); });
  await new Promise((res) => { const t = db.transaction('s', 'readwrite'); t.objectStore('s').put('kept', 'k'); t.oncomplete = res; });
  return before === 'kept' ? 'kept after restart' : 'written';
});
await step('opfs', async () => { await navigator.storage.getDirectory(); return 'ok'; });
await step('webLocks', () => navigator.locks.request('probe', () => 'ok'));
await step('serviceWorker', () => navigator.serviceWorker.register('./sw.js').then(() => 'ok'));
document.getElementById('b').onclick = async () => {
  try { await showSaveFilePicker({ suggestedName: 'probe.patproj' }); out.fileSystemAccess = 'ok'; }
  catch (e) { out.fileSystemAccess = e.name === 'AbortError' ? 'allowed (picker dismissed)' : 'ERR ' + e.name + ': ' + e.message; }
};
window.__probe = out;`;

const results = [];
const row = (feature, value, needed) => {
  const v = String(value);
  results.push({ feature, value: v.length > 64 ? `${v.slice(0, 61)}...` : v, needed });
};

const ctx1 = await launch();
for (let run = 0; run < 2; run++) {
  const p = run === 0 ? (ctx1.pages()[0] ?? (await ctx1.newPage())) : await (await launch()).newPage();
  await p.goto(page('app/probe.html', probe));
  await p.waitForFunction(() => window.__probe && 'serviceWorker' in window.__probe, null, {
    timeout: 30_000,
  });
  if (run === 0) {
    await p.click('#b');
    await p
      .waitForFunction(() => 'fileSystemAccess' in window.__probe, null, { timeout: 10_000 })
      .catch(() => {});
    const r = await p.evaluate(() => window.__probe);
    const w = (k) => (typeof r[k] === 'object' ? r[k] : { error: r[k] });
    row(
      'Module worker from inline code (how the app starts its workers)',
      w('moduleWorker').error ?? 'ok',
      'yes',
    );
    row('Classic worker from inline code', w('classicWorker').error ?? 'ok', 'alternative');
    row('  … WebAssembly in it (DWG reader, PDF decoders)', w('classicWorker').wasm ?? '-', 'yes');
    row('  … worker started from a worker (DWG reader)', w('classicWorker').nested ?? '-', 'yes');
    row('Private file system, OPFS (backup copy, drawing files; C7)', r.opfs, 'yes');
    row('  … in a worker', w('classicWorker').opfs ?? '-', 'yes');
    row('Web Locks (multi-tab protection, row 100)', r.webLocks, 'yes');
    row('File System Access (link a project to a file, row 98)', r.fileSystemAccess ?? 'not reached', 'yes');
    row('Service worker (installable app)', r.serviceWorker, 'no');
    await ctx1.close();
  } else {
    row(
      'IndexedDB, kept across a browser restart',
      (await p.evaluate(() => window.__probe)).indexedDB,
      'yes',
    );
    // Another local HTML file, in another folder, opened in the same browser.
    await p.goto(
      page(
        'elsewhere/other.html',
        `const q = indexedDB.open('probe'); q.onsuccess = () => { const g = q.result.transaction('s').objectStore('s').get('k'); g.onsuccess = () => (window.__other = g.result ?? 'nothing'); }; q.onerror = () => (window.__other = 'ERR');`,
      ),
    );
    await p.waitForFunction(() => window.__other !== undefined, null, { timeout: 10_000 }).catch(() => {});
    const other = await p.evaluate(() => window.__other);
    row(
      'Storage isolated from other local HTML files (§4.1)',
      other === 'kept' ? 'NO: another file read it' : 'isolated',
      'yes',
    );
    await p.context().close();
  }
}

// Size and opening time of everything in dist/ inlined into one page (an upper bound without compression).
const dist = path.join(root, 'dist');
if (existsSync(path.join(dist, 'index.html'))) {
  const text = [];
  const bins = [];
  const all = [];
  let raw = 0;
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const b = readFileSync(p);
        raw += b.length;
        all.push(b);
        // "</script>" inside a file would end the page's script element.
        if (/\.(js|mjs|css|json|webmanifest|html|svg)$/.test(n))
          text.push(JSON.stringify(b.toString('utf8')).replaceAll('</', '<\\/'));
        else bins.push(JSON.stringify(b.toString('base64')));
      }
    }
  };
  walk(dist);
  const big = page(
    'single/app.html',
    `const t0 = performance.now(); const text = [${text.join(',')}]; const bins = [${bins.join(',')}]; let n = 0; for (const b of bins) n += atob(b).length; window.__t = { decode: performance.now() - t0, files: text.length + bins.length };`,
    { csp: false, module: false },
  );
  // The same files gzip-compressed into one base64 string, unpacked in the page (DecompressionStream).
  const packed = gzipSync(Buffer.concat(all), { level: 9 }).toString('base64');
  const small = page(
    'single/app-gzip.html',
    `const t0 = performance.now(); const z = Uint8Array.from(atob(${JSON.stringify(packed)}), (c) => c.charCodeAt(0)); new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer().then((b) => (window.__t = { unpack: performance.now() - t0, bytes: b.byteLength }));`,
    { csp: false, module: false },
  );
  const ctx = await launch();
  for (const [label, url] of [
    ['as one page', big],
    ['gzip-compressed in one page', small],
  ]) {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const p = await ctx.newPage();
      const t = Date.now();
      await p.goto(url, { waitUntil: 'load', timeout: 120_000 });
      await p.waitForFunction(() => window.__t, null, { timeout: 120_000 });
      times.push(Date.now() - t);
      await p.close();
    }
    const size = statSync(fileURLToPath(url)).size;
    row(
      `dist/ ${label}: ${(raw / 1e6).toFixed(1)} MB → ${(size / 1e6).toFixed(1)} MB of HTML`,
      `ready after ${times.join(' / ')} ms`,
      'NFR-1 ≤ 3 s',
    );
  }
  await ctx.close();
} else row('dist/ as one page', 'skipped: run `npm run build` first', '');

const widths = [0, 1, 2].map((c) => Math.max(...results.map((r) => Object.values(r)[c].length)));
console.log(
  `Browser: ${channel ?? 'Playwright Chromium'}${headless ? ' (headless)' : ''}, pages opened from file://\n`,
);
for (const r of [{ feature: 'Feature', value: 'Result', needed: 'Needed' }, ...results])
  console.log(
    Object.values(r)
      .map((v, c) => v.padEnd(widths[c]))
      .join('  '),
  );
rmSync(work, { recursive: true, force: true });
