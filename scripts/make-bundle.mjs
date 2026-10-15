#!/usr/bin/env node
/**
 * Offline distribution bundle (row 8, decision D-3 options a+b): zips the static build with
 * loopback-only launchers for Windows (PowerShell), Python 3 and Node.js.
 * Run after `npm run build`.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/ not found - run `npm run build` first.');
  process.exit(1);
}
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
if (!csp) throw new Error('CSP meta tag missing from dist/index.html');

const name = `plot-analysis-tool-${pkg.version}`;
const outDir = path.join(root, 'dist-bundle', name);
rmSync(path.join(root, 'dist-bundle'), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
// `_headers` is for hosted mode (Cloudflare); the launchers send the same headers themselves.
cpSync(dist, path.join(outDir, 'app'), {
  recursive: true,
  filter: (f) => path.basename(f) !== '_headers',
});
const src = path.join(root, 'scripts/bundle');
for (const f of readdirSync(src)) {
  let text = readFileSync(path.join(src, f), 'utf8');
  // The CSP contains single quotes: in JavaScript it goes in as a JSON string literal; the Python
  // and PowerShell launchers hold it in double quotes.
  text = text
    .replaceAll("'__CSP__'", JSON.stringify(csp))
    .replaceAll('__CSP__', csp.replaceAll('"', "'"))
    .replaceAll('__VERSION__', pkg.version);
  if (f.endsWith('.txt') || f.endsWith('.cmd') || f.endsWith('.ps1')) text = text.replace(/\r?\n/g, '\r\n');
  writeFileSync(path.join(outDir, f), text);
  if (f.endsWith('.sh') || f.endsWith('.py') || f.endsWith('.mjs')) chmodSync(path.join(outDir, f), 0o755);
}
// A launcher that does not parse must fail the build, not the user.
const check = spawnSync(process.execPath, ['--check', path.join(outDir, 'serve.mjs')], { encoding: 'utf8' });
if (check.status !== 0) throw new Error(`serve.mjs does not parse:\n${check.stderr}`);

const files = {};
const walk = (dir) => {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else
      files[path.relative(path.dirname(outDir), p).split(path.sep).join('/')] = [
        readFileSync(p),
        { level: 6 },
      ];
  }
};
walk(outDir);
const zip = zipSync(files);
const zipPath = path.join(root, 'dist-bundle', `${name}-offline.zip`);
writeFileSync(zipPath, zip);
console.log(
  `bundle: ${path.relative(root, zipPath)} (${(zip.length / 1024 / 1024).toFixed(1)} MB, ${Object.keys(files).length} files)`,
);
