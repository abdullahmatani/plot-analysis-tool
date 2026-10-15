#!/usr/bin/env node
/**
 * Generates src/generated/licences.json at build time (row 25): every production dependency in the
 * lockfile with its version, licence and licence text, plus bundled third-party assets that are not
 * npm dependencies of the app itself (pdf.js decoders and fonts, Noto fonts).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function licenceText(dir) {
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying|notice)(\.|-|_|$)/i.test(n));
  return f ? readFileSync(path.join(dir, f), 'utf8').slice(0, 40000) : undefined;
}

export function productionPackages(lock) {
  const out = [];
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (!key) continue; // root
    // Shipped code only: skip dev-only packages and optional native Node binaries never bundled for the browser.
    if (meta.dev || meta.devOptional || meta.optional) continue;
    const name = meta.name ?? key.replace(/^.*node_modules\//, '');
    out.push({ key, name, version: meta.version, license: meta.license });
  }
  return out;
}

export function generate() {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const pkgs = productionPackages(lock).map((p) => {
    const dir = path.join(root, p.key);
    let license = p.license;
    if (!license && existsSync(path.join(dir, 'package.json'))) {
      const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      license =
        typeof pj.license === 'string'
          ? pj.license
          : (pj.license?.type ?? pj.licenses?.map((l) => l.type).join(' OR '));
    }
    const libredwg = p.name.startsWith('@mlightcad/libredwg');
    const scope = libredwg
      ? 'DWG import worker only (separate bundle); WebAssembly rebuilt from the same release without run-time code generation (vendor/libredwg-web)'
      : undefined;
    const text =
      licenceText(dir) ?? (libredwg ? readMaybe(path.join(root, 'vendor/libredwg-web/COPYING')) : undefined);
    return { name: p.name, version: p.version, license: license ?? 'UNKNOWN', scope, text };
  });
  const pdfjs = path.join(root, 'node_modules/pdfjs-dist');
  const assets = [
    {
      name: 'Noto Sans (font)',
      version: '2.x',
      license: 'OFL-1.1',
      scope: 'Bundled font (UI/export/CAD fallback)',
      text:
        licenceText(path.join(root, 'node_modules/@expo-google-fonts/noto-sans')) ??
        readMaybe(path.join(root, 'node_modules/@expo-google-fonts/noto-sans/LICENSE_FONT')),
    },
    {
      name: 'Noto Sans Arabic (font)',
      version: '2.x',
      license: 'OFL-1.1',
      scope: 'Bundled font (Arabic text)',
      text: readMaybe(path.join(root, 'node_modules/@expo-google-fonts/noto-sans-arabic/LICENSE_FONT')),
    },
    {
      name: 'pdf.js standard fonts (Foxit)',
      version: 'pdfjs-dist',
      license: 'BSD-3-Clause',
      scope: 'Bundled with pdf.js',
      text: readMaybe(path.join(pdfjs, 'standard_fonts/LICENSE_FOXIT')),
    },
    {
      name: 'pdf.js standard fonts (Liberation)',
      version: 'pdfjs-dist',
      license: 'OFL-1.1',
      scope: 'Bundled with pdf.js',
      text: readMaybe(path.join(pdfjs, 'standard_fonts/LICENSE_LIBERATION')),
    },
    {
      name: 'OpenJPEG (pdf.js decoder)',
      version: 'pdfjs-dist',
      license: 'BSD-2-Clause',
      scope: 'Bundled with pdf.js',
      text: readMaybe(path.join(pdfjs, 'wasm/LICENSE_OPENJPEG')),
    },
    {
      name: 'QCMS (pdf.js colour management)',
      version: 'pdfjs-dist',
      license: 'MIT',
      scope: 'Bundled with pdf.js',
      text: readMaybe(path.join(pdfjs, 'wasm/LICENSE_QCMS')),
    },
    {
      name: 'DWG reader runtime (Emscripten, libc++, musl, mimalloc, zlib)',
      version: 'Emscripten 6.0.12, zlib 1.3.2',
      license: 'MIT AND Apache-2.0 WITH LLVM-exception AND Zlib',
      scope: 'Linked into the DWG reader WebAssembly (DWG import worker only)',
      text: readMaybe(path.join(root, 'vendor/libredwg-web/THIRD-PARTY-NOTICES.txt')),
    },
    {
      name: 'JBIG2 decoder (pdf.js)',
      version: 'pdfjs-dist',
      license: 'Apache-2.0',
      scope: 'Bundled with pdf.js',
      text: readMaybe(path.join(pdfjs, 'wasm/LICENSE_JBIG2')),
    },
  ];
  const packages = [...pkgs, ...assets].sort((a, b) => a.name.localeCompare(b.name));
  const out = { generatedAt: new Date().toISOString(), packages };
  mkdirSync(path.join(root, 'src/generated'), { recursive: true });
  writeFileSync(path.join(root, 'src/generated/licences.json'), JSON.stringify(out));
  return out;
}

function readMaybe(f) {
  return existsSync(f) ? readFileSync(f, 'utf8') : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = generate();
  const unknown = out.packages.filter((p) => p.license === 'UNKNOWN');
  console.log(
    `licences: ${out.packages.length} components${unknown.length ? `, ${unknown.length} with unknown licence: ${unknown.map((p) => p.name).join(', ')}` : ''}`,
  );
}
