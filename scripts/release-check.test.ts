import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain ESM script without type declarations
import { changelogSection, check, fdrVersion, registerRows } from './release-check.mjs';

/** Row 89: the release check that runs before a version is tagged and published. */

const root = path.resolve(__dirname, '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
const fdr = read('plot-analysis-tool-FDR.md');
const changelog = read('CHANGELOG.md');
const version = JSON.parse(read('package.json')).version as string;

const row = (n: number, status: string, name = `Feature ${n}`) =>
  `| ${n} | ${name} | Text. | 1.0.0 | ${status} |`;
const register = (statuses: Record<number, string>) =>
  Array.from({ length: 89 }, (_, i) => row(i + 1, statuses[i + 1] ?? 'Complete')).join('\n');
const doc = (v: string, statuses: Record<number, string> = {}) =>
  `| Current product version | **${v}** |\n\n${register(statuses)}\n`;
const log = (v: string) =>
  `# Changelog\n\n## Product version ${v} — 1 Dec 2026\n\nNotes for ${v}.\n\n## Product version 0.9.0 — 1 Nov 2026\n\nOlder.\n`;

describe('release check (row 89)', () => {
  it('reads the real FDR, changelog and package version consistently', () => {
    // Every row once (rows 90–102 sit with the data-safety rows, before row 13).
    const rows = registerRows(fdr);
    const numbers = rows.map((r: { row: number }) => r.row).sort((a: number, b: number) => a - b);
    expect(numbers).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
    expect(rows.length).toBeGreaterThanOrEqual(102);
    expect(fdrVersion(fdr)).toBe(version);
    expect(changelogSection(changelog, version)).toMatch(
      new RegExp(`^## Product version ${version.replace(/\./g, '\\.')} `),
    );
    // The current pre-release passes and lists what is still open.
    const r = check({ version, tag: `v${version}`, fdr, changelog });
    expect(r.problems).toEqual([]);
    expect(r.prerelease).toBe(true);
    expect(r.notes.join()).toMatch(/row 88 \(Security and privacy review\)/);
  });

  it('refuses 1.0.0 while any other row is Incomplete, and allows it when only row 89 is', () => {
    const blocked = check({
      version: '1.0.0',
      tag: 'v1.0.0',
      fdr: doc('1.0.0', { 17: 'Incomplete', 89: 'Incomplete' }),
      changelog: log('1.0.0'),
    });
    expect(blocked.problems).toEqual([
      'Version 1.0.0 needs every register row Complete (FDR §0 rule 4); Incomplete: row 17 (Feature 17).',
    ]);
    const ready = check({
      version: '1.0.0',
      tag: 'v1.0.0',
      fdr: doc('1.0.0', { 89: 'Incomplete' }),
      changelog: log('1.0.0'),
    });
    expect(ready).toEqual({ problems: [], notes: [], prerelease: false });
  });

  it('ignores struck-through (dropped) rows', () => {
    const fdrText = doc('1.0.0').replace(
      row(40, 'Complete'),
      '| 40 | ~~Dropped~~ | ~~Out of scope.~~ | 1.0.0 | Incomplete |',
    );
    expect(check({ version: '1.0.0', fdr: fdrText, changelog: log('1.0.0') }).problems).toEqual([]);
  });

  it('refuses a tag, FDR version or changelog that does not match', () => {
    const r = check({ version: '1.0.0', tag: 'v1.0.1', fdr: doc('0.9.0'), changelog: log('0.9.9') });
    expect(r.problems).toEqual([
      'Tag v1.0.1 does not match package.json version 1.0.0 (expected v1.0.0).',
      `The FDR's "Current product version" is 0.9.0, not 1.0.0.`,
      'CHANGELOG.md has no "## Product version 1.0.0" section.',
    ]);
  });

  it('takes the release notes from the version’s changelog section only', () => {
    expect(changelogSection(log('1.0.0'), '1.0.0')).toBe(
      '## Product version 1.0.0 — 1 Dec 2026\n\nNotes for 1.0.0.',
    );
    expect(changelogSection(log('1.0.0'), '1.0')).toBeNull();
    expect(changelogSection(log('1.0.10'), '1.0.1')).toBeNull();
  });
});
