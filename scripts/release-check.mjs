#!/usr/bin/env node
/**
 * Release check (FDR row 89, docs/RELEASE-CHECKLIST.md). Run before tagging, and by the release
 * workflow on a `v*` tag before anything is published:
 *
 *   npm run release:check [-- --tag v1.0.0] [-- --notes release-notes.md]
 *
 * Checks that package.json, the FDR's "Current product version" and the tag agree; that CHANGELOG.md
 * has a section for the version; and, for 1.0.0 and later, that every FDR register row other than
 * row 89 (the release itself) is Complete (FDR §0 rule 4). Earlier versions are pre-releases: their
 * Incomplete rows are listed, not refused. `--notes` writes the version's changelog section, which
 * the workflow uses as the release notes. Exits 1 and lists every problem found.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_ROW = 89;

/** Register rows of the FDR (§8): `| n | name | description | version | status |`. */
export function registerRows(fdr) {
  const rows = [];
  for (const line of fdr.split('\n')) {
    const m = /^\| *(\d+) *\| *([^|]+?) *\|.*\| *(Complete|Incomplete) *\| *$/.exec(line);
    if (m)
      rows.push({
        row: Number(m[1]),
        name: m[2].replace(/~~/g, ''),
        status: m[3],
        struck: line.includes('~~'),
      });
  }
  return rows;
}

/** The FDR's "Current product version". */
export function fdrVersion(fdr) {
  return /\| *Current product version *\| *\**([0-9][^*| ]*)\**/.exec(fdr)?.[1] ?? null;
}

/** The changelog section of `version` ("## Product version x.y.z — date" up to the next "## "), or null. */
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(`^## Product version ${version.replace(/\./g, '\\.')}( |$)`).test(l),
  );
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

const isPre = (v) => /^0\./.test(v) || v.includes('-');

/** All problems that block releasing `version` (from package.json) under `tag`; empty when ready. */
export function check({ version, tag, fdr, changelog }) {
  const problems = [];
  const notes = [];
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    problems.push(`package.json version "${version}" is not SemVer.`);
  if (tag !== undefined && tag !== `v${version}`)
    problems.push(`Tag ${tag} does not match package.json version ${version} (expected v${version}).`);
  const fv = fdrVersion(fdr);
  if (fv !== version)
    problems.push(`The FDR's "Current product version" is ${fv ?? 'missing'}, not ${version}.`);
  if (!changelogSection(changelog, version))
    problems.push(`CHANGELOG.md has no "## Product version ${version}" section.`);
  const rows = registerRows(fdr);
  if (rows.length < RELEASE_ROW)
    problems.push(`The FDR register lists ${rows.length} rows; expected at least ${RELEASE_ROW}.`);
  const open = rows.filter((r) => r.status === 'Incomplete' && r.row !== RELEASE_ROW && !r.struck);
  const list = open.map((r) => `row ${r.row} (${r.name})`).join(', ');
  if (open.length && !isPre(version))
    problems.push(
      `Version ${version} needs every register row Complete (FDR §0 rule 4); Incomplete: ${list}.`,
    );
  else if (open.length) notes.push(`Pre-release: ${open.length} rows Incomplete: ${list}.`);
  return { problems, notes, prerelease: isPre(version) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0
      ? process.argv[i + 1]
      : process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  };
  const read = (f) => readFileSync(path.join(root, f), 'utf8');
  const version = JSON.parse(read('package.json')).version;
  const changelog = read('CHANGELOG.md');
  const r = check({ version, tag: arg('tag'), fdr: read('plot-analysis-tool-FDR.md'), changelog });
  for (const n of r.notes) console.log(n);
  const notesFile = arg('notes');
  if (notesFile && !r.problems.length)
    writeFileSync(path.resolve(notesFile), `${changelogSection(changelog, version)}\n`);
  if (r.problems.length) {
    console.error(`Not ready to release ${version}:\n${r.problems.map((p) => `- ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Ready to release ${version}${r.prerelease ? ' (pre-release)' : ''}.`);
}
