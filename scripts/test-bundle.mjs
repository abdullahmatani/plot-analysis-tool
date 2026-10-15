#!/usr/bin/env node
/**
 * Row 8 acceptance (automated part): unzip the offline bundle into a temp folder, start each
 * available launcher (Node, Python 3, PowerShell 7 if installed), and verify with a headless browser
 * that the app loads with its CSP sent as a header, works, installs its service worker, and keeps
 * working with the network disconnected, including DWG import - with zero requests to any other host.
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { writeFileSync, mkdirSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zipName = readdirSync(path.join(root, 'dist-bundle')).find((f) => f.endsWith('-offline.zip'));
if (!zipName) throw new Error('No bundle found - run `npm run bundle` first.');
const dir = mkdtempSync(path.join(tmpdir(), 'pat-bundle-'));
for (const [name, data] of Object.entries(
  unzipSync(new Uint8Array(readFileSync(path.join(root, 'dist-bundle', zipName)))),
)) {
  const p = path.join(dir, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, data);
}
const bundleDir = path.join(dir, readdirSync(dir)[0]);

const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const launchers = [
  { name: 'node', cmd: 'node', args: ['serve.mjs', '--no-browser', '--port'] },
  ...(has('python3')
    ? [{ name: 'python', cmd: 'python3', args: ['serve.py', '--no-browser', '--port'] }]
    : []),
  ...(has('pwsh')
    ? [{ name: 'powershell', cmd: 'pwsh', args: ['-NoProfile', '-File', 'serve.ps1', '-NoBrowser', '-Port'] }]
    : []),
];

let failures = 0;
let port = 8790;
for (const l of launchers) {
  port++;
  const proc = spawn(l.cmd, [...l.args, String(port)], { cwd: bundleDir, stdio: 'pipe' });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  const url = `http://localhost:${port}/`;
  const browser = await chromium.launch();
  try {
    // PowerShell can take more than 10 s to start on a busy CI runner (it printed nothing in that time
    // in CI run 33); the test checks that each launcher works, not how fast it starts.
    let up = false;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && !up;) {
      try {
        up = (await fetch(url)).ok;
      } catch {
        /* not up yet */
      }
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new Error(`the launcher did not start. Its output:\n${output}`);
    // The launchers send the policy as a header, which also governs the workers (decision U-1).
    const cspHeader = (await fetch(url)).headers.get('content-security-policy') ?? '';
    const context = await browser.newContext();
    const egress = [];
    context.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(url) && !u.startsWith('data:') && !u.startsWith('blob:')) egress.push(u);
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForSelector('[data-ready="true"]', { timeout: 20000 });
    const csp = await page.evaluate(() =>
      document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    );
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForSelector('[data-ready="true"]');
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('[data-ready="true"]', { timeout: 20000 });
    await page.getByTestId('new-project').click();
    await page.getByTestId('create-project').click();
    await page.waitForSelector('[data-testid="workspace"]', { timeout: 20000 });
    await page.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 20000 });
    // Still offline: a DWG imports under the launcher's CSP header (rows 8, 22).
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Control+i');
    await (await chooser).setFiles(path.join(root, 'tests/fixtures/dwg/example_2018.dwg'));
    await page.waitForFunction(
      () => ['ready', 'error'].includes(window.__pat.models()[0]?.status),
      undefined,
      { timeout: 60000 },
    );
    const dwg = await page.evaluate(() => window.__pat.models()[0]);
    const dwgOk = dwg.status === 'ready' && dwg.segments > 1000;
    const ok = egress.length === 0 && errors.length === 0 && !!csp && cspHeader === csp && dwgOk;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${l.name}: loaded, CSP header sent, service worker active, works offline, DWG imported${dwgOk ? '' : ` (DWG: ${dwg.status}${dwg.error ? ` ${dwg.error}` : ''})`}${cspHeader === csp ? '' : '; CSP header differs from the page policy'}${egress.length ? `; egress: ${egress.join(', ')}` : ''}${errors.length ? `; errors: ${errors.join('; ')}` : ''}`,
    );
    if (!ok) failures++;
  } catch (e) {
    console.log(`FAIL ${l.name}: ${e.message}`);
    failures++;
  } finally {
    await browser.close();
    proc.kill();
  }
}
if (!launchers.some((l) => l.name === 'powershell'))
  console.log(
    'SKIP powershell: pwsh not installed (tested in CI on ubuntu-latest, which ships PowerShell 7).',
  );
process.exit(failures ? 1 : 0);
