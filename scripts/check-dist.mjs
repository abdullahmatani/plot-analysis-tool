#!/usr/bin/env node
/**
 * Row 2 / C3 check: the static build must not reference any external URL that could be loaded.
 * Every absolute http(s) URL in dist/ is listed; URLs are allowed only when they are inert
 * identifiers (XML namespaces, licence/notice text, library error-documentation strings) that are
 * never fetched. Anything else fails the build. (Runtime egress is additionally blocked by CSP and
 * verified by the zero-egress E2E test, row 7.)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, process.argv[2] ?? 'dist');

const INERT = [
  /^https?:\/\/www\.w3\.org\//, // XML/SVG/XHTML namespaces
  /^http:\/\/ns\.adobe\.com\//,
  /^http:\/\/purl\.org\//,
  /^http:\/\/schemas\.openxmlformats\.org\//,
  /^http:\/\/schemas\.microsoft\.com\//,
  /^http:\/\/www\.inkscape\.org\/namespaces\//,
  /^http:\/\/inkscape\.sourceforge\.net\//,
  /^http:\/\/sodipodi\.sourceforge\.net\//,
  /^http:\/\/creativecommons\.org\/ns/,
  /^https:\/\/react\.dev\/errors\//, // React production error message links (text only)
  /^https:\/\/reactjs\.org\/docs\/error-decoder/,
  /^https:\/\/github\.com\/mozilla\/pdf\.js/, // pdf.js messages
  /^https?:\/\/(www\.)?(apache\.org|opensource\.org|gnu\.org|fsf\.org|scripts\.sil\.org|openfontlicense\.org)\//, // licence text
  /^https:\/\/github\.com\/notofonts\//,
  /^https:\/\/fonts\.google\.com\/noto/,
  /^https:\/\/tailwindcss\.com/, // CSS banner comment
  /^https:\/\/radix-ui\.com/, // dev warnings text
  /^https:\/\/(www\.)?npmjs\.com/,
  /^https:\/\/zod\.dev/,
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/(issues|blob|tree)[^\s]*)?$/, // project links in comments/messages
  // Error-message documentation links inside library strings (never fetched):
  /^https:\/\/bit\.ly\/3cXEKWf$/, // Immer
  /^https:\/\/tinyurl\.com\/y2uuvskb$/, // Dexie
  /^http:\/\/bit\.ly\/2kdckMn$/, // Dexie
  /^https:\/\/bit\.ly\/wb-precache$/, // Workbox
  /^https:\/\/github\.com\/ashtuchkin\/iconv-lite\/wiki\//, // iconv-lite (via fontkit) warning text
  /^http:\/\/www\.xfa\.org\/schema\//, // XFA XML namespaces (pdf.js)
  // pdf.js URL helpers: dummy bases for `new URL(x, base)` parsing and a template literal, never fetched.
  /^https:\/\/foo\.bar$/,
  /^http:\/\/example\.com$/,
  /^http:\/\/\$\{\w+\}$/,
  // core-js URL feature-detection probes in the legacy pdf.js build (parsed, never fetched).
  /^https:\/\/(a|x|a@b|a#б|тест|a\/c%20d\?a=1&c=3)$/,
];

/** Chunks that contain third-party licence/notice texts (displayed, never fetched). */
const NOTICE_FILES = [/(^|\/)licences-[\w-]+\.js$/, /(^|\/)fonts\/OFL\.txt$/, /LICENSE/i];

const TEXT_EXT = /\.(html|js|mjs|css|json|svg|webmanifest|txt|map|xml)$/i;
const URL_RE = /https?:\/\/[^\s"'`)<>\\]+/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const problems = [];
const inert = new Map();
for (const file of walk(dist)) {
  if (!TEXT_EXT.test(file)) continue;
  if (NOTICE_FILES.some((re) => re.test(path.relative(dist, file)))) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;]+$/, '');
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) continue;
    if (INERT.some((re) => re.test(url))) {
      inert.set(url, (inert.get(url) ?? 0) + 1);
      continue;
    }
    problems.push(`${path.relative(dist, file)}: ${url}`);
  }
  // Explicitly loadable references must never be absolute.
  if (/\.(html|css)$/.test(file)) {
    const loadable =
      /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\/|@import\s+(?:url\()?["']?\s*(?:https?:)?\/\//gi;
    for (const m of text.matchAll(loadable))
      problems.push(`${path.relative(dist, file)}: loadable external reference "${m[0]}"`);
  }
}

if (problems.length) {
  console.error(
    `check-dist: ${problems.length} external URL reference(s) found:\n  ${[...new Set(problems)].join('\n  ')}`,
  );
  process.exit(1);
}
console.log(
  `check-dist: OK — no external URLs that could be loaded (${inert.size} inert identifier/notice URLs ignored).`,
);
